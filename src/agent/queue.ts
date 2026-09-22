/**
 * Message processing loop.
 *
 * Polls SQLite for pending messages, dispatches to pi agent, sends response
 * back to Discord. Enforces per-channel serial processing and global
 * concurrency limit.
 */

import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  channelsWithPending,
  claimNextMessage,
  clearPendingMessages,
  markMessageDone,
  markMessageFailed,
  logMessage,
  getChannel,
  getQueuedMessage,
  recoverStuckMessages,
  saveResponse,
  pendingNotices,
  markNoticeSent,
  postponeNotice,
  setQueueNotice,
} from '../db.js';
import { invokeAgent } from './invoke.js';
import { sendResponse, sendDurableResponse, setTyping } from '../discord/client.js';
import { splitMessage } from '../discord/delivery.js';
import { routeQueuedMessage } from '../discord/threads.js';
import type { QueuedMessage } from '../types.js';
import {
  cancelStream,
  finalizeStream,
  pushStreamEvent,
  startStreamMessage,
} from '../discord/streaming.js';
import { computeEffectiveChannelSettings } from './channel-settings.js';
import { hasCachedModelCatalog, refreshModelCatalogAsync } from './model-catalog.js';

/** Channels currently being processed (per-channel serial lock) */
const activeChannels = new Set<string>();
const activeTaskPromises = new Set<Promise<void>>();
const activeTaskControllers = new Map<number, AbortController>();
const activeChannelControllers = new Map<string, AbortController>();
/** jid → rowid of the in-flight message (lets /pi stop kill it for good). */
const activeChannelRowids = new Map<string, number>();

let running = false;
let pollTimer: NodeJS.Timeout | undefined;
let pollTimerFiresAt = 0;
let stopPromise: Promise<void> | null = null;

export function isChannelProcessing(jid: string): boolean {
  return activeChannels.has(jid);
}

/** True while at least one message is being processed. The archive cleanup
 * uses it to defer the batched purge: its transaction stays open across
 * yields, so concurrent enqueues would be swept into it. */
export function hasActiveTasks(): boolean {
  return activeTaskPromises.size > 0;
}

export function abortChannelTask(jid: string): { aborted: boolean; cleared: number } {
  const controller = activeChannelControllers.get(jid);
  const aborted = Boolean(controller);
  if (controller) {
    // Voluntary stop: kill the row BEFORE the abort lands, so processMessage's
    // shutdown-recovery contract (leave 'processing' for the next boot) does
    // not resurrect a task the user explicitly asked to stop.
    const rowid = activeChannelRowids.get(jid);
    if (rowid !== undefined) markMessageFailed(rowid);
    controller.abort();
  }
  const cleared = clearPendingMessages(jid);
  return { aborted, cleared };
}

export function startProcessingLoop(): void {
  if (running) return;

  running = true;
  stopPromise = null;

  // Restart recovery (README restart table): routing rows go back to pending
  // (pi was never invoked), rows whose execution started are parked as
  // interrupted with a notice — never silently rerun. Rows already over the
  // attempt budget die as failed (crash-loop ceiling).
  const { recovered, interrupted, abandoned, abandonedByChannel } = recoverStuckMessages();
  if (abandoned > 0) {
    logger.warn(
      { abandoned, maxAttempts: config.maxMessageAttempts },
      'Abandoned stuck messages over attempt budget',
    );
  }
  // Tell the authors their message died — silence is the worst outcome. The
  // bot is already connected when the loop starts; best-effort, never wedge
  // the boot on it.
  for (const { jid, count } of abandonedByChannel) {
    const subject = count === 1 ? 'A message was' : `${count} messages were`;
    sendResponse(
      jid,
      `⚠️ ${subject} discarded after ${config.maxMessageAttempts} failed attempts (the agent process died on every retry). Please try again, possibly rephrasing or removing heavy attachments.`,
    ).catch(() => undefined);
  }
  if (recovered > 0 || interrupted > 0) {
    logger.info({ recovered, interrupted }, 'Recovered stuck messages');
  }

  schedulePoll(0);
}

export function stopProcessingLoop(opts: { timeoutMs?: number } = {}): Promise<void> {
  if (stopPromise) {
    return stopPromise;
  }

  running = false;
  clearPollTimer();

  stopPromise = drainActiveTasks(opts.timeoutMs ?? config.shutdownTimeoutMs);
  return stopPromise;
}

function schedulePoll(delayMs = config.pollInterval): void {
  if (!running) return;

  // A sooner explicit request (e.g. schedulePoll(0) after a task finished)
  // preempts the pending timer instead of waiting a full interval.
  const firesAt = Date.now() + delayMs;
  if (pollTimer) {
    if (firesAt >= pollTimerFiresAt) return;
    clearTimeout(pollTimer);
  }

  pollTimerFiresAt = firesAt;
  pollTimer = setTimeout(() => {
    pollTimer = undefined;
    poll();
  }, delayMs);
}

function clearPollTimer(): void {
  if (!pollTimer) return;
  clearTimeout(pollTimer);
  pollTimer = undefined;
}

function poll(): void {
  if (!running) return;

  try {
    dispatch();
    drainNotices();
  } catch (err: any) {
    logger.error({ err: err.message }, 'Poll error');
  } finally {
    schedulePoll();
  }
}

/** Deliver pending task notices (interrupted / delivery_uncertain / failed):
 * the scrollback must tell the user what happened to their task. Best-effort
 * with a 5-minute backoff on failure — pendingNotices() already bounds the
 * batch to 20 and gates on notice_next_attempt_at. Each row is claimed
 * (30s in-flight window) before the send: otherwise any send slower than
 * the poll interval (429 backoff, 5xx, network latency) is re-picked next
 * tick and the notice is delivered twice, each copy with its own retries. */
function drainNotices(): void {
  for (const notice of pendingNotices()) {
    postponeNotice(notice.rowid, 30_000);
    void sendResponse(notice.channel_jid, `⚠️ ${notice.notice_text}`)
      .then((sent) => {
        if (sent) markNoticeSent(notice.rowid);
        else postponeNotice(notice.rowid);
      })
      .catch(() => postponeNotice(notice.rowid));
  }
}

function dispatch(): void {
  if (activeTaskPromises.size >= config.maxConcurrency) return;

  for (const jid of channelsWithPending()) {
    if (activeChannels.has(jid)) continue;
    if (activeTaskPromises.size >= config.maxConcurrency) break;

    const msg = claimNextMessage(jid);
    if (!msg) continue;

    const controller = new AbortController();
    activeChannels.add(jid);
    activeTaskControllers.set(msg.rowid, controller);
    activeChannelControllers.set(jid, controller);
    activeChannelRowids.set(jid, msg.rowid);

    const taskPromise = runClaimedTask(jid, msg, controller.signal).finally(() => {
      activeChannels.delete(jid);
      activeTaskControllers.delete(msg.rowid);
      activeChannelControllers.delete(jid);
      activeChannelRowids.delete(jid);
      activeTaskPromises.delete(taskPromise);

      if (running) {
        schedulePoll(0);
      }
    });

    activeTaskPromises.add(taskPromise);
  }
}

/** One claimed row, three shapes: a thread-starter to route (pi not yet
 * invoked), a saved answer to resume delivering (pi must NOT run again), or a
 * fresh turn to execute. */
async function runClaimedTask(jid: string, msg: QueuedMessage, signal: AbortSignal): Promise<void> {
  if (msg.status === 'routing') return routeClaimedMessage(jid, msg, signal);
  if (msg.status === 'delivering') return redeliverSavedResponse(jid, msg.rowid, signal);
  return processMessage(jid, msg.rowid, msg.sender_name, msg.content, signal, msg.attachments);
}

/** Open the conversation thread and requeue the row there. The next poll
 * claims it on the thread channel with the thread's own session folder. */
async function routeClaimedMessage(
  jid: string,
  msg: QueuedMessage,
  signal: AbortSignal,
): Promise<void> {
  try {
    await routeQueuedMessage(msg, signal);
    logger.info({ jid, rowid: msg.rowid }, 'Message routed to its conversation thread');
  } catch (err: any) {
    if (signal.aborted) {
      // Shutdown cut routing (the row keeps its 'routing' status for the next
      // boot to requeue — pi was never invoked). A voluntary /pi stop has
      // already marked the row failed before aborting; nothing to do either way.
      logger.info({ jid, rowid: msg.rowid }, 'Routing abandoned: interrupted');
      return;
    }
    markMessageFailed(msg.rowid);
    logger.warn({ jid, rowid: msg.rowid, err: err.message }, 'Thread routing failed');
    await sendResponse(
      jid,
      '⚠️ Could not open a thread for this message — details in the gateway logs.',
    ).catch(() => undefined);
  }
}

/** Resume delivery of a saved answer (crash/restart/rate-limit retry path).
 * Chunks already sent are skipped; uncertain old sends stop with a notice. */
async function redeliverSavedResponse(
  jid: string,
  rowid: number,
  signal: AbortSignal,
): Promise<void> {
  const typingLoop = createTypingLoop(jid);
  try {
    const sent = await sendDurableResponse(rowid, signal);
    if (sent) {
      markMessageDone(rowid);
      logger.info({ jid, rowid }, 'Saved answer delivered');
      return;
    }
    if (signal.aborted) return; // stays 'delivering': resumed at next boot
    const status = getQueuedMessage(rowid)?.status;
    if (status === 'delivering') {
      // Transient failure (rate limit / 5xx / network): retryDelivery already
      // scheduled the next attempt via next_attempt_at.
      logger.info({ jid, rowid }, 'Answer delivery postponed; will retry');
      return;
    }
    // delivery_failed / delivery_uncertain / cancelled own their notices.
    logger.warn({ jid, rowid, status }, 'Answer delivery stopped');
  } finally {
    await typingLoop.stop();
  }
}

async function drainActiveTasks(timeoutMs: number): Promise<void> {
  if (activeTaskPromises.size === 0) {
    return;
  }

  const initialDrain = Promise.allSettled([...activeTaskPromises]);
  const drainedGracefully = await waitForPromise(initialDrain, timeoutMs);
  if (drainedGracefully) {
    return;
  }

  logger.warn(
    { timeoutMs, activeTasks: activeTaskPromises.size },
    'Shutdown timeout reached; aborting in-flight message processing',
  );

  for (const controller of activeTaskControllers.values()) {
    controller.abort();
  }

  if (activeTaskPromises.size > 0) {
    await Promise.race([
      Promise.allSettled([...activeTaskPromises]),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
}

async function waitForPromise(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs === 0) {
    return false;
  }

  let timer: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  return activeTaskPromises.size === 0;
}

async function processMessage(
  jid: string,
  rowid: number,
  senderName: string,
  content: string,
  signal: AbortSignal,
  attachments?: string | null,
): Promise<void> {
  const channel = getChannel(jid);
  if (!channel) {
    logger.warn({ jid }, 'Channel disappeared during processing');
    markMessageFailed(rowid);
    return;
  }

  logger.info({ jid, senderName, len: content.length }, 'Processing message');

  const typingLoop = createTypingLoop(jid);

  // Live activity message (best-effort; null message degrades to single-shot)
  const stream = config.streaming !== 'off' ? await startStreamMessage(jid) : null;

  try {
    const prompt = `[Discord user: ${senderName}]\n${content}`;

    logMessage(jid, 'user', content);

    // First message on a brand-new cwd: wait for the async catalog load
    // (non-blocking) so thinking clamping and model validation are not
    // skipped on this very message.
    const desiredCwd = channel.cwdOverride || config.piCwd;
    if (!hasCachedModelCatalog(desiredCwd)) {
      // Best-effort warm (upstream 2.0.0 semantics: discovery failures retain
      // stale data; the message must not die because the catalog is cold).
      await refreshModelCatalogAsync(desiredCwd).catch(() => undefined);
    }

    const effective = computeEffectiveChannelSettings(channel);

    const result = await invokeAgent(channel.folder, prompt, {
      model: effective.rawModelRef || undefined,
      thinking: effective.hasManagedThinking ? effective.effectiveThinking : undefined,
      cwd: effective.effectiveCwd,
      signal,
      attachments,
      onEvent: stream
        ? (event) => {
            void pushStreamEvent(stream, event);
          }
        : undefined,
    });

    if (result.attachmentNotice) {
      // User-facing shortfall (attachments dropped/partial): goes through the
      // queue-notice machinery — claim, retry, delivery even on success.
      setQueueNotice(rowid, `Task #${rowid}: ${result.attachmentNotice}`);
    }

    if (signal.aborted) {
      // Shutdown interrupted processing: leave the row 'processing' so the
      // next boot's recoverStuckMessages() parks it as interrupted with a
      // notice — the user decides whether to submit again. Marking it failed
      // here would silently drop the user's message.
      if (stream) await finalizeStream(stream, undefined); // preserve activity log
      logger.info({ jid, rowid }, 'Message abandoned: shutdown interrupted processing');
      return;
    }

    if (result.ok) {
      if (stream) await finalizeStream(stream, result.text);
      // Persist the answer before sending (README: answers are saved before
      // delivery): a restart resumes unsent chunks without rerunning pi, and
      // `piscord result <task-id>` can always read the saved text.
      saveResponse(rowid, result.text, splitMessage(result.text, 2000));
      const sent = await sendDurableResponse(rowid, signal);
      if (!sent) {
        if (signal.aborted) {
          // Shutdown cut delivery mid-chunk: the row stays 'delivering' with
          // its chunks — the next boot (or retry tick) resumes exactly the
          // unsent ones. No rerun, no duplicate chunks.
          logger.info({ jid, rowid }, 'Delivery aborted by shutdown; saved answer left resumable');
          return;
        }
        const status = getQueuedMessage(rowid)?.status;
        if (status === 'delivering') {
          // Transient failure: retry scheduled via next_attempt_at.
          logger.info({ jid, rowid }, 'Delivery postponed; will retry');
          return;
        }
        // delivery_failed / delivery_uncertain / cancelled: terminal states
        // set by deliverResponse, each with its own notice.
        logger.warn({ jid, rowid, status }, 'Answer delivery stopped');
        return;
      }

      logMessage(jid, 'assistant', result.text);
      markMessageDone(rowid);
      logger.info(
        { jid, responseLen: result.text.length, streamed: Boolean(stream?.message) },
        'Message processed',
      );
      return;
    }

    if (result.killed) {
      // pi was SIGTERM'd (gateway restart/stop): keep the activity log,
      // don't delete history and don't spam a ⚠️ error message.
      // Leave the row 'processing': the next boot's recoverStuckMessages()
      // parks it as interrupted with a notice — the user decides whether to
      // submit again; --continue keeps the session for that decision.
      if (stream) await finalizeStream(stream, undefined);
      logger.warn(
        { jid, rowid, error: result.error },
        'pi killed (shutdown/restart); message left recoverable for next boot',
      );
      return;
    }

    if (result.timedOut) {
      // AGENT_TIMEOUT_MS hit: report it, but keep the activity log of the
      // tools that did run before the kill.
      markMessageFailed(rowid);
      if (stream) await finalizeStream(stream, undefined);
      // agentTimeoutMs is not sensitive: naming the limit helps the user
      // raise it via env instead of staring at "details in the logs".
      await sendResponse(
        jid,
        `⚠️ Agent invocation timed out (limit ${Math.round(config.agentTimeoutMs / 1000)}s) — details in the gateway logs.`,
      );
      logger.warn({ jid, rowid, error: result.error }, 'Agent invocation timed out');
      return;
    }

    if (stream) await cancelStream(stream);
    // Same discipline as the slash commands: no host internals (paths,
    // stderr) reflected into the channel — the log line above carries them.
    await sendResponse(jid, '⚠️ Agent error — details in the gateway logs.');
    markMessageFailed(rowid);
    logger.warn({ jid, error: result.error }, 'Agent returned error');
  } catch (err: any) {
    if (signal.aborted) {
      // Shutdown interrupted processing: same recovery contract as the
      // post-invoke branch — keep the row for the next boot's re-enqueue.
      if (stream) await finalizeStream(stream, undefined); // preserve activity log
      logger.info({ jid, rowid }, 'Message abandoned: shutdown interrupted processing');
      return;
    }

    logger.error({ jid, err: err.message }, 'processMessage failed');
    markMessageFailed(rowid);
    if (stream) await cancelStream(stream);
    try {
      await sendResponse(jid, '⚠️ Internal error — details in the gateway logs.');
    } catch {
      // Nothing else to do here.
    }
  } finally {
    await typingLoop.stop();
  }
}

function createTypingLoop(jid: string): { stop: () => Promise<void> } {
  let typingAlive = true;
  let cancelTypingDelay = () => {};

  const loop = (async () => {
    while (typingAlive) {
      await setTyping(jid);
      if (!typingAlive) break;

      const delay = cancellableSleep(8000);
      cancelTypingDelay = delay.cancel;
      await delay.promise;
      cancelTypingDelay = () => {};
    }
  })();

  return {
    stop: async () => {
      typingAlive = false;
      cancelTypingDelay();
      await loop;
    },
  };
}

function cancellableSleep(ms: number): { promise: Promise<void>; cancel: () => void } {
  let finished = false;
  let timer: NodeJS.Timeout | undefined;
  let resolvePromise: () => void = () => {};

  const promise = new Promise<void>((resolve) => {
    resolvePromise = () => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      resolve();
    };

    timer = setTimeout(resolvePromise, ms);
  });

  return {
    promise,
    cancel: resolvePromise,
  };
}
