import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { acquireInstanceLock, releaseInstanceLock } from '../src/single-instance.js';

const dir = mkdtempSync(join(tmpdir(), 'piscord-lock-'));
const lockPath = join(dir, 'gateway.db.lock');

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('instance lock', () => {
  it('acquires a free lock and records the pid', () => {
    acquireInstanceLock(lockPath);
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, 'utf8').trim()).toBe(String(process.pid));
    releaseInstanceLock(lockPath);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('refuses to boot while another live process holds the lock', () => {
    writeFileSync(lockPath, String(process.pid));
    expect(() => acquireInstanceLock(lockPath)).toThrow(/already running/);
    releaseInstanceLock(lockPath);
  });

  it('takes over a stale lock whose holder is dead', () => {
    // Deterministic dead pid: spawn a child that exits immediately.
    const { status } = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    expect(status).toBe(0);
    const dead = spawnSync(process.execPath, [
      '-e',
      'console.log(process.pid); setImmediate(() => process.exit(0));',
    ]);
    const deadPid = parseInt(dead.stdout.toString().trim(), 10);
    // The child is gone by now (spawnSync waited for it).
    expect(() => process.kill(deadPid, 0)).toThrow();

    writeFileSync(lockPath, String(deadPid));
    acquireInstanceLock(lockPath); // must take over, not throw
    expect(readFileSync(lockPath, 'utf8').trim()).toBe(String(process.pid));
    releaseInstanceLock(lockPath);
  });

  it('takes over a zero-byte lock left by a crash mid-acquire', () => {
    writeFileSync(lockPath, '');
    expect(() => acquireInstanceLock(lockPath)).not.toThrow();
    expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
    releaseInstanceLock(lockPath);
  });

  it('takes over a lock whose contents are not a pid', () => {
    writeFileSync(lockPath, 'garbage\n');
    expect(() => acquireInstanceLock(lockPath)).not.toThrow();
    expect(readFileSync(lockPath, 'utf8').trim()).toBe(String(process.pid));
    releaseInstanceLock(lockPath);
  });
});
