import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPool } from '../src/util/run-pool.js';

const originalEnv = { ...process.env };
const tempDirs: string[] = [];
const CONFIG_ENV_KEYS = ['DB_PATH', 'SESSIONS_DIR', 'PI_CWD'];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();

  for (const key of CONFIG_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('runPool', () => {
  it('preserves input order regardless of completion order', async () => {
    const out = await runPool(
      [
        async () => {
          await new Promise((r) => setTimeout(r, 30));
          return 'slow-first';
        },
        async () => 'fast-second',
        async () => 'instant-third',
      ],
      3,
    );
    expect(out).toEqual(['slow-first', 'fast-second', 'instant-third']);
  });

  it('never exceeds the concurrency cap', async () => {
    let active = 0;
    let peak = 0;
    await runPool(
      Array.from({ length: 10 }, () => async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return true;
      }),
      3,
    );
    expect(peak).toBe(3);
  });
});

describe('downloadAttachments concurrency', () => {
  it('downloads in parallel, keeps message order, isolates failures', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pidg-media-'));
    tempDirs.push(tempDir);
    process.env.DB_PATH = ':memory:';
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
    process.env.PI_CWD = '/global/project';

    let active = 0;
    let peak = 0;
    const failingUrl = 'https://cdn.example/broken.png';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        if (url === failingUrl) {
          return { ok: false, status: 404 };
        }
        const chunk = new TextEncoder().encode('hello');
        return {
          ok: true,
          status: 200,
          body: new ReadableStream({
            start(c) {
              c.enqueue(chunk);
              c.close();
            },
          }),
        };
      }),
    );

    vi.resetModules();
    const media = await import('../src/session/media.js');

    const atts = [
      { url: 'https://cdn.example/a.txt', name: 'a.txt', contentType: 'text/plain', size: 5 },
      { url: failingUrl, name: 'broken.png', contentType: 'image/png', size: 5 },
      { url: 'https://cdn.example/b.txt', name: 'b.txt', contentType: 'text/plain', size: 5 },
      { url: 'https://cdn.example/c.txt', name: 'c.txt', contentType: 'text/plain', size: 5 },
      { url: 'https://cdn.example/d.txt', name: 'd.txt', contentType: 'text/plain', size: 5 },
    ];

    const files = await media.downloadAttachments(atts, 'ch_test', 'msg1');

    // Overlap happened (not serialized)…
    expect(peak).toBeGreaterThan(1);
    // …order preserved, failed one dropped.
    expect(files.map((f) => f.originalName)).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt']);
    for (const f of files) {
      expect(existsSync(f.filePath)).toBe(true);
      expect(f.size).toBe(5);
    }
  });
});
