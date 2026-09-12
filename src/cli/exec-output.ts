import { execFileSync } from 'node:child_process';

/** Run a command, return its trimmed stdout, or undefined on any failure.
 * Retries with stderr merged: some probes (e.g. pi --version) print there.
 * Shared by the CLI helpers that probe the environment (pi/npm presence). */
export function readCommandOutput(command: string): string | undefined {
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
