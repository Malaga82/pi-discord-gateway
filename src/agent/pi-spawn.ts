import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';

/**
 * Environment for pi child processes. The gateway's own secrets must never
 * leak into a subprocess that can run arbitrary shell commands: pi has `bash`,
 * so an inherited DISCORD_BOT_TOKEN would be exfiltratable by a simple `env`.
 */
export function sanitizedChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.DISCORD_BOT_TOKEN;
  return env;
}

// ponytail: resolution cache — `where` is only hit on Windows, once per piBin.
const shimCache = new Map<string, { bin: string; scriptArg: string | undefined }>();

/** Resolve npm .cmd shims on Windows so pi can be spawned without a shell. */
export function resolvePiSpawn(piBin: string, args: string[]): { bin: string; args: string[] } {
  if (process.platform !== 'win32') {
    return { bin: piBin, args };
  }

  let cached = shimCache.get(piBin);
  if (cached === undefined) {
    cached = resolveWindowsShim(piBin);
    shimCache.set(piBin, cached);
  }

  if (cached.scriptArg) {
    return { bin: process.execPath, args: [cached.scriptArg, ...args] };
  }
  return { bin: piBin, args };
}

function resolveWindowsShim(piBin: string): { bin: string; scriptArg: string | undefined } {
  try {
    // execFileSync (no shell): `where ${piBin}` would interpolate PI_BIN into
    // a shell command — operator-controlled, but free to harden.
    const shimPath = execFileSync('where', [piBin], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split(/\r?\n/)
      .find((line) => line.trim().endsWith('.cmd'));

    if (shimPath) {
      const content = readFileSync(shimPath.trim(), 'utf8');
      const jsMatch = content.match(/"([^"]+\.js)"/);
      if (jsMatch) {
        const jsPath = pathResolve(dirname(shimPath.trim()), jsMatch[1]);
        if (existsSync(jsPath)) {
          return { bin: process.execPath, scriptArg: jsPath };
        }
      }
    }
  } catch {
    // Fall through to the configured binary.
  }

  return { bin: piBin, scriptArg: undefined };
}
