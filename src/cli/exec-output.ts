import { execFileSync } from 'node:child_process';

interface SyncError extends Error {
  stdout?: string;
  stderr?: string;
}

/** Run a command, return its trimmed stdout, or undefined on any failure.
 * Retries with stderr merged: some probes (e.g. pi --version) print there.
 * Shared by the CLI helpers that probe the environment (pi/npm presence).
 *
 * Two forms:
 * - `readCommandOutput(cmd)` — legacy shell string (`'pi --version'`);
 * - `readCommandOutput(cmd, args)` — argv array, no shell: safe for values
 *   from operator config (PI_BIN) that may contain spaces. */
export function readCommandOutput(command: string, args?: string[]): string | undefined {
  if (args !== undefined) {
    try {
      return (
        execFileSync(command, args, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim() || undefined
      );
    } catch (error) {
      const err = error as SyncError;
      return `${err.stdout ?? ''}\n${err.stderr ?? ''}`.trim() || undefined;
    }
  }
  try {
    const stdout = execFileSync(command, {
      shell: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (stdout) return stdout;
  } catch {
    // retry below with stderr merged
  }
  try {
    return (
      execFileSync(`${command} 2>&1`, {
        shell: true,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

/** Locate an executable by name (or absolute path) via PATH lookup.
 * Decides on the exit status and keeps the FIRST line only: `where` prints
 * every shim (pi, pi.cmd, …) and localized diagnostics to stderr on
 * failure — neither the error text nor the extra lines are a result. Do not
 * route this through readCommandOutput: its failure fallback merges stderr,
 * which here is the error, not the answer. */
export function findExecutable(name: string): string | undefined {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(cmd, [name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.split(/\r?\n/)[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}
