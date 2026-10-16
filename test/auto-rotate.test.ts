import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAllChannels: vi.fn<() => any[]>(() => []),
  channelsWithPending: vi.fn<() => string[]>(() => []),
  isChannelProcessing: vi.fn<() => boolean>(() => false),
  readTailLines: vi.fn<() => string[]>(() => []),
  fetchChannel: vi.fn(async () => undefined),
  resolveLatestChannelSessionFile: vi.fn<() => string | undefined>(() => undefined),
  rotateChannelSessionDir: vi.fn<() => string | undefined>(() => undefined),
  send: vi.fn(async () => undefined),
}));

vi.mock('../src/db.js', () => ({
  getAllChannels: mocks.getAllChannels,
  channelsWithPending: mocks.channelsWithPending,
}));
vi.mock('../src/agent/queue.js', () => ({ isChannelProcessing: mocks.isChannelProcessing }));
vi.mock('../src/agent/invoke.js', () => ({ readTailLines: mocks.readTailLines }));
vi.mock('../src/discord/client.js', () => ({ fetchChannel: mocks.fetchChannel }));
vi.mock('../src/session/path.js', () => ({
  resolveLatestChannelSessionFile: mocks.resolveLatestChannelSessionFile,
  rotateChannelSessionDir: mocks.rotateChannelSessionDir,
}));

// Real config singleton: the two auto-rotate knobs are plain fields mutated
// per-test before runAutoRotate() reads them.
import { config } from '../src/config.js';
import { estimateContextTokens, runAutoRotate } from '../src/session/auto-rotate.js';

const HOUR_MS = 60 * 60 * 1000;

function usageLine(input: number, cacheRead: number, cacheWrite = 0): string {
  return JSON.stringify({
    type: 'message',
    message: { role: 'assistant', usage: { input, cacheRead, cacheWrite } },
  });
}

function makeSessionFile(ageMs: number): string {
  const dir = mkdirSync(join(tmpdir(), `autorotate-${Date.now()}-${Math.random()}`), {
    recursive: true,
  });
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, '{}\n');
  const aged = new Date(Date.now() - ageMs);
  utimesSync(file, aged, aged);
  return file;
}

function registerChannel(overrides: Record<string, unknown> = {}): void {
  mocks.getAllChannels.mockReturnValue([
    { jid: 'dc:42', folder: 'ch_42', name: 'test', deletedAt: undefined, ...overrides },
  ]);
}

describe('estimateContextTokens', () => {
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
    config.autoRotateIdleHours = 12;
    config.autoRotateMinContextTokens = 100_000;
    mocks.fetchChannel.mockResolvedValue({ send: mocks.send } as any);
  });

  afterEach(() => {
    config.autoRotateIdleHours = 12;
  });

  it('rotates an idle, large-context session and posts a notice', async () => {
    registerChannel();
    const sessionFile = makeSessionFile(13 * HOUR_MS);
    mocks.resolveLatestChannelSessionFile.mockReturnValue(sessionFile);
    mocks.readTailLines.mockReturnValue([usageLine(500, 337_000)]);
    mocks.rotateChannelSessionDir.mockReturnValue('/sessions/ch_42__archived_X');

    await runAutoRotate();

    expect(mocks.rotateChannelSessionDir).toHaveBeenCalledWith('ch_42');
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const content = mocks.send.mock.calls[0][0].content as string;
    expect(content).toMatch(/auto-archived/);
    expect(content).toMatch(/338k tokens/);
    expect(content).toContain('ch_42__archived_X');
  });

  it('skips channels that are processing or have pending messages', async () => {
    registerChannel();
    const sessionFile = makeSessionFile(13 * HOUR_MS);
    mocks.resolveLatestChannelSessionFile.mockReturnValue(sessionFile);
    mocks.readTailLines.mockReturnValue([usageLine(500, 337_000)]);

    mocks.isChannelProcessing.mockReturnValue(true);
    await runAutoRotate();
    expect(mocks.rotateChannelSessionDir).not.toHaveBeenCalled();

    mocks.isChannelProcessing.mockReturnValue(false);
    mocks.channelsWithPending.mockReturnValue(['dc:42']);
    await runAutoRotate();
    expect(mocks.rotateChannelSessionDir).not.toHaveBeenCalled();
  });

  it('skips sessions below the context threshold', async () => {
    registerChannel();
    mocks.resolveLatestChannelSessionFile.mockReturnValue(makeSessionFile(13 * HOUR_MS));
    mocks.readTailLines.mockReturnValue([usageLine(500, 50_000)]);

    await runAutoRotate();

    expect(mocks.rotateChannelSessionDir).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('skips recently active sessions', async () => {
    registerChannel();
    mocks.resolveLatestChannelSessionFile.mockReturnValue(makeSessionFile(1 * HOUR_MS));
    mocks.readTailLines.mockReturnValue([usageLine(500, 337_000)]);

    await runAutoRotate();

    expect(mocks.rotateChannelSessionDir).not.toHaveBeenCalled();
  });

  it('skips channels without a session file or marked deleted', async () => {
    registerChannel();
    mocks.resolveLatestChannelSessionFile.mockReturnValue(undefined);
    await runAutoRotate();
    expect(mocks.rotateChannelSessionDir).not.toHaveBeenCalled();

    registerChannel({ deletedAt: '2026-10-16T00:00:00Z' });
    mocks.resolveLatestChannelSessionFile.mockReturnValue(makeSessionFile(13 * HOUR_MS));
    mocks.readTailLines.mockReturnValue([usageLine(500, 337_000)]);
    await runAutoRotate();
    expect(mocks.rotateChannelSessionDir).not.toHaveBeenCalled();
  });

  it('does nothing when disabled', async () => {
    config.autoRotateIdleHours = 0;
    registerChannel();
    mocks.resolveLatestChannelSessionFile.mockReturnValue(makeSessionFile(13 * HOUR_MS));
    mocks.readTailLines.mockReturnValue([usageLine(500, 337_000)]);

    await runAutoRotate();

    expect(mocks.getAllChannels).not.toHaveBeenCalled();
  });

  it('keeps rotating other channels when one check fails', async () => {
    mocks.getAllChannels.mockReturnValue([
      { jid: 'dc:1', folder: 'ch_1', deletedAt: undefined },
      { jid: 'dc:2', folder: 'ch_2', deletedAt: undefined },
    ]);
    mocks.resolveLatestChannelSessionFile.mockImplementation((folder: string) => {
      if (folder === 'ch_1') throw new Error('boom');
      return makeSessionFile(13 * HOUR_MS);
    });
    mocks.readTailLines.mockReturnValue([usageLine(500, 337_000)]);
    mocks.rotateChannelSessionDir.mockReturnValue('/sessions/ch_2__archived_X');

    await runAutoRotate();

    expect(mocks.rotateChannelSessionDir).toHaveBeenCalledWith('ch_2');
  });
});
