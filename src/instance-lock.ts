import { mkdir, realpath, readFile, writeFile, unlink, rename } from 'node:fs/promises';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { dirname, basename, resolve } from 'node:path';
import lockfile from 'proper-lockfile';

/** Raised when another live gateway holds the database lock. The CLI treats
 * this as a clean exit (code 0): under systemd Restart=on-failure a non-zero
 * exit restarts the unit every RestartSec forever while the owner stays up,
 * flooding the journal. */
export class InstanceLockHeldError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InstanceLockHeldError';
  }
}

export async function acquireInstanceLock(
  dbPath: string,
  onCompromised: (error: Error) => void,
): Promise<() => Promise<void>> {
  if (dbPath === ':memory:') throw new Error('A running gateway requires a persistent DB_PATH.');
  await mkdir(dirname(resolve(dbPath)), { recursive: true });
  const canonical = await realpath(dbPath).catch(() =>
    realpath(dirname(resolve(dbPath))).then((dir) => resolve(dir, basename(dbPath))),
  );
  const ownerPath = `${canonical}.owner.json`;
  try {
    const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as { pid: number; host: string };
    if (
      !Number.isInteger(owner.pid) ||
      owner.pid <= 0 ||
      typeof owner.host !== 'string' ||
      !owner.host
    )
      throw new Error('Cannot verify the existing gateway lock owner');
    // PIDs are only meaningful on the host that wrote the record. Foreign
    // owners must be arbitrated by the renewable lock below, not local PIDs.
    if (owner.host === hostname()) {
      let alive = true;
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code !== 'ESRCH';
      }
      if (alive)
        throw new InstanceLockHeldError(
          'Another gateway process still owns this database. Stop it before restarting.',
        );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (error instanceof SyntaxError)
        throw new Error(
          `Cannot read gateway lock ownership at ${ownerPath}. Check that the previous gateway has stopped before repairing this file.`,
          { cause: error },
        );
      throw error;
    }
  }
  try {
    const release = await lockfile.lock(canonical, {
      realpath: false,
      stale: 30_000,
      update: 5_000,
      retries: 0,
      onCompromised,
    });
    const token = randomUUID();
    const temporaryOwner = `${ownerPath}.${token}.tmp`;
    try {
      await writeFile(
        temporaryOwner,
        JSON.stringify({ pid: process.pid, host: hostname(), token }),
        {
          mode: 0o600,
        },
      );
      await rename(temporaryOwner, ownerPath);
    } catch (error) {
      await unlink(temporaryOwner).catch(() => {});
      await release();
      throw error;
    }
    return async () => {
      try {
        const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as { token?: string };
        if (owner.token === token) await unlink(ownerPath);
      } finally {
        await release();
      }
    };
  } catch (error) {
    // Deliberately a plain Error, NOT InstanceLockHeldError: this catch also
    // covers ELOCKED inside the 30s stale window after a crash — exactly when
    // systemd's Restart=on-failure fires (RestartSec=10). A clean exit there
    // would stop the retries and leave the gateway down indefinitely with a
    // green unit. Exiting non-zero lets systemd retry every RestartSec until
    // the lock goes stale (~3 attempts), then the gateway recovers alone.
    // It also covers EACCES/ENOSPC/EROFS on the lockdir: those are failures,
    // not "another owner".
    throw new Error(
      'Another gateway owns this database, or its lock has not expired yet. After a crash, wait 30 seconds before restarting.',
      { cause: error },
    );
  }
}
