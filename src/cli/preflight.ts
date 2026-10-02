import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function assertSupportedPiVersion(version: string): void {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const major = match ? Number(match[1]) : NaN;
  const minor = match ? Number(match[2]) : NaN;
  if (!match || (major === 0 && minor < 83) || major >= 2) {
    throw new Error(`Unsupported pi version ${version}. Install pi >=0.83.0 <2.0.0.`);
  }
}

/** Read package metadata without importing pi or its native/runtime dependencies. */
export function checkPiDependencies(): void {
  for (const name of ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent']) {
    let directory: string;
    try {
      directory = dirname(fileURLToPath(import.meta.resolve(name)));
    } catch {
      throw new Error(`Required peer dependency ${name} is missing. Install pi >=0.83.0 <2.0.0.`);
    }
    let version: string | undefined;
    while (true) {
      try {
        const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
        if (manifest.name === name) {
          version = manifest.version;
          break;
        }
      } catch {
        /* Continue from dist/ to the published package root. */
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    if (!version) throw new Error(`Could not verify the installed ${name} version. Reinstall pi.`);
    assertSupportedPiVersion(version);
  }
}

/** Validate the executable actually used for discovery and tasks, independently of SDK peers. */
export async function checkPiExecutable(
  piBin: string,
  cwd: string,
  timeoutMs = 5000,
): Promise<string> {
  const { resolvePiSpawn } = await import('../agent/pi-spawn.js');
  const { runProcess } = await import('../agent/subprocess.js');
  const command = await resolvePiSpawn(piBin, ['--version']);
  const result = await runProcess(command.bin, command.args, {
    cwd,
    timeoutMs,
    env: (await import('../agent/pi-spawn.js')).sanitizedChildEnv(),
  });
  if (result.timedOut) throw new Error(`PI_BIN (${piBin}) --version timed out.`);
  if (result.code !== 0 || result.error || result.aborted)
    throw new Error(
      `Could not verify PI_BIN (${piBin}) --version: ${result.error || result.stderr.slice(0, 300) || 'command failed'}`,
    );
  const version = (result.stdout || result.stderr).trim();
  try {
    assertSupportedPiVersion(version);
  } catch (error) {
    throw new Error(`PI_BIN (${piBin}): ${(error as Error).message}`, { cause: error });
  }
  return version;
}
