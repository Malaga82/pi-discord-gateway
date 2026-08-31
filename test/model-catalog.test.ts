import { SettingsManager } from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __setCachedModelRuntimeForTests,
  hasCachedModelCatalog,
  isModelCatalogStale,
  listAvailableModels,
  listSelectableModels,
  parsePiModelList,
} from '../src/agent/model-catalog.js';
import { config } from '../src/config.js';

const { spawnSyncMock, execFileMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
  execFileMock: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: spawnSyncMock,
  execFile: execFileMock,
}));

const models = [
  {
    provider: 'test',
    id: 'alpha',
    name: 'Alpha',
    reasoning: false,
  },
  {
    provider: 'test',
    id: 'beta',
    name: 'Beta',
    reasoning: true,
  },
  {
    provider: 'other',
    id: 'gamma',
    name: 'Gamma',
    reasoning: true,
  },
] as Model<any>[];

const defaultCliOutput = `provider  model  context  max-out  thinking  images
other    gamma  128K     16K      yes       no
test     alpha  128K     16K      no        no
test     beta   128K     16K      yes       no
`;

function mockPiCatalog(enabledModels?: string[], cliOutput = defaultCliOutput): void {
  const fakeRuntime = {
    getAvailableSnapshot: () => models,
    getModels: () => models,
  } as unknown as Parameters<typeof __setCachedModelRuntimeForTests>[0];

  __setCachedModelRuntimeForTests(fakeRuntime);
  spawnSyncMock.mockReturnValue({ status: 0, stdout: cliOutput, stderr: '' });
  vi.spyOn(SettingsManager, 'create').mockReturnValue(SettingsManager.inMemory({ enabledModels }));
}

afterEach(() => {
  __setCachedModelRuntimeForTests(null);
  vi.restoreAllMocks();
  spawnSyncMock.mockReset();
  execFileMock.mockReset();
});

describe('listSelectableModels', () => {
  it('returns every available model when enabledModels is not configured', async () => {
    mockPiCatalog();

    const result = await listSelectableModels({ forceRefresh: true, cwd: '/tmp/project' });

    expect(result.map((model) => model.ref)).toEqual(['other/gamma', 'test/alpha', 'test/beta']);
    expect(SettingsManager.create).toHaveBeenCalledWith('/tmp/project');
  });

  it('uses pi enabledModels semantics and preserves configured order', async () => {
    mockPiCatalog(['other/gamma', 'test/alpha']);

    const result = await listSelectableModels({ forceRefresh: true });

    expect(result.map((model) => model.ref)).toEqual(['other/gamma', 'test/alpha']);
  });

  it('supports the same glob patterns as pi scoped models', async () => {
    mockPiCatalog(['test/*']);

    const result = await listSelectableModels({ forceRefresh: true });

    expect(result.map((model) => model.ref)).toEqual(['test/alpha', 'test/beta']);
  });

  it('uses the configured pi binary as the authoritative model source', async () => {
    mockPiCatalog(
      ['test/delta'],
      `${defaultCliOutput}test     delta  256K     32K      yes       yes\n`,
    );

    const result = await listSelectableModels({ forceRefresh: true });

    expect(result.map((model) => model.ref)).toEqual(['test/delta']);
  });

  it('falls back to the SDK catalog when pi --list-models fails', async () => {
    mockPiCatalog(['test/beta']);
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '', stderr: 'failed' });

    const result = await listSelectableModels({ forceRefresh: true });

    expect(result.map((model) => model.ref)).toEqual(['test/beta']);
  });

  it('keeps a successful empty pi catalog empty instead of falling back', async () => {
    mockPiCatalog(undefined, 'provider  model  context  max-out  thinking  images\n');

    const result = await listSelectableModels({ forceRefresh: true });

    expect(result).toEqual([]);
  });

  it('falls back to the SDK catalog when pi --list-models errors out', async () => {
    mockPiCatalog(['test/beta']);
    spawnSyncMock.mockReturnValue({
      error: new Error('spawnSync pi ETIMEDOUT'),
      status: null,
      stdout: '',
      stderr: '',
    });

    const result = await listSelectableModels({ forceRefresh: true });

    expect(result.map((model) => model.ref)).toEqual(['test/beta']);
  });

  it('bounds the pi --list-models subprocess with a timeout', async () => {
    mockPiCatalog();

    await listSelectableModels({ forceRefresh: true });

    expect(spawnSyncMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it('passes PI_EXTRA_FLAGS to model discovery like the agent invocation', async () => {
    mockPiCatalog();
    const mutableConfig = config as { piExtraFlags: string };
    const previousFlags = mutableConfig.piExtraFlags;
    mutableConfig.piExtraFlags = '-e ./provider.ts --approve';

    try {
      await listSelectableModels({ forceRefresh: true });
    } finally {
      mutableConfig.piExtraFlags = previousFlags;
    }

    expect(spawnSyncMock).toHaveBeenCalledWith(
      expect.anything(),
      ['--list-models', '-e', './provider.ts', '--approve'],
      expect.anything(),
    );
  });
});

describe('isModelCatalogStale', () => {
  it('treats never-loaded catalogs as stale', () => {
    expect(isModelCatalogStale('/tmp/never-loaded')).toBe(true);
  });

  it('reports stale once the cache TTL elapses', async () => {
    vi.useFakeTimers();
    try {
      mockPiCatalog();
      await listSelectableModels({ forceRefresh: true, cwd: '/tmp/stale-check' });

      expect(isModelCatalogStale('/tmp/stale-check')).toBe(false);

      vi.advanceTimersByTime(31_000);
      expect(isModelCatalogStale('/tmp/stale-check')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('loadModelCatalog stale-while-revalidate', () => {
  it('serves the stale cache without a blocking spawn and refreshes in the background', async () => {
    mockPiCatalog();
    const cwd = '/tmp/swr-check';
    const first = listAvailableModels({ forceRefresh: true, cwd });
    expect(first.map((model) => model.ref)).toEqual(['other/gamma', 'test/alpha', 'test/beta']);

    const refreshedOutput =
      'provider  model  context  max-out  thinking  images\nother    gamma  128K     16K      yes       no\n';
    execFileMock.mockImplementation(
      (
        _bin: string,
        _args: string[],
        _opts: unknown,
        cb: (err: unknown, stdout: string) => void,
      ) => {
        cb(null, refreshedOutput);
      },
    );

    // Fake only Date.now so the cache reads as expired while timers stay real.
    const realNow = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(realNow + 31_000);
      spawnSyncMock.mockClear();

      const stale = listAvailableModels({ cwd });
      expect(stale.map((model) => model.ref)).toEqual(['other/gamma', 'test/alpha', 'test/beta']);
      expect(spawnSyncMock).not.toHaveBeenCalled();

      // Let the background execFile refresh settle.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(execFileMock).toHaveBeenCalled();
      expect(isModelCatalogStale(cwd)).toBe(false);
      const refreshed = listAvailableModels({ cwd });
      expect(refreshed.map((model) => model.ref)).toEqual(['other/gamma']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('loadModelCatalog first-load (hot path)', () => {
  it('serves an empty placeholder without a blocking sync spawn, then fills asynchronously', async () => {
    mockPiCatalog();
    const cwd = '/tmp/first-load-check';
    execFileMock.mockImplementation(
      (
        _bin: string,
        _args: string[],
        _opts: unknown,
        cb: (err: unknown, stdout: string) => void,
      ) => {
        cb(null, defaultCliOutput);
      },
    );
    spawnSyncMock.mockClear();

    const immediate = listAvailableModels({ cwd });
    expect(immediate).toEqual([]); // placeholder, no sync spawn
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(hasCachedModelCatalog(cwd)).toBe(false); // placeholder is NOT cached

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(execFileMock).toHaveBeenCalled();
    expect(hasCachedModelCatalog(cwd)).toBe(true); // real catalog cached by the async refresh
    const filled = listAvailableModels({ allowStale: true, cwd });
    expect(filled.map((model) => model.ref).sort()).toEqual([
      'other/gamma',
      'test/alpha',
      'test/beta',
    ]);
  });

  it('bumps loadedAt on a failed refresh so retries back off to one per TTL', async () => {
    mockPiCatalog();
    const cwd = '/tmp/backoff-check';
    listAvailableModels({ forceRefresh: true, cwd });

    execFileMock.mockImplementation(
      (
        _bin: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string) => void,
      ) => {
        cb(new Error('pi broken'), '');
      },
    );

    const realNow = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(realNow + 31_000);
      const stale = listAvailableModels({ cwd });
      expect(stale.map((model) => model.ref)).toEqual(['other/gamma', 'test/alpha', 'test/beta']);

      await new Promise((resolve) => setTimeout(resolve, 0));

      // Failed refresh kept the models but renewed loadedAt → no longer stale.
      expect(isModelCatalogStale(cwd)).toBe(false);
      expect(listAvailableModels({ cwd }).map((model) => model.ref)).toEqual([
        'other/gamma',
        'test/alpha',
        'test/beta',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('enabled-models patterns cache', () => {
  it('reads SettingsManager once per TTL for non-forced lookups', async () => {
    mockPiCatalog(['test/beta']);
    const cwd = '/tmp/patterns-cache';
    const createSpy = vi.spyOn(SettingsManager, 'create');

    await listSelectableModels({ forceRefresh: true, cwd });
    await listSelectableModels({ cwd });
    await listSelectableModels({ cwd });

    // One forced read (which refreshes the cache); the two non-forced calls hit the cache.
    expect(createSpy.mock.calls.filter((call) => call[0] === cwd)).toHaveLength(1);
  });
});

describe('parsePiModelList', () => {
  it('parses pi --list-models table output', () => {
    expect(parsePiModelList(defaultCliOutput)).toEqual([
      expect.objectContaining({ ref: 'other/gamma', reasoning: true }),
      expect.objectContaining({ ref: 'test/alpha', reasoning: false }),
      expect.objectContaining({ ref: 'test/beta', reasoning: true }),
    ]);
  });

  it('skips banner output written before the table header', () => {
    const output = `Loaded extension ./provider.ts\nwarning: model cache rebuilt\n${defaultCliOutput}`;

    expect(parsePiModelList(output)).toEqual([
      expect.objectContaining({ ref: 'other/gamma', reasoning: true }),
      expect.objectContaining({ ref: 'test/alpha', reasoning: false }),
      expect.objectContaining({ ref: 'test/beta', reasoning: true }),
    ]);
  });

  it('returns undefined when no table header is present (format change → SDK fallback)', () => {
    expect(parsePiModelList('no models available\n')).toBeUndefined();
  });

  it('returns an empty (authoritative) catalog for a valid header with zero rows', () => {
    expect(parsePiModelList('provider  model  context  max-out  thinking  images\n')).toEqual([]);
  });
});
