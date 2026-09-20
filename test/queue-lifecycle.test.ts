import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ script: '', send: vi.fn(), find: vi.fn() }));
vi.mock('../src/agent/pi-spawn.js', () => ({
  resolvePiSpawn: async (_bin: string, args: string[]) => ({
    bin: process.execPath,
    args: [state.script, ...args],
  }),
  sanitizedChildEnv: () => ({ ...process.env }),
}));
vi.mock('../src/agent/model-catalog.js', async (original) => ({
  ...(await original<typeof import('../src/agent/model-catalog.js')>()),
  scheduleCatalogRefresh: () => {},
}));
vi.mock('../src/discord/client.js', () => ({
  setTyping: async () => {},
  sendResponse: async () => true,
  sendDurableResponse: async (id: number, signal: AbortSignal) => {
    const { deliverResponse } = await import('../src/discord/delivery.js');
    return deliverResponse(id, { send: state.send, find: state.find }, signal);
  },
}));
let directory: string;
let db: typeof import('../src/db.js');
let queue: typeof import('../src/agent/queue.js');
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'piscord-lifecycle-'));
  state.script = join(directory, 'fake-pi.cjs');
  writeFileSync(
    state.script,
    `
const fs = require('node:fs');
const prompt = process.argv.at(-1);
fs.appendFileSync('calls', prompt + '\\n');
if (prompt.includes('BLOCK')) {
  fs.writeFileSync('child-pid', String(process.pid));
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (prompt.includes('FENCE')) {
  console.log('FENCED-ANSWER' + '\\n' + '\\u0060\\u0060\\u0060js' + '\\n' + 'const x = 1;\\n'.repeat(700) + '\\u0060\\u0060\\u0060');
} else { console.log(prompt.includes('LONG') ? 'a'.repeat(4200) : 'answer'); }
`,
  );
  for (const [key, value] of Object.entries({
    DB_PATH: join(directory, 'gateway.db'),
    SESSIONS_DIR: join(directory, 'sessions'),
    PI_CWD: directory,
    POLL_INTERVAL_MS: '5',
    MAX_CONCURRENCY: '2',
    LOG_LEVEL: 'silent',
    AGENT_TIMEOUT_MS: '0',
    PI_MODEL: '',
    PI_THINKING: '',
    PI_EXTRA_FLAGS: '',
  }))
    vi.stubEnv(key, value);
  vi.resetModules();
  state.send.mockReset().mockResolvedValue('discord-id');
  state.find.mockReset().mockResolvedValue(undefined);
  db = await import('../src/db.js');
  db.initDb();
  queue = await import('../src/agent/queue.js');
  for (const jid of ['dc:a', 'dc:b'])
    db.registerChannel({
      jid,
      name: jid,
      folder: jid.slice(3),
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });
});
afterEach(async () => {
  await queue.stopProcessingLoop({ timeoutMs: 0 });
  db.closeDb();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
function enqueue(content: string, channelJid = 'dc:a') {
  return db.enqueueMessage({
    channelJid,
    content,
    sender: 'test',
    senderName: 'Test',
    timestamp: new Date().toISOString(),
  });
}
async function started() {
  await vi.waitFor(() =>
    expect(Number(readFileSync(join(directory, 'child-pid'), 'utf8'))).toBeGreaterThan(0),
  );
  return Number(readFileSync(join(directory, 'child-pid'), 'utf8'));
}
async function status(id: number, expected: string) {
  await vi.waitFor(() => expect(db.getQueuedMessage(id)?.status).toBe(expected), { timeout: 5000 });
}
async function dead(pid: number) {
  // SIGKILL escalation lands up to 5 s after the SIGTERM the child ignores.
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 9000 });
}
// The merge-wired queue: routing hooks in dispatch, tree-killed invocations,
// saveResponse + durable delivery. Kept as the lifecycle contract for the
// restart semantics documented in the README table.
describe('queue with real processes and durable SQLite', () => {
  it(
    'enforces the configured timeout on a real process that ignores termination',
    { timeout: 15000 },
    async () => {
      vi.stubEnv('AGENT_TIMEOUT_MS', '700');
      vi.resetModules();
      const { invokeAgent } = await import('../src/agent/invoke.js');
      const result = await invokeAgent('timeout', 'BLOCK');
      expect(result).toMatchObject({ ok: false, reason: 'timeout' });
      const pid = Number(readFileSync(join(directory, 'child-pid'), 'utf8'));
      await dead(pid);
    },
  );

  it(
    'cancels active and queued work without affecting another conversation',
    { timeout: 15000 },
    async () => {
      const active = enqueue('BLOCK');
      const pending = enqueue('SHOULD-NOT-RUN');
      const other = enqueue('OTHER', 'dc:b');
      queue.startProcessingLoop();
      const pid = await started();
      expect(queue.abortChannelTask('dc:a')).toEqual({ aborted: true, cleared: 1 });
      await status(other, 'done');
      await queue.stopProcessingLoop({ timeoutMs: 0 });
      await dead(pid);
      // The stopped task is dead for good: active row failed, queued rows cancelled.
      expect(db.getQueuedMessage(active)?.status).toBe('failed');
      expect(db.getQueuedMessage(pending)?.status).toBe('cancelled');
      expect(readFileSync(join(directory, 'calls'), 'utf8')).not.toContain('SHOULD-NOT-RUN');
    },
  );
  it(
    'parks interrupted execution at restart and runs only pending work',
    { timeout: 15000 },
    async () => {
      const active = enqueue('BLOCK');
      const pending = enqueue('NEXT');
      queue.startProcessingLoop();
      const pid = await started();
      await queue.stopProcessingLoop({ timeoutMs: 0 });
      // Aborted mid-turn: the row stays 'processing' for the next boot to park.
      expect(db.getQueuedMessage(active)?.status).toBe('processing');
      db.closeDb();
      db.initDb();
      queue.startProcessingLoop();
      expect(db.getQueuedMessage(active)?.status).toBe('interrupted');
      await status(pending, 'done');
      // The interrupted turn is reported, never rerun.
      expect(readFileSync(join(directory, 'calls'), 'utf8').match(/BLOCK/g)).toHaveLength(1);
      await dead(pid);
    },
  );
  it('persists long responses and resumes delivery without another invocation', async () => {
    const id = enqueue('LONG');
    state.send
      .mockResolvedValueOnce('first')
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValue('rest');
    queue.startProcessingLoop();
    await vi.waitFor(() => expect(db.getQueuedMessage(id)?.delivery_attempts).toBe(1));
    await queue.stopProcessingLoop({ timeoutMs: 0 });
    db.closeDb();
    db.initDb();
    db.retryDelivery(id, 0);
    queue.startProcessingLoop();
    await status(id, 'done');
    expect(state.send.mock.calls.map((call) => call[1].length)).toEqual([2000, 2000, 2000, 200]);
    expect(db.getResponseChunks(id).every((chunk) => chunk.status === 'sent')).toBe(true);
    expect(readFileSync(join(directory, 'calls'), 'utf8').match(/LONG/g)).toHaveLength(1);
  });
  it('splits long fenced answers into fence-balanced durable chunks', async () => {
    const id = enqueue('FENCE');
    state.send.mockReset().mockResolvedValue('discord-id');
    queue.startProcessingLoop();
    await status(id, 'done');
    const chunks = db.getResponseChunks(id).map((chunk) => chunk.content);
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk opens and closes its fences: no mid-block cut in Discord.
    for (const content of chunks) {
      const fences = content.match(/^```.*$/gm) ?? [];
      expect(fences.length % 2).toBe(0);
      expect(content.length).toBeLessThanOrEqual(2000);
    }
    // The reopened fences only ADD delimiters — the payload survives whole.
    expect(
      chunks
        .join('')
        .replace(/^```(js)?\n/gm, '')
        .replaceAll('\n```', ''),
    ).toContain('FENCED-ANSWER');
  });
  it('routes a thread-starter through its thread instead of the parent session', async () => {
    const { setThreadTransport } = await import('../src/discord/threads.js');
    const unknownChannel = Object.assign(new Error('Unknown Channel'), { code: 10003 });
    const created: string[] = [];
    setThreadTransport({
      get: async (id: string) => {
        if (id === 'a') return { id: 'a', name: 'parent', textParent: true, isThread: false };
        throw unknownChannel;
      },
      create: async (_parentId: string, anchorId: string, name: string) => {
        created.push(name);
        return { id: 't1', name, parentId: 'a', isThread: true, textParent: false };
      },
      sendAnchor: async () => 'anchor-1',
      findAnchor: async () => undefined,
    });

    const id = db.enqueueMessage({
      channelJid: 'dc:a',
      content: 'first line of the question\nbody',
      sender: 'test',
      senderName: 'Test',
      timestamp: new Date().toISOString(),
      routeThread: true,
      sourceMessageId: '999',
    });
    queue.startProcessingLoop();
    await status(id, 'done');

    // The thread was created and the answer ran in the THREAD's session folder.
    expect(created).toEqual(['first line of the question']);
    expect(db.getQueuedMessage(id)?.channel_jid).toBe('dc:t1');
    const threadChannel = db.getChannel('dc:t1')!;
    expect(threadChannel.parentJid).toBe('dc:a');
    // And the answer was delivered to the thread channel, not the parent.
    expect(state.send.mock.calls[0][0]).toBe('dc:t1');
  });
});
