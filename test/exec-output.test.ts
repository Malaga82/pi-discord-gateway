import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findExecutable, readCommandOutput } from '../src/cli/exec-output.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('readCommandOutput', () => {
  it('legacy shell-string form still works', () => {
    expect(readCommandOutput('echo shell-ok')).toBe('shell-ok');
  });

  it('argv form resolves a binary', () => {
    expect(readCommandOutput(process.execPath, ['--version'])).toMatch(/^v\d/);
  });

  it('argv form survives paths with spaces (shell form would split them)', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'exec-out-')), 'with space');
    mkdirSync(dir, { recursive: true });
    tempDirs.push(dir);
    const bin = join(dir, 'node');
    symlinkSync(process.execPath, bin);
    expect(readCommandOutput(bin, ['--version'])).toMatch(/^v\d/);
  });

  it('argv form merges stderr into the retry result', () => {
    const dir = mkdtempSync(join(tmpdir(), 'exec-out-'));
    tempDirs.push(dir);
    const script = join(dir, 'fail.cjs');
    writeFileSync(script, 'console.error("probe-err"); process.exit(1);');
    expect(readCommandOutput(process.execPath, [script])).toBe('probe-err');
  });
});

describe('findExecutable', () => {
  it('returns undefined for a missing binary — exit status decides, not stderr', () => {
    // A failed lookup prints localized diagnostics to stderr (Windows
    // "INFORMAZIONI: …", GNU which's message); none of that is a result.
    expect(findExecutable('definitely-not-a-binary-xyz')).toBeUndefined();
  });

  it('returns one existing path (first line only, no CR/LF)', () => {
    const found = findExecutable('node');
    expect(found).toBeTruthy();
    expect(found).not.toMatch(/[\r\n]/);
  });
});
