import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let directory: string;
let db: typeof import('../src/db.js');

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'piscord-notice-'));
  vi.stubEnv('DB_PATH', join(directory, 'gateway.db'));
  vi.stubEnv('LOG_LEVEL', 'silent');
  vi.resetModules();
  db = await import('../src/db.js');
  db.initDb();
});

afterEach(() => {
  db.closeDb();
  rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function enqueue(): number {
  return db.enqueueMessage({
    channelJid: 'dc:a',
    sender: 'user1',
    senderName: 'User One',
    content: 'hello',
    timestamp: new Date().toISOString(),
  });
}

describe('notice claim window (regression: duplicate notices under latency)', () => {
  it('a notice claimed in flight is not re-picked by pendingNotices', () => {
    const rowid = enqueue();
    db.setMessageState(rowid, 'interrupted', 'Interrupted: task aborted');
    expect(db.pendingNotices()).toHaveLength(1);
    // drainNotices claims the row (30s window) before sending: a send slower
    // than the poll interval must not be re-picked and delivered twice.
    db.postponeNotice(rowid, 30_000);
    expect(db.pendingNotices()).toHaveLength(0);
  });

  it('a failed send re-enters the pick list after the claim window', () => {
    vi.useFakeTimers();
    try {
      const rowid = enqueue();
      db.setMessageState(rowid, 'delivery_uncertain', 'delivery uncertain');
      db.postponeNotice(rowid, 30_000);
      expect(db.pendingNotices()).toHaveLength(0);
      vi.advanceTimersByTime(31_000);
      expect(db.pendingNotices()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
