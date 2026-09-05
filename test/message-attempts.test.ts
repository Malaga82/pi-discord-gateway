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

describe('message attempt budget', () => {
  it('counts invocations at claim and abandons rows over budget', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pidg-attempts-'));
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

    // Two full cycles: claim + "reboot" recovery. Attempts are preserved
    // across recoveries — that's the memory of the budget.
    for (let i = 1; i <= 2; i++) {
      const msg = db.claimNextMessage('dc:1');
      expect(msg?.attempts).toBe(i);
      expect(db.recoverStuckMessages(3).recovered).toBe(1); // still under budget
    }

    // Third claim reaches the budget: recovery abandons the row instead.
    expect(db.claimNextMessage('dc:1')?.attempts).toBe(3);
    const { recovered, abandoned } = db.recoverStuckMessages(3);
    expect(recovered).toBe(0);
    expect(abandoned).toBe(1);
    expect(db.claimNextMessage('dc:1')).toBeUndefined();

    // A fresh message with one attempt still gets a second life.
    db.enqueueMessage({
      channelJid: 'dc:1',
      sender: 'u_2',
      senderName: 'Bob',
      content: 'normal message',
      timestamp: new Date().toISOString(),
    });
    expect(db.claimNextMessage('dc:1')?.attempts).toBe(1);
    expect(db.recoverStuckMessages(3).recovered).toBe(1);
  });
});
