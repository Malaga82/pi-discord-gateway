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
          .prepare(
            "insert into message_log (channel_jid, role, content, timestamp) values ('dc:a','user','old',?)",
          )
          .run(old);
        raw
          .prepare(
            "insert into message_log (channel_jid, role, content) values ('dc:a','user','new')",
          )
          .run();

        const purged = await db.purgeOldMessages(30);
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
        expect(await db.purgeOldMessages(0)).toEqual({ queue: 0, log: 0 });
      } finally {
        raw.close();
      }
    } finally {
      db.closeDb();
    }
  });

  it('purges every terminal status and orphan-free chunks, keeps live rows', async () => {
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
      const raw = new Database(process.env.DB_PATH!);
      try {
        const oldRowids: number[] = [];
        const statuses = [
          'done',
          'failed',
          'interrupted',
          'cancelled',
          'delivery_failed',
          'delivery_uncertain',
        ];
        const insertOld = raw.prepare(
          "insert into message_queue (channel_jid, sender, sender_name, content, timestamp, status, processed_at) values ('dc:a','u','u',?,?,'done',?)",
        );
        for (const status of statuses) {
          const info = insertOld.run(status, old, old);
          oldRowids.push(Number(info.lastInsertRowid));
        }
        // The prepared insert pins status='done' (needed for FK-less chunk
        // setup); give each row its real terminal status now.
        raw
          .prepare(
            `update message_queue set status = case rowid ${statuses
              .map((s, i) => `when ${oldRowids[i]} then '${s}'`)
              .join(' ')} end where rowid in (${oldRowids.map(() => '?').join(',')})`,
          )
          .run(...oldRowids);

        // Chunks on an old row (parent purged) and on a fresh done row
        // (parent kept): only the orphaned side may disappear.
        const chunkInsert = raw.prepare(
          "insert into response_chunks (queue_id, part, content, nonce) values (?, 0, 'part', 'n')",
        );
        for (const parent of oldRowids) chunkInsert.run(parent);
        const fresh = raw
          .prepare(
            "insert into message_queue (channel_jid, sender, sender_name, content, timestamp, status, processed_at) values ('dc:a','u','u','fresh-done',datetime('now'),'done',datetime('now'))",
          )
          .run();
        chunkInsert.run(Number(fresh.lastInsertRowid));
        raw
          .prepare(
            "insert into message_queue (channel_jid, sender, sender_name, content, timestamp, status) values ('dc:a','u','u','pending-live',datetime('now'),'pending')",
          )
          .run();

        const purged = await db.purgeOldMessages(30);
        expect(purged.queue).toBe(oldRowids.length);

        const remaining = (
          raw.prepare('select content from message_queue').all() as Array<{ content: string }>
        ).map((r) => r.content);
        expect(remaining.sort()).toEqual(['fresh-done', 'pending-live']);

        const chunkParents = (
          raw.prepare('select queue_id from response_chunks').all() as Array<{ queue_id: number }>
        ).map((r) => Number(r.queue_id));
        expect(chunkParents).toEqual([Number(fresh.lastInsertRowid)]);
      } finally {
        raw.close();
      }
    } finally {
      db.closeDb();
    }
  });

  it('purges across a full batch plus a partial tail, chunks included', async () => {
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
      const raw = new Database(process.env.DB_PATH!);
      try {
        // PURGE_BATCH is 5000 (db.ts): 5000 + 37 forces one full batch and
        // one arbitrary-size partial tail — the shape that used to mint a
        // new prepared statement per run when the deletes varied arity.
        const insert = raw.prepare(
          "insert into message_queue (channel_jid, sender, sender_name, content, timestamp, status, processed_at) values ('dc:a','u','u','old',?,'done',?)",
        );
        const total = 5000 + 37;
        // One transaction for the bulk insert: 5037 autocommit runs are 5037
        // fsyncs, which on slow CI disks starves the parallel workers (two
        // tests timed out on a windows runner with this suite running).
        raw.exec('begin');
        try {
          for (let i = 0; i < total; i++) insert.run(old, old);
        } finally {
          raw.exec('commit');
        }
        const firstRowid = Number(
          (raw.prepare('select min(rowid) r from message_queue').get() as { r: number }).r,
        );
        const lastRowid = Number(
          (raw.prepare('select max(rowid) r from message_queue').get() as { r: number }).r,
        );
        const chunk = raw.prepare(
          "insert into response_chunks (queue_id, part, content, nonce) values (?, 0, 'part', 'n')",
        );
        chunk.run(firstRowid);
        chunk.run(lastRowid);

        const purged = await db.purgeOldMessages(30);
        expect(purged.queue).toBe(total);
        expect((raw.prepare('select count(*) c from message_queue').get() as { c: number }).c).toBe(
          0,
        );
        expect(
          (raw.prepare('select count(*) c from response_chunks').get() as { c: number }).c,
        ).toBe(0);
      } finally {
        raw.close();
      }
    } finally {
      db.closeDb();
    }
  });
});
