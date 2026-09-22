import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let directory: string;
let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'piscord-status-'));
  vi.stubEnv('DB_PATH', ':memory:');
  vi.stubEnv('SESSIONS_DIR', join(directory, 'sessions'));
  vi.stubEnv('PI_BIN', 'definitely-not-a-binary-xyz');
  vi.stubEnv('LOG_LEVEL', 'silent');
  vi.resetModules();
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  log.mockRestore();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

function printed(): string {
  return log.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');
}

describe('piscord status', () => {
  it('prints "not found (<PI_BIN>)" when the binary does not exist', async () => {
    const { runStatus } = await import('../src/cli/status.js');
    runStatus();
    // The assert that three rounds of fixes let through: the not-found
    // branch must stay reachable, whatever the lookup prints on failure.
    expect(printed()).toMatch(/^Pi binary: not found \(definitely-not-a-binary-xyz\)$/m);
    expect(printed()).toMatch(/^Pi version: unknown$/m);
  });

  it('reports the resolved binary and version when it exists', async () => {
    vi.stubEnv('PI_BIN', 'node');
    vi.resetModules();
    const { runStatus } = await import('../src/cli/status.js');
    runStatus();
    expect(printed()).toMatch(/^Pi binary: .+$/m);
    expect(printed()).not.toMatch(/not found/);
    expect(printed()).toMatch(/^Pi version: v\d/m);
  });
});
