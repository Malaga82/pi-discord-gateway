import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { invokeAgentMock, sendResponseMock, setTypingMock, fetchChannelMock } = vi.hoisted(() => ({
  invokeAgentMock: vi.fn(),
  sendResponseMock: vi.fn(),
  setTypingMock: vi.fn(),
  fetchChannelMock: vi.fn(),
}));

vi.mock('../src/agent/invoke.js', () => ({
  invokeAgent: invokeAgentMock,
}));

vi.mock('../src/discord/client.js', () => ({
  sendResponse: sendResponseMock,
  setTyping: setTypingMock,
  fetchChannel: fetchChannelMock,
}));

const originalEnv = { ...process.env };
const tempDirs: string[] = [];
const CONFIG_ENV_KEYS = [
  'DB_PATH',
  'MAX_CONCURRENCY',
  'PI_CWD',
  'POLL_INTERVAL_MS',
  'SESSIONS_DIR',
];

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();

  for (const key of CONFIG_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A turn killed by a gateway shutdown must stay recoverable: the queue row
 * stays 'processing' so recoverStuckMessages() at the next boot re-enqueues
 * it and the answer is regenerated and delivered without user action.
 */
describe('killed message recovery', () => {
  it('keeps a killed message in a state boot recovery can re-enqueue', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pidg-queue-killed-'));
    tempDirs.push(tempDir);

    process.env.DB_PATH = ':memory:';
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
    process.env.POLL_INTERVAL_MS = '1';
    process.env.MAX_CONCURRENCY = '1';
    process.env.PI_CWD = '/global/project';

    invokeAgentMock.mockResolvedValue({
      ok: false,
      text: '',
      error: 'Agent invocation aborted during shutdown',
      killed: true,
    });
    sendResponseMock.mockResolvedValue(true);
    setTypingMock.mockResolvedValue(undefined);

    vi.resetModules();
    const db = await import('../src/db.js');
    const queue = await import('../src/agent/queue.js');

    db.initDb();

    try {
      db.registerChannel({
        jid: 'dc:123',
        name: 'killed test',
        folder: 'ch_123',
        requiresTrigger: false,
        isMain: false,
        modelOverride: '',
        thinkingOverride: '',
        cwdOverride: '',
      });
      db.enqueueMessage({
        channelJid: 'dc:123',
        sender: 'u_1',
        senderName: 'Alice',
        content: 'hello',
        timestamp: new Date().toISOString(),
      });

      queue.startProcessingLoop();
      await vi.waitFor(
        () => {
          expect(invokeAgentMock).toHaveBeenCalledTimes(1);
        },
        { timeout: 2000, interval: 10 },
      );
      // Give the post-invoke branch a moment to settle (finalizeStream etc.).
      await vi.waitFor(
        () => {
          expect(queue.isChannelProcessing('dc:123')).toBe(false);
        },
        { timeout: 2000, interval: 10 },
      );

      // No answer was delivered (nothing to deliver), and the row must NOT
      // be 'failed': the next boot's recoverStuckMessages() has to pick it up.
      expect(sendResponseMock).not.toHaveBeenCalled();
      expect(db.recoverStuckMessages()).toBe(1);
    } finally {
      queue.stopProcessingLoop({ timeoutMs: 0 });
    }
  });

  it('/pi stop must kill the in-flight task permanently (no resurrection at next boot)', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pidg-queue-stop-'));
    tempDirs.push(tempDir);

    process.env.DB_PATH = ':memory:';
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
    process.env.POLL_INTERVAL_MS = '1';
    process.env.MAX_CONCURRENCY = '1';
    process.env.PI_CWD = '/global/project';

    // Invoke hangs until the test releases it, like a real long-running task.
    let release: (v: unknown) => void = () => {};
    invokeAgentMock.mockImplementation(
      () =>
        new Promise((res) => {
          release = res;
        }),
    );
    sendResponseMock.mockResolvedValue(true);
    setTypingMock.mockResolvedValue(undefined);

    vi.resetModules();
    const db = await import('../src/db.js');
    const queue = await import('../src/agent/queue.js');

    db.initDb();

    try {
      db.registerChannel({
        jid: 'dc:123',
        name: 'stop test',
        folder: 'ch_123',
        requiresTrigger: false,
        isMain: false,
        modelOverride: '',
        thinkingOverride: '',
        cwdOverride: '',
      });
      db.enqueueMessage({
        channelJid: 'dc:123',
        sender: 'u_1',
        senderName: 'Alice',
        content: 'task lungo',
        timestamp: new Date().toISOString(),
      });

      queue.startProcessingLoop();
      await vi.waitFor(
        () => {
          expect(invokeAgentMock).toHaveBeenCalledTimes(1);
        },
        { timeout: 2000, interval: 10 },
      );

      // User runs /pi stop.
      const res = queue.abortChannelTask('dc:123');
      expect(res.aborted).toBe(true);

      // Task finishes around the abort (race the real code also handles).
      release({ ok: true, text: 'late answer' });
      await vi.waitFor(
        () => {
          expect(queue.isChannelProcessing('dc:123')).toBe(false);
        },
        { timeout: 2000, interval: 10 },
      );

      // The stopped task must NOT come back at the next boot.
      expect(db.recoverStuckMessages()).toBe(0);
    } finally {
      queue.stopProcessingLoop({ timeoutMs: 0 });
    }
  });
});
