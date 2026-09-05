import { closeSync, fsyncSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
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
      // Persist the pid before treating the lock as valid: without fsync a
      // power loss / kernel crash can leave a zero-byte file that the stale
      // detection below would (pre-fix) misread as a live unknown holder.
      fsyncSync(lockFd);
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

    // An uninterpretable pid cannot come from an acquirer that finished its
    // write: treat it as stale (crash between openSync and writeSync, or
    // fsync window). Defaulting to alive would brick the gateway until a
    // human deletes the file.
    let alive = false;
    if (Number.isFinite(pid)) {
      alive = true;
      try {
        process.kill(pid, 0);
      } catch (err: any) {
        alive = err?.code !== 'ESRCH'; // ESRCH = no such process → dead
      }
    }

    if (alive) {
      throw new Error(
        `Another gateway instance is already running (pid ${Number.isFinite(pid) ? pid : 'unknown'}, lock: ${lockPath}). ` +
          `If that pid is stale or was reused by another process, remove the lock file and start again.`,
      );
    }
    logger.warn({ stalePid: pid, lockPath }, 'Removing stale instance lock');
    try {
      unlinkSync(lockPath);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err; // gone already: another starter won the race
    }
  }
  throw new Error(`Could not acquire instance lock: ${lockPath}`);
}

/** Drop the lock (idempotent). The file may outlive a crash; the pid check
 * handles that on the next boot. */
export function releaseInstanceLock(lockPath: string): void {
  if (lockFd === undefined) return; // never ours: don't unlink someone else's lock
  try {
    closeSync(lockFd);
  } catch {
    // already closed
  }
  lockFd = undefined;
  try {
    unlinkSync(lockPath);
  } catch {
    // already gone
  }
}
