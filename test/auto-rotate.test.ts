import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAllChannels: vi.fn<() => any[]>(() => []),
  channelsWithPending: vi.fn<() => string[]>(() => []),
  isChannelProcessing: vi.fn<() => boolean>(() => false),
  getChannelSessionStatus: vi.fn(async () => ({ statsSource: 'none' as const })),
  readTailLines: vi.fn<() => string[]>(() => []),
  fetchChannel: vi.fn(async () => undefined),
  resolveLatestChannelSessionFile: vi.fn<(folder: string) => string | undefined>(() => undefined),
  rotateChannelSessionDir: vi.fn<(folder: string) => string | undefined>(() => undefined),
  send: vi.fn<(payload: { content: string }) => Promise<undefined>>(async () => undefined),
}));

vi.mock('../src/db.js', () => ({
  getAllChannels: mocks.getAllChannels,
  channelsWithPending: mocks.channelsWithPending,
}));
vi.mock('../src/agent/queue.js', () => ({ isChannelProcessing: mocks.isChannelProcessing }));
vi.mock('../src/agent/invoke.js', () => ({
  getChannelSessionStatus: mocks.getChannelSessionStatus,
  readTailLines: mocks.readTailLines,
}));
vi.mock('../src/discord/client.js', () => ({ fetchChannel: mocks.fetchChannel }));
vi.mock('../src/session/path.js', () => ({
  resolveLatestChannelSessionFile: mocks.resolveLatestChannelSessionFile,
  rotateChannelSessionDir: mocks.rotateChannelSessionDir,
}));

// Real config singleton: the auto-rotate knobs are plain fields mutated
// per-test before runAutoRotate() reads them.
import { config } from '../src/config.js';
import { estimateContextTokens, runAutoRotate } from '../src/session/auto-rotate.js';

// config is a frozen `as const` singleton; tests need mutable knobs.
const knobs = config as unknown as {
  autoRotateIdleHours: number;
  autoRotateMinContextTokens: number;
};

const HOUR_MS = 60 * 60 * 1000;

function usageLine(input: number, cacheRead: number, cacheWrite = 0): string {
  return JSON.stringify({
    type: 'message',
    message: { role: 'assistant', usage: { input, cacheRead, cacheWrite } },
  });
}

function makeSessionFile(ageMs: number): string {
  const dir = join(tmpdir(), `autorotate-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, '{}\n');
  const aged = new Date(Date.now() - ageMs);
  utimesSync(file, aged, aged);
  return file;
}

function registerChannel(overrides: Record<string, unknown> = {}): void {
  mocks.getAllChannels.mockReturnValue([
    {
      jid: 'dc:42',
      folder: 'ch_42',
      name: 'test',
      deletedAt: undefined,
      cwdOverride: '',
      ...overrides,
    },
  ]);
}

function mockStats(contextUsage: { tokens: number | null; contextWindow: number | null }): void {
  mocks.getChannelSessionStatus.mockResolvedValue({
    statsSource: 'rpc',
    contextUsage,
  } as any);
}

describe('estimateContextTokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sums input + cacheRead + cacheWrite of the newest assistant usage', () => {
    mocks.readTailLines.mockReturnValue([
      usageLine(500, 40_000, 1_000),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'hi' } }),
      usageLine(1_000, 337_000, 0),
    ]);
    expect(estimateContextTokens('/s.jsonl')).toBe(338_000);
  });

  it('skips assistant entries without usage and malformed lines', () => {
    mocks.readTailLines.mockReturnValue([
      'not json',
      JSON.stringify({ type: 'message', message: { role: 'assistant', stopReason: 'error' } }),
      usageLine(10, 20),
    ]);
    expect(estimateContextTokens('/s.jsonl')).toBe(30);
  });

  it('returns 0 when no usage is found or the read fails', () => {
    mocks.readTailLines.mockReturnValue([]);
    expect(estimateContextTokens('/s.jsonl')).toBe(0);
    mocks.readTailLines.mockImplementation(() => {
      throw new Error('gone');
    });
    expect(estimateContextTokens('/s.jsonl')).toBe(0);
  });
});

describe('runAutoRotate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    knobs.autoRotateIdleHours = 12;
    knobs.autoRotateMinContextTokens = 100_000;
    mocks.channelsWithPending.mockReturnValue([]);
    mocks.isChannelProcessing.mockReturnValue(false);
    mocks.fetchChannel.mockResolvedValue({ send: mocks.send } as any);
  });

  afterEach(() => {
    knobs.autoRotateIdleHours = 12;
  });

  function armIdleChannel(): void {
    registerChannel();
    mocks.resolveLatestChannelSessionFile.mockReturnValue(makeSessionFile(13 * HOUR_MS));
    mocks.rotateChannelSessionDir.mockReturnValue('/sessions/ch_42__archived_X');
  }

  it('rotates at 25% of the model context window reported by session stats', async () => {
    armIdleChannel();
    // 491,520 * 0.25 = 122,880 threshold; 122,900 context qualifies.
    mockStats({ tokens: 122_900, contextWindow: 491_520 });

    await runAutoRotate();

    expect(mocks.getChannelSessionStatus).toHaveBeenCalledWith('ch_42', expect.any(String));
    expect(mocks.rotateChannelSessionDir).toHaveBeenCalledWith('ch_42');
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const content = mocks.send.mock.calls[0][0].content as string;
    expect(content).toMatch(/auto-archived/);
    expect(content).toMatch(/123k tokens/);
    expect(content).toContain('ch_42__archived_X');
  });

  it('skips when the context is below 25% of the window', async () => {
    armIdleChannel();
    mockStats({ tokens: 100_000, contextWindow: 491_520 });

    await runAutoRotate();

    expect(mocks.rotateChannelSessionDir).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('falls back to the static token floor when the window is unknown', async () => {
    armIdleChannel();
    mockStats({ tokens: 150_000, contextWindow: null });
    await runAutoRotate();
    expect(mocks.rotateChannelSessionDir).toHaveBeenCalledWith('ch_42');

    mocks.rotateChannelSessionDir.mockClear();
    mockStats({ tokens: 99_999, contextWindow: null });
    await runAutoRotate();
    expect(mocks.rotateChannelSessionDir).not.toHaveBeenCalled();
  });

  it('falls back to the JSONL estimate when session stats throw', async () => {
    armIdleChannel();
    mocks.getChannelSessionStatus.mockRejectedValue(new Error('rpc down'));
    mocks.readTailLines.mockReturnValue([usageLine(500, 337_000)]);

    await runAutoRotate();

    expect(mocks.rotateChannelSessionDir).toHaveBeenCalledWith('ch_42');

    mocks.rotateChannelSessionDir.mockClear();
    mocks.readTailLines.mockReturnValue([usageLine(500, 50_000)]);
    await runAutoRotate();
    expect(mocks.rotateChannelSessionDir).not.toHaveBeenCalled();
  });

  it('skips channels that are processing or have pending messages', async () => {
    armIdleChannel();
    mockStats({ tokens: 400_000, contextWindow: 491_520 });

    mocks.isChannelProcessing.mockReturnValue(true);
    await runAutoRotate();
    expect(mocks.rotateChannelSessionDir).not.toHaveBeenCalled();

    mocks.isChannelProcessing.mockReturnValue(false);
    mocks.channelsWithPending.mockReturnValue(['dc:42']);
    await runAutoRotate();
    expect(mocks.rotateChannelSessionDir).not.toHaveBeenCalled();
  });

  it('skips recently active sessions', async () => {
    registerChannel();
    mocks.resolveLatestChannelSessionFile.mockReturnValue(makeSessionFile(1 * HOUR_MS));
    mockStats({ tokens: 400_000, contextWindow: 491_520 });

    await runAutoRotate();

    expect(mocks.getChannelSessionStatus).not.toHaveBeenCalled();
    expect(mocks.rotateChannelSessionDir).not.toHaveBeenCalled();
  });

  it('skips channels without a session file or marked deleted', async () => {
    registerChannel();
    mocks.resolveLatestChannelSessionFile.mockReturnValue(undefined);
    await runAutoRotate();
    expect(mocks.rotateChannelSessionDir).not.toHaveBeenCalled();

    registerChannel({ deletedAt: '2026-10-16T00:00:00Z' });
    mocks.resolveLatestChannelSessionFile.mockReturnValue(makeSessionFile(13 * HOUR_MS));
    mockStats({ tokens: 400_000, contextWindow: 491_520 });
    await runAutoRotate();
    expect(mocks.rotateChannelSessionDir).not.toHaveBeenCalled();
  });

  it('uses the channel cwd override for session stats', async () => {
    registerChannel({ cwdOverride: '/srv/project' });
    mocks.resolveLatestChannelSessionFile.mockReturnValue(makeSessionFile(13 * HOUR_MS));
    mockStats({ tokens: 400_000, contextWindow: 491_520 });

    await runAutoRotate();

    expect(mocks.getChannelSessionStatus).toHaveBeenCalledWith('ch_42', '/srv/project');
  });

  it('does nothing when disabled', async () => {
    knobs.autoRotateIdleHours = 0;
    armIdleChannel();

    await runAutoRotate();

    expect(mocks.getAllChannels).not.toHaveBeenCalled();
  });

  it('keeps rotating other channels when one check fails', async () => {
    mocks.getAllChannels.mockReturnValue([
      { jid: 'dc:1', folder: 'ch_1', deletedAt: undefined, cwdOverride: '' },
      { jid: 'dc:2', folder: 'ch_2', deletedAt: undefined, cwdOverride: '' },
    ]);
    mocks.resolveLatestChannelSessionFile.mockImplementation((folder: string) => {
      if (folder === 'ch_1') throw new Error('boom');
      return makeSessionFile(13 * HOUR_MS);
    });
    mockStats({ tokens: 400_000, contextWindow: 491_520 });
    mocks.rotateChannelSessionDir.mockReturnValue('/sessions/archived_X');

    await runAutoRotate();

    expect(mocks.rotateChannelSessionDir).toHaveBeenCalledWith('ch_2');
  });
});
