import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { config } from '../config.js';
import { channelsWithPending, getAllChannels } from '../db.js';
import { isChannelProcessing } from '../agent/queue.js';
import { getChannelSessionStatus, readTailLines } from '../agent/invoke.js';
import { fetchChannel } from '../discord/client.js';
import { resolveLatestChannelSessionFile, rotateChannelSessionDir } from './path.js';
import { logger } from '../logger.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CHECK_INTERVAL_MS = HOUR_MS;
/** Tail window for the fallback context estimate: a usage line is short, but
 * a large kept assistant message may push the newest usage entry further back. */
const TAIL_BYTES = 256 * 1024;
/** Rotate when the session context exceeds this fraction of the model's
 * context window. The window comes per session from pi's get_session_stats
 * RPC, so it always reflects the model actually in use.
 * ponytail: fixed fraction, no per-channel override — add one if a channel
 * ever needs a different budget. */
const CONTEXT_WINDOW_FRACTION = 0.25;

/** Estimate the context tokens of the newest pi request from the session
 * tail: the prompt size is input + cacheRead + cacheWrite of the newest
 * assistant usage entry.
 * ponytail: approximates pi's projected context; only used as fallback when
 * get_session_stats gives no contextUsage (e.g. RPC unavailable). */
export function estimateContextTokens(sessionFile: string): number {
  let lines: string[];
  try {
    lines = readTailLines(sessionFile, TAIL_BYTES);
  } catch {
    return 0; // file vanished between listing and reading
  }

  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]?.trim();
    if (!line) continue;

    try {
      const entry = JSON.parse(line) as {
        type?: string;
        message?: {
          role?: string;
          usage?: { input?: number; cacheRead?: number; cacheWrite?: number };
        };
      };

      if (entry.type !== 'message' || entry.message?.role !== 'assistant' || !entry.message.usage) {
        continue;
      }

      const usage = entry.message.usage;
      return (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    } catch {
      // Ignore incomplete or malformed trailing JSONL lines.
    }
  }

  return 0;
}

interface ContextBudget {
  contextTokens: number;
  thresholdTokens: number;
}

/** Resolve the session's current context and its rotation threshold. The
 * threshold is 25% of the model's context window when pi reports one, else
 * the static AUTO_ROTATE_MIN_CONTEXT_TOKENS floor. */
async function resolveContextBudget(
  folder: string,
  cwd: string,
  sessionFile: string,
): Promise<ContextBudget> {
  try {
    const status = await getChannelSessionStatus(folder, cwd);
    const tokens = status.contextUsage?.tokens;
    const window = status.contextUsage?.contextWindow;
    if (tokens != null && window != null && window > 0) {
      return {
        contextTokens: tokens,
        thresholdTokens: Math.ceil(window * CONTEXT_WINDOW_FRACTION),
      };
    }
    if (tokens != null) {
      return { contextTokens: tokens, thresholdTokens: config.autoRotateMinContextTokens };
    }
  } catch (err: any) {
    logger.warn({ err: err.message, folder }, 'Session stats unavailable for auto-rotate');
  }

  return {
    contextTokens: estimateContextTokens(sessionFile),
    thresholdTokens: config.autoRotateMinContextTokens,
  };
}

async function postNotice(
  jid: string,
  archivedPath: string,
  contextTokens: number,
  idleMs: number,
): Promise<void> {
  const channel = await fetchChannel(jid);
  if (!channel) return;

  const idle =
    idleMs >= 2 * DAY_MS
      ? `${Math.round(idleMs / DAY_MS)} days`
      : `${Math.round(idleMs / HOUR_MS)} hours`;
  const content =
    `🧹 Idle session auto-archived (context ~${Math.round(contextTokens / 1000)}k tokens, ` +
    `inactive for ${idle}). A fresh session starts here; history is preserved ` +
    `in \`${basename(archivedPath)}\` and remains searchable.`;

  try {
    await channel.send({ content, allowedMentions: { parse: [] } });
  } catch (err: any) {
    logger.warn({ err: err.message, jid }, 'Auto-rotate notice delivery failed');
  }
}

export async function runAutoRotate(now = Date.now()): Promise<void> {
  // Catch-all: the startup tick is fire-and-forget, so anything thrown here
  // (including an unexpected module error) would become an unhandled rejection.
  try {
    await rotateEligibleChannels(now);
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Auto-rotate run failed');
  }
}

async function rotateEligibleChannels(now: number): Promise<void> {
  if (config.autoRotateIdleHours <= 0) return;
  const idleThresholdMs = config.autoRotateIdleHours * HOUR_MS;
  const pending = new Set(channelsWithPending());

  for (const channel of getAllChannels()) {
    try {
      if (channel.deletedAt) continue;
      if (isChannelProcessing(channel.jid) || pending.has(channel.jid)) continue;

      const sessionFile = resolveLatestChannelSessionFile(channel.folder);
      if (!sessionFile) continue;

      const idleMs = now - statSync(sessionFile).mtimeMs;
      if (idleMs < idleThresholdMs) continue;

      const { contextTokens, thresholdTokens } = await resolveContextBudget(
        channel.folder,
        channel.cwdOverride || config.piCwd,
        sessionFile,
      );
      if (contextTokens < thresholdTokens) continue;

      const archivedPath = rotateChannelSessionDir(channel.folder);
      if (!archivedPath) continue;

      logger.info(
        {
          jid: channel.jid,
          folder: channel.folder,
          archivedPath,
          contextTokens,
          thresholdTokens,
        },
        'Auto-rotated idle channel session',
      );
      await postNotice(channel.jid, archivedPath, contextTokens, idleMs);
    } catch (err: any) {
      logger.warn({ err: err.message, jid: channel.jid }, 'Auto-rotate check failed');
    }
  }
}

export function startAutoRotate(): () => void {
  if (config.autoRotateIdleHours <= 0) {
    return () => {};
  }

  // Run immediately, like archive-cleanup: idle time accrued while the
  // gateway was down still counts.
  void runAutoRotate();
  const timer = setInterval(() => void runAutoRotate(), CHECK_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
