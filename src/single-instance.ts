import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { logger } from './logger.js';

let lockFd: number | undefined;

/**
 * Refuse to boot a second gateway on the same data dir (two live instances
 * both drain the queue → duplicated replies). A stale lock whose holder died
 * without cleanup (SIGKILL, crash) is detected via the recorded pid and
 * taken over automatically.
 */
export function acquireInstanceLock(lockPath: string): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      lockFd = openSync(lockPath, 'wx');
      writeSync(lockFd, String(process.pid));
      return;
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
    }

    let pid = NaN;
    try {
      pid = parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
    } catch {
      // Unreadable lock file: treat as held by an unknown live process.
    }

    let alive = true;
    if (Number.isFinite(pid)) {
      try {
        process.kill(pid, 0);
      } catch (err: any) {
        alive = err?.code !== 'ESRCH'; // ESRCH = no such process → dead
      }
    }

    if (alive) {
      throw new Error(
        `Another gateway instance is already running (pid ${Number.isFinite(pid) ? pid : 'unknown'}, lock: ${lockPath}).`,
      );
    }
    logger.warn({ stalePid: pid, lockPath }, 'Removing stale instance lock');
    unlinkSync(lockPath);
  }
  throw new Error(`Could not acquire instance lock: ${lockPath}`);
}

/** Drop the lock (idempotent). The file may outlive a crash; the pid check
 * handles that on the next boot. */
export function releaseInstanceLock(lockPath: string): void {
  if (lockFd !== undefined) {
    try {
      closeSync(lockFd);
    } catch {
      // already closed
    }
    lockFd = undefined;
  }
  try {
    unlinkSync(lockPath);
  } catch {
    // already gone
  }
}
