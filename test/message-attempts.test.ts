import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };
const tempDirs: string[] = [];
const CONFIG_ENV_KEYS = ['DB_PATH', 'SESSIONS_DIR', 'PI_CWD'];

afterEach(() => {
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

describe('message attempt budget and restart recovery', () => {
  it('parks a mid-execution row as interrupted (reported, never rerun) and requeues routing rows', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pidg-attempts-'));
    tempDirs.push(tempDir);
    process.env.DB_PATH = ':memory:';
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
    process.env.PI_CWD = '/global/project';

    vi.resetModules();
    const db = await import('../src/db.js');
    db.initDb();

    const interrupted = db.enqueueMessage({
      channelJid: 'dc:1',
      sender: 'u_1',
      senderName: 'Alice',
      content: 'mid-turn crash',
      timestamp: new Date().toISOString(),
    });
    const routed = db.enqueueMessage({
      channelJid: 'dc:1',
      sender: 'u_1',
      senderName: 'Alice',
      content: 'crash while opening the thread',
      timestamp: new Date().toISOString(),
      routeThread: true,
    });

    // Simulate a crash: one row claimed into execution, one into routing.
    expect(db.claimNextMessage('dc:1')?.status).toBe('processing');
    expect(db.claimNextMessage('dc:1')?.status).toBe('routing');

    const result = db.recoverStuckMessages();
    // Execution started → interrupted with a notice carrying the task id.
    expect(result.interrupted).toBe(1);
    const parked = db.getQueuedMessage(interrupted)!;
    expect(parked.status).toBe('interrupted');
    expect(parked.notice_text).toContain(`Task #${interrupted}`);
    // Routing never invoked pi → safe replay: it is pending again.
    expect(db.getQueuedMessage(routed)?.status).toBe('pending');
    // Reported means not rerun: the parked row is no longer claimable — the
    // next claim is the routing row, re-claimed as a thread-starter.
    const reclained = db.claimNextMessage('dc:1');
    expect(reclained?.rowid).toBe(routed);
    expect(reclained?.status).toBe('routing');
  });

  it('abandons a processing row once its attempt budget is burned (crash-loop ceiling)', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pidg-attempts-budget-'));
    tempDirs.push(tempDir);
    process.env.DB_PATH = ':memory:';
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
    process.env.PI_CWD = '/global/project';

    vi.resetModules();
    const db = await import('../src/db.js');
    db.initDb();

    db.enqueueMessage({
      channelJid: 'dc:1',
      sender: 'u_1',
      senderName: 'Alice',
      content: 'oom bait',
      timestamp: new Date().toISOString(),
    });

    // The queue itself never replays an interrupted row, so reaching the
    // budget needs the row handed back (manual surgery / future replay).
    for (let i = 1; i <= 3; i++) {
      const claimed = db.claimNextMessage('dc:1');
      expect(claimed?.attempts).toBe(i);
      if (i < 3) db.setMessageState(claimed!.rowid, 'pending');
    }

    const { recovered, interrupted, abandoned } = db.recoverStuckMessages();
    expect(abandoned).toBe(1);
    expect(recovered).toBe(0);
    expect(interrupted).toBe(0);
    expect(db.claimNextMessage('dc:1')).toBeUndefined();
  });
});
