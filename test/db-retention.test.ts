import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalDbPath = process.env.DB_PATH;
const tempDirs: string[] = [];

afterEach(async () => {
  vi.resetModules();
  if (originalDbPath === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = originalDbPath;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('purgeOldMessages', () => {
  it('deletes done/failed queue rows and old log entries, keeps pending and recent', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pidg-retention-'));
    tempDirs.push(tempDir);
    process.env.DB_PATH = join(tempDir, 'gateway.db');

    vi.resetModules();
    const db = await import('../src/db.js');
    db.initDb();

    try {
      const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 19)
        .replace('T', ' ');
      // Second connection to the same file: insert rows with controlled ages.
      const raw = new Database(process.env.DB_PATH!);
      try {
      raw
        .prepare(
          "insert into message_queue (channel_jid, sender, sender_name, content, timestamp, status, processed_at) values ('dc:a','u','u','old-done',?,'done',?)",
        )
        .run(old, old);
      raw
        .prepare(
          "insert into message_queue (channel_jid, sender, sender_name, content, timestamp, status, processed_at) values ('dc:a','u','u','old-failed',?,'failed',?)",
        )
        .run(old, old);
      raw
        .prepare(
          "insert into message_queue (channel_jid, sender, sender_name, content, timestamp, status) values ('dc:a','u','u','pending-now',datetime('now'),'pending')",
        )
        .run();
      raw
        .prepare(
          "insert into message_queue (channel_jid, sender, sender_name, content, timestamp, status, processed_at) values ('dc:a','u','u','recent-done',datetime('now'),'done',datetime('now'))",
        )
        .run();
      raw
        .prepare("insert into message_log (channel_jid, role, content, timestamp) values ('dc:a','user','old',?)")
        .run(old);
      raw
        .prepare("insert into message_log (channel_jid, role, content) values ('dc:a','user','new')")
        .run();

      const purged = db.purgeOldMessages(30);
      expect(purged.queue).toBe(2);
      expect(purged.log).toBe(1);

      const remaining = raw
        .prepare('select content from message_queue order by rowid')
        .all() as Array<{ content: string }>;
      expect(remaining.map((r) => r.content).sort()).toEqual(['pending-now', 'recent-done']);

      const logRows = raw.prepare('select content from message_log').all() as Array<{
        content: string;
      }>;
      expect(logRows.map((r) => r.content)).toEqual(['new']);

      // Retention disabled: no-op.
      expect(db.purgeOldMessages(0)).toEqual({ queue: 0, log: 0 });
      } finally {
        raw.close();
      }
    } finally {
      db.closeDb();
    }
  });
});
