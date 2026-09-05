import { execFile, spawnSync } from 'node:child_process';
import { ModelRegistry, ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { minimatch } from 'minimatch';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { THINKING_LEVELS, type ThinkingLevel } from '../types.js';
import type { Model } from '@earendil-works/pi-ai';
import { supportsModelXhigh } from './pi-ai-compat.js';
import { resolvePiSpawn, sanitizedChildEnv } from './pi-spawn.js';

export interface AvailableModelInfo {
  ref: string;
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  supportsXhigh: boolean;
}

export interface ThinkingAdjustment {
  requested: ThinkingLevel;
  effective: ThinkingLevel;
  adjusted: boolean;
  reason?: 'non_reasoning' | 'xhigh_to_high';
}

interface ModelCache {
  loadedAt: number;
  cwd: string;
  models: AvailableModelInfo[];
}

// One shared in-flight guard for every async catalog refresh (SWR + slash commands + startup warm).
const refreshPromises = new Map<string, Promise<void>>();
// Enabled-models patterns cache (SettingsManager reads settings from disk per call).
const patternsCache = new Map<string, { loadedAt: number; patterns: string[] | undefined }>();

const CACHE_TTL_MS = 30_000;
// A hung `pi --list-models` (broken wrapper, stuck provider lookup) must not
// block gateway startup or the event loop indefinitely.
const LIST_MODELS_TIMEOUT_MS = 15_000;

const cacheByCwd = new Map<string, ModelCache>();

export function listAvailableModels(options?: {
  forceRefresh?: boolean;
  cwd?: string;
  allowStale?: boolean;
}): AvailableModelInfo[] {
  return loadModelCatalog(
    options?.forceRefresh ?? false,
    options?.cwd ?? process.cwd(),
    options?.allowStale ?? false,
  ).models;
}

export function hasCachedModelCatalog(cwd: string): boolean {
  return cacheByCwd.has(cwd);
}

export function isModelCatalogStale(cwd: string): boolean {
  const cached = cacheByCwd.get(cwd);
  return !cached || Date.now() - cached.loadedAt >= CACHE_TTL_MS;
}

/**
 * Return the models exposed by pi's configured enabledModels scope.
 * An absent or empty scope preserves the existing all-available-models behavior.
 */
export async function listSelectableModels(options?: {
  forceRefresh?: boolean;
  cwd?: string;
  allowStale?: boolean;
}): Promise<AvailableModelInfo[]> {
  const cwd = options?.cwd ?? process.cwd();
  const catalog = loadModelCatalog(
    options?.forceRefresh ?? false,
    cwd,
    options?.allowStale ?? false,
  );
  const patterns = getEnabledModelsScope(cwd, options?.forceRefresh ?? false);
  if (!patterns?.length) {
    return catalog.models;
  }
  return resolveEnabledModelScope(patterns, catalog.models);
}

/** Read pi's enabledModels scope for a cwd, cached with the catalog TTL. */
function getEnabledModelsScope(cwd: string, forceRefresh: boolean): string[] | undefined {
  const now = Date.now();
  const cached = patternsCache.get(cwd);
  if (!forceRefresh && cached && now - cached.loadedAt < CACHE_TTL_MS) {
    return cached.patterns;
  }
  const settingsManager = SettingsManager.create(cwd);
  const patterns = settingsManager.getEnabledModels();
  patternsCache.set(cwd, { loadedAt: now, patterns });
  return patterns;
}

export function resolveModelReference(
  ref: string,
  models: AvailableModelInfo[] = listAvailableModels(),
): AvailableModelInfo | undefined {
  const raw = ref.trim();
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  const normalized = normalize(raw);
  let match = models.find((m) => m.ref.toLowerCase() === lower);
  if (match) return match;
  match = models.find((m) => m.id.toLowerCase() === lower || m.name.toLowerCase() === lower);
  if (match) return match;
  match = models.find(
    (m) =>
      normalize(m.ref) === normalized ||
      normalize(m.id) === normalized ||
      normalize(m.name) === normalized,
  );
  if (match) return match;
  const partialMatches = models.filter(
    (m) =>
      normalize(m.ref).includes(normalized) ||
      normalize(m.id).includes(normalized) ||
      normalize(m.name).includes(normalized),
  );
  if (partialMatches.length === 0) return undefined;
  partialMatches.sort(
    (a, b) => scoreModelMatch(b, raw) - scoreModelMatch(a, raw) || a.ref.localeCompare(b.ref),
  );
  return partialMatches[0];
}

export async function autocompleteModels(
  query: string,
  limit = 25,
  options?: { forceRefresh?: boolean; cwd?: string; allowStale?: boolean },
): Promise<AvailableModelInfo[]> {
  const models = await listSelectableModels(options);
  const trimmed = query.trim();
  if (!trimmed) {
    return models.slice(0, limit);
  }
  const normalized = normalize(trimmed);
  return models
    .filter(
      (m) =>
        normalize(m.ref).includes(normalized) ||
        normalize(m.id).includes(normalized) ||
        normalize(m.name).includes(normalized),
    )
    .sort(
      (a, b) =>
        scoreModelMatch(b, trimmed) - scoreModelMatch(a, trimmed) || a.ref.localeCompare(b.ref),
    )
    .slice(0, limit);
}

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

export function resolveThinkingForModel(
  model: AvailableModelInfo | undefined,
  desired: ThinkingLevel,
): ThinkingAdjustment {
  if (!model) {
    return { requested: desired, effective: desired, adjusted: false };
  }
  if (!model.reasoning && desired !== 'off') {
    return {
      requested: desired,
      effective: 'off',
      adjusted: true,
      reason: 'non_reasoning',
    };
  }
  if (desired === 'xhigh' && !model.supportsXhigh) {
    return {
      requested: desired,
      effective: 'high',
      adjusted: true,
      reason: 'xhigh_to_high',
    };
  }
  return { requested: desired, effective: desired, adjusted: false };
}

export function toModelChoiceName(model: AvailableModelInfo): string {
  const label = model.name && model.name !== model.id ? `${model.ref} — ${model.name}` : model.ref;
  return label.length > 100 ? `${label.slice(0, 97)}...` : label;
}

function resolveEnabledModelScope(
  patterns: string[],
  models: AvailableModelInfo[],
): AvailableModelInfo[] {
  const scopedModels: AvailableModelInfo[] = [];
  for (const pattern of patterns) {
    if (hasGlobCharacters(pattern)) {
      const globPattern = stripThinkingLevel(pattern);
      const matches = models.filter((model) =>
        [`${model.provider}/${model.id}`, model.id].some((ref) =>
          minimatch(ref, globPattern, { nocase: true }),
        ),
      );
      for (const model of matches) {
        addUniqueModel(scopedModels, model);
      }
      continue;
    }
    const model = resolveScopePattern(pattern, models);
    if (model) {
      addUniqueModel(scopedModels, model);
    }
  }
  return scopedModels;
}

function resolveScopePattern(
  pattern: string,
  models: AvailableModelInfo[],
): AvailableModelInfo | undefined {
  const exact = findExactScopeMatch(pattern, models);
  if (exact) return exact;
  const partialMatches = models.filter(
    (model) =>
      model.id.toLowerCase().includes(pattern.toLowerCase()) ||
      model.name?.toLowerCase().includes(pattern.toLowerCase()),
  );
  if (partialMatches.length > 0) {
    const aliases = partialMatches.filter((model) => !/-\d{8}$/.test(model.id));
    return (aliases.length > 0 ? aliases : partialMatches).sort((a, b) =>
      b.id.localeCompare(a.id),
    )[0];
  }
  const colonIndex = pattern.lastIndexOf(':');
  if (colonIndex !== -1) {
    return resolveScopePattern(pattern.slice(0, colonIndex), models);
  }
  return undefined;
}

function findExactScopeMatch(
  pattern: string,
  models: AvailableModelInfo[],
): AvailableModelInfo | undefined {
  const normalized = pattern.trim().toLowerCase();
  const canonicalMatches = models.filter(
    (model) => `${model.provider}/${model.id}`.toLowerCase() === normalized,
  );
  if (canonicalMatches.length === 1) return canonicalMatches[0];
  if (canonicalMatches.length > 1) return undefined;
  const idMatches = models.filter((model) => model.id.toLowerCase() === normalized);
  return idMatches.length === 1 ? idMatches[0] : undefined;
}

function stripThinkingLevel(pattern: string): string {
  const colonIndex = pattern.lastIndexOf(':');
  if (colonIndex === -1) return pattern;
  const suffix = pattern.slice(colonIndex + 1);
  return [...THINKING_LEVELS, 'max'].includes(suffix) ? pattern.slice(0, colonIndex) : pattern;
}

function hasGlobCharacters(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('?') || pattern.includes('[');
}

function addUniqueModel(models: AvailableModelInfo[], candidate: AvailableModelInfo): void {
  if (!models.some((model) => model.provider === candidate.provider && model.id === candidate.id)) {
    models.push(candidate);
  }
}

function loadModelCatalog(forceRefresh: boolean, cwd: string, allowStale: boolean): ModelCache {
  const now = Date.now();
  const cached = cacheByCwd.get(cwd);
  if (!forceRefresh && cached && (allowStale || now - cached.loadedAt < CACHE_TTL_MS)) {
    return cached;
  }
  if (!forceRefresh && cached) {
    // Stale-while-revalidate: serve the cached catalog immediately and refresh
    // off the hot path — a blocking `pi --list-models` here would stall the
    // event loop (and Discord heartbeats) for seconds on every TTL expiry.
    void refreshModelCatalogAsync(cwd);
    return cached;
  }
  if (!forceRefresh) {
    // No cache at all on the hot path (e.g. a channel with a brand-new cwd):
    // serve an empty, UNCACHED placeholder — the model ref still passes
    // through raw — and load asynchronously. Not caching it lets callers ask
    // hasCachedModelCatalog() to detect "no real catalog yet" (queue.ts waits
    // for the first refresh so thinking clamping is not skipped). Only
    // forceRefresh callers (startup, tests, explicit refreshes) pay the
    // synchronous spawn cost.
    void refreshModelCatalogAsync(cwd);
    return { loadedAt: now, cwd, models: [] };
  }
  const registry = createModelRegistry();
  const sdkModels = registry.getAvailable().map(toAvailableModelInfo);
  const cliModels = listModelsFromPiCli(config.piBin, cwd);
  const models = mergeModelMetadata(cliModels ?? sdkModels, sdkModels).sort((a, b) =>
    a.ref.localeCompare(b.ref),
  );
  const refreshed: ModelCache = { loadedAt: now, cwd, models };
  cacheByCwd.set(cwd, refreshed);
  return refreshed;
}

/**
 * Asynchronously (re)load the catalog for a cwd via background execFile.
 * Deduplicated per cwd; on failure keeps the previous models but bumps
 * loadedAt, so a broken `pi --list-models` retries at most once per TTL
 * instead of once per message.
 */
export function refreshModelCatalogAsync(cwd: string): Promise<void> {
  const existing = refreshPromises.get(cwd);
  if (existing) return existing;

  const promise = (async () => {
    const prev = cacheByCwd.get(cwd);
    const cliModels = await listModelsFromPiCliAsync(config.piBin, cwd);
    if (!cliModels) {
      // Failed or unparseable: keep serving what we have, back off for a TTL.
      cacheByCwd.set(cwd, { loadedAt: Date.now(), cwd, models: prev?.models ?? [] });
      return;
    }
    const registry = createModelRegistry();
    const sdkModels = registry.getAvailable().map(toAvailableModelInfo);
    const models = mergeModelMetadata(cliModels, sdkModels).sort((a, b) =>
      a.ref.localeCompare(b.ref),
    );
    cacheByCwd.set(cwd, { loadedAt: Date.now(), cwd, models });
  })()
    .catch(() => undefined)
    .finally(() => refreshPromises.delete(cwd));

  refreshPromises.set(cwd, promise);
  return promise;
}

function buildListModelArgs(piBin: string): { bin: string; args: string[] } {
  const cliArgs = ['--list-models'];
  if (config.piExtraFlags) {
    cliArgs.push(...config.piExtraFlags.split(/\s+/).filter(Boolean));
  }
  return resolvePiSpawn(piBin, cliArgs);
}

function listModelsFromPiCli(piBin: string, cwd: string): AvailableModelInfo[] | undefined {
  const { bin, args } = buildListModelArgs(piBin);
  const result = spawnSync(bin, args, {
    cwd,
    env: sanitizedChildEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
    timeout: LIST_MODELS_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0 || !result.stdout) {
    return undefined;
  }
  return parsePiModelList(result.stdout);
}

function listModelsFromPiCliAsync(
  piBin: string,
  cwd: string,
): Promise<AvailableModelInfo[] | undefined> {
  const { bin, args } = buildListModelArgs(piBin);
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        cwd,
        env: sanitizedChildEnv(),
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: LIST_MODELS_TIMEOUT_MS,
      },
      (err, stdout) => {
        if (err || !stdout?.trim()) {
          resolve(undefined);
          return;
        }
        resolve(parsePiModelList(stdout));
      },
    );
  });
}

function findModelTableHeader(lines: string[]):
  | {
      providerIndex: number;
      modelIndex: number;
      thinkingIndex: number;
      rowsStart: number;
    }
  | undefined {
  for (const [index, line] of lines.entries()) {
    const headers = line.split(/\s+/);
    const providerIndex = headers.indexOf('provider');
    const modelIndex = headers.indexOf('model');
    const thinkingIndex = headers.indexOf('thinking');
    if (providerIndex !== -1 && modelIndex !== -1 && thinkingIndex !== -1) {
      return { providerIndex, modelIndex, thinkingIndex, rowsStart: index + 1 };
    }
  }
  return undefined;
}

/**
 * Parse `pi --list-models` table output.
 * Returns undefined when the output has no recognizable table header (format
 * change, error banner) so callers can fall back to the SDK catalog; a valid
 * table with zero rows returns [] and stays authoritative.
 */
export function parsePiModelList(output: string): AvailableModelInfo[] | undefined {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const header = findModelTableHeader(lines);
  if (!header) return undefined;
  return lines.slice(header.rowsStart).flatMap((line) => {
    const columns = line.split(/\s+/);
    // Separator rows (────) and truncated rows are not models.
    if (columns.length < header.thinkingIndex + 1) return [];
    const provider = columns[header.providerIndex];
    const id = columns[header.modelIndex];
    if (!provider || !id) return [];
    if (!/[a-z0-9]/i.test(provider) || !/[a-z0-9]/i.test(id)) return [];
    const reasoning = columns[header.thinkingIndex]?.toLowerCase() === 'yes';
    return [
      {
        ref: `${provider}/${id}`,
        provider,
        id,
        name: id,
        reasoning,
        // The text table exposes only yes/no thinking support. Let pi perform
        // model-specific clamping for CLI-only models unknown to the bundled SDK.
        supportsXhigh: reasoning,
      },
    ];
  });
}

function mergeModelMetadata(
  sourceModels: AvailableModelInfo[],
  sdkModels: AvailableModelInfo[],
): AvailableModelInfo[] {
  const sdkByRef = new Map(sdkModels.map((model) => [model.ref.toLowerCase(), model]));
  return sourceModels.map((model) => {
    const sdkModel = sdkByRef.get(model.ref.toLowerCase());
    return sdkModel
      ? {
          ...model,
          name: sdkModel.name,
          supportsXhigh: sdkModel.supportsXhigh,
        }
      : model;
  });
}

const STUB_REGISTRY = {
  getAvailable: (): AvailableModelInfoSource[] => [],
};

type AvailableModelInfoSource = any;

let cachedRuntime: ModelRuntime | null = null;
let runtimeInitPromise: Promise<ModelRuntime | null> | null = null;

function ensureModelRuntime(): void {
  if (runtimeInitPromise || cachedRuntime) {
    return;
  }
  // Wrap create() so a synchronous throw (partial/odd SDK builds) lands in
  // the same warn-and-retry path as an async rejection instead of escaping.
  try {
    runtimeInitPromise = ModelRuntime.create()
      .then((runtime) => {
        cachedRuntime = runtime;
        // SDK metadata is now available: refresh known catalogs in the background.
        // Never clear the cache here — an empty cache forces the hot message path
        // back onto the blocking sync `pi --list-models` load.
        for (const cwd of cacheByCwd.keys()) {
          void refreshModelCatalogAsync(cwd);
        }
        return runtime;
      })
      .catch((err: unknown) => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'Failed to initialize pi ModelRuntime; SDK model metadata will be unavailable',
        );
        runtimeInitPromise = null;
        return null;
      });
  } catch (err: unknown) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to initialize pi ModelRuntime; SDK model metadata will be unavailable',
    );
    runtimeInitPromise = null;
  }
}

function createModelRegistry(): { getAvailable(): AvailableModelInfoSource[] } {
  if (cachedRuntime) {
    // ModelRegistry's constructor is declared private in pi's typings but is
    // the intended entry point at runtime (same pattern as pi internals).
    const Registry = ModelRegistry as unknown as new (runtime: ModelRuntime) => {
      getAvailable(): AvailableModelInfoSource[];
    };
    return new Registry(cachedRuntime);
  }
  ensureModelRuntime();
  return STUB_REGISTRY;
}

/** Test-only hook: inject a ModelRuntime without touching the real init path. */
export function __setCachedModelRuntimeForTests(runtime: ModelRuntime | null): void {
  cachedRuntime = runtime;
  runtimeInitPromise = null;
}

function toAvailableModelInfo(model: {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
}): AvailableModelInfo {
  return {
    ref: `${model.provider}/${model.id}`,
    provider: model.provider,
    id: model.id,
    name: model.name || model.id,
    reasoning: Boolean(model.reasoning),
    supportsXhigh: supportsModelXhigh(model as Model<any>),
  };
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function scoreModelMatch(model: AvailableModelInfo, rawQuery: string): number {
  const query = rawQuery.trim().toLowerCase();
  const normalizedQuery = normalize(rawQuery);
  if (!query) return 0;
  let score = 0;
  if (model.ref.toLowerCase() === query) score += 1000;
  if (model.id.toLowerCase() === query) score += 900;
  if (model.name.toLowerCase() === query) score += 800;
  if (normalize(model.ref) === normalizedQuery) score += 700;
  if (normalize(model.id) === normalizedQuery) score += 650;
  if (normalize(model.name) === normalizedQuery) score += 600;
  if (model.ref.toLowerCase().startsWith(query)) score += 500;
  if (model.id.toLowerCase().startsWith(query)) score += 450;
  if (model.name.toLowerCase().startsWith(query)) score += 400;
  if (normalize(model.ref).includes(normalizedQuery)) score += 100;
  if (normalize(model.id).includes(normalizedQuery)) score += 80;
  if (normalize(model.name).includes(normalizedQuery)) score += 60;
  return score;
}
