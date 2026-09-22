import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { findExecutable, readCommandOutput } from './exec-output.js';
import { config, resolveConfigPath } from '../config.js';
import { closeDb, getAllChannels, initDb } from '../db.js';

const AUTH_PATH = resolve(
  process.env.PI_CODING_AGENT_DIR || resolve(homedir(), '.pi/agent'),
  'auth.json',
);
const SERVICE_NAME = 'pi-discord-gateway';

export function runStatus(): void {
  const configPath = resolveConfigPath();
  // Honor the same resolution the gateway and setup use: a relocated auth
  // dir (PI_CODING_AGENT_DIR) or a custom binary (PI_BIN) must not make
  // status report 'missing'/'not found' on a healthy gateway. The fallback
  // stays OUT of the displayed value: 'not found (pi)' must stay reachable
  // when the lookup fails, otherwise status loses its main diagnostic.
  const piPath = findExecutable(config.piBin);
  // Version probe goes through the shell with a quoted path: npm installs on
  // Windows are .cmd shims, and spawning a batch file without a shell throws
  // EINVAL (Node's CVE-2024-27980 batch guard). piPath comes from where/which
  // output, not raw operator input, and the quotes keep spaces safe.
  const piVersion = piPath ? readCommandOutput(`"${piPath}" --version`) : undefined;
  const authStatus = existsSync(AUTH_PATH);
  const serviceStatus = getServiceStatus();
  const channelCount = getRegisteredChannelCount();
  const sessionsPath = resolve(config.sessionsDir);
  const sessionFolderCount = countSessionFolders(sessionsPath);

  const lines = [
    'piscord status',
    '',
    `Pi binary: ${piPath || `not found (${config.piBin})`}`,
    `Pi version: ${piVersion || 'unknown'}`,
    `Pi auth: ${authStatus ? `found (${AUTH_PATH})` : `missing (${AUTH_PATH})`}`,
    `Pi working dir: ${config.piCwd}`,
    `Config path: ${configPath}`,
    `Gateway service: ${serviceStatus}`,
    `Database: ${config.dbPath}`,
    `Registered channels: ${channelCount}`,
    `Sessions directory: ${config.sessionsDir}`,
    `Session folders: ${sessionFolderCount}`,
  ];

  console.log(lines.join('\n'));
}

function getServiceStatus(): string {
  if (process.platform === 'linux') return getLinuxServiceStatus();
  if (process.platform === 'darwin') return getMacServiceStatus();
  return 'unsupported platform';
}

function getLinuxServiceStatus(): string {
  const result = spawnSync('systemctl', ['--user', 'is-active', SERVICE_NAME], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    return `unavailable (${result.error.message})`;
  }

  const status = `${result.stdout || result.stderr || ''}`.trim();
  return status || `inactive (exit ${result.status ?? 'unknown'})`;
}

function getMacServiceStatus(): string {
  const uid = spawnSync('id', ['-u'], { encoding: 'utf8' }).stdout.trim();
  const result = spawnSync('launchctl', ['print', `gui/${uid}/com.${SERVICE_NAME}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    return 'not loaded';
  }

  const output = result.stdout;
  const state = output.match(/state\s*=\s*(\S+)/)?.[1] ?? 'unknown';
  const pid = output.match(/pid\s*=\s*(\d+)/)?.[1];
  return pid ? `running (pid ${pid}, ${state})` : `loaded (${state})`;
}

function getRegisteredChannelCount(): number {
  try {
    initDb();
    return getAllChannels().length;
  } finally {
    closeDb();
  }
}

function countSessionFolders(baseDir: string): number {
  if (!existsSync(baseDir)) {
    return 0;
  }

  let count = 0;
  const stack = [baseDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) {
      continue;
    }

    const entries = readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'media') {
        continue;
      }

      count += 1;
      stack.push(resolve(currentDir, entry.name));
    }
  }

  return count;
}
