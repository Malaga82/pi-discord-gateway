import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { purgeOldMessages } from '../db.js';
import { logger } from '../logger.js';

const ARCHIVE_TIMESTAMP_RE = /__archived_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ArchivedSession {
  path: string;
  name: string;
  archivedAt: Date;
}

export function parseArchiveTimestamp(dirName: string): Date | undefined {
  const match = ARCHIVE_TIMESTAMP_RE.exec(dirName);
  if (!match) return undefined;

  const [, y, mo, d, h, mi, s] = match;
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59 || +s > 59) return undefined;

  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
}

export async function listArchivedSessions(sessionsDir: string): Promise<ArchivedSession[]> {
  const results: ArchivedSession[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: sessionsDir, depth: 0 }];

  // Depth bound: archived dirs live at depth ≤ 3 (sessions/channel/archived);
  // 4 leaves headroom without ever walking the full session history.
  const MAX_WALK_DEPTH = 4;

  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = join(dir, entry.name);
      const archivedAt = parseArchiveTimestamp(entry.name);

      if (archivedAt) {
        results.push({ path: fullPath, name: entry.name, archivedAt });
      } else if (depth + 1 < MAX_WALK_DEPTH) {
        stack.push({ dir: fullPath, depth: depth + 1 });
      }
    }
  }

  return results.sort((a, b) => a.archivedAt.getTime() - b.archivedAt.getTime());
}

export async function cleanupArchivedSessions(
  sessionsDir: string,
  retentionDays: number,
  options: { dryRun?: boolean } = {},
): Promise<{ deleted: string[]; skipped: number }> {
  if (retentionDays === 0) {
    return { deleted: [], skipped: 0 };
  }

  const cutoff = Date.now() - retentionDays * DAY_MS;
  const deleted: string[] = [];
  let skipped = 0;

  for (const archived of await listArchivedSessions(sessionsDir)) {
    if (archived.archivedAt.getTime() > cutoff) {
      skipped += 1;
      continue;
    }

    if (options.dryRun) {
      deleted.push(archived.path);
      logger.info(
        { path: archived.path, archivedAt: archived.archivedAt.toISOString() },
        'Archived session cleanup dry run',
      );
      continue;
    }

    try {
      await rm(archived.path, { recursive: true, force: true });
      deleted.push(archived.path);
      logger.info(
        { path: archived.path, archivedAt: archived.archivedAt.toISOString() },
        'Deleted archived session',
      );
    } catch (err: any) {
      skipped += 1;
      logger.warn({ err: err.message, path: archived.path }, 'Failed to delete archived session');
    }
  }

  return { deleted, skipped };
}

export function startArchiveCleanup(): () => void {
  if (config.archiveRetentionDays === 0) {
    return () => {};
  }

  const runOnce = async () => {
    try {
      await cleanupArchivedSessions(config.sessionsDir, config.archiveRetentionDays);
      await purgeOldMessages(config.archiveRetentionDays);
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Archive cleanup error');
    }
  };

  // Run immediately: a gateway restarted daily would otherwise never reach
  // the 24h interval and queue/log rows would grow forever.
  void runOnce();
  const timer = setInterval(() => void runOnce(), CLEANUP_INTERVAL_MS);

  return () => clearInterval(timer);
}
