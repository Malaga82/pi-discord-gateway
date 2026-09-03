/**
 * Streaming responses: live-edit a Discord message while pi works.
 *
 * Modes (config.streaming):
 * - 'off':   no live message; single-shot response (queue skips this module)
 * - 'tools': Hermes-style chronological activity log — tool lines (emoji +
 *            verb + short arg) interleaved with the LLM's interstitial
 *            commentary text. No streamed text.
 * - 'full':  activity log + thinking + streamed response text tail.
 *
 * The live message is edited (throttled). On completion it is edited to the
 * final answer; if the answer exceeds Discord's limit the placeholder is
 * deleted and the caller falls back to chunked sends.
 *
 * Every step is best-effort: any failure degrades to the classic single-shot
 * response path.
 */
import { type Message } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { fetchChannel } from './client.js';

const COMMENTARY_MAX = 1900; // editing headroom below Discord's 2000 hard limit
const MIN_EDIT_INTERVAL_MS_DEFAULT = 2000;
const LOG_MAX_ENTRIES = 14;
const LOG_MAX_CHARS = 1600;
const ARG_MAX = 80;
const INTERSTITIAL_MAX = 500;
const SENTENCE_MAX = 200;

const TOOL_META: Record<string, { emoji: string; verb: string }> = {
  bash: { emoji: '💻', verb: 'Running' },
  read: { emoji: '📖', verb: 'Reading' },
  write: { emoji: '📝', verb: 'Writing' },
  edit: { emoji: '✏️', verb: 'Editing' },
  grep: { emoji: '🔍', verb: 'Searching' },
  glob: { emoji: '📂', verb: 'Scanning' },
  list: { emoji: '📂', verb: 'Listing' },
};

export interface StreamLogEntry {
  kind: 'tool' | 'text';
  text: string;
  count?: number;
}

/** Mutable stream state derived from pi --mode json events. */
export interface StreamState {
  log: StreamLogEntry[];
  text: string;
  thinking: string;
  msgHasToolCall: boolean;
  startedAt: number;
  turnCount: number;
}

export interface StreamHandle {
  jid: string;
  message: Message | null;
  state: StreamState;
  lastEdit: number;
  lastContent: string;
  editing: boolean;
  needsFlush: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Set once the stream is finalized/cancelled: no more flush edits may run. */
  done?: boolean;
  /** In-flight flush, awaited by finalize/cancel so edits never reorder. */
  flushInFlight?: Promise<void>;
}

/** pi JSONL event (loosely typed — shape comes from the agent, not the gateway). */
type PiEvent = any;

export function createStreamState(): StreamState {
  return {
    log: [],
    text: '',
    thinking: '',
    msgHasToolCall: false,
    startedAt: Date.now(),
    turnCount: 0,
  };
}

function pushLog(state: StreamState, line: string, kind: 'tool' | 'text'): void {
  if (!line) return;
  const last = state.log[state.log.length - 1];
  // Consecutive identical tool calls collapse Hermes-style: `💻 Running … (×2)`.
  if (kind === 'tool' && last?.kind === 'tool' && last.text === line) {
    last.count = (last.count ?? 1) + 1;
    return;
  }
  state.log.push({ kind, text: line });
  while (
    state.log.length > LOG_MAX_ENTRIES ||
    (state.log.length > 1 && renderLog(state).length > LOG_MAX_CHARS)
  ) {
    state.log.shift();
  }
}

/** Apply one pi JSON event to the stream state (pure state mutation). */
export function applyEvent(state: StreamState, event: PiEvent): void {
  const type = event?.type;
  if (type === 'turn_start') {
    state.turnCount += 1;
    return;
  }
  if (type === 'message_start' && event.message?.role === 'assistant') {
    state.text = '';
    state.thinking = '';
    state.msgHasToolCall = false;
    return;
  }
  if (type === 'message_update' && event.assistantMessageEvent) {
    const ev = event.assistantMessageEvent;
    if (ev.type === 'thinking_delta' && ev.delta) {
      state.thinking += ev.delta;
    } else if (ev.type === 'text_delta' && ev.delta) {
      state.text += ev.delta;
    } else if (ev.type === 'toolcall_start') {
      state.msgHasToolCall = true;
    }
    return;
  }
  if (type === 'message_end' && event.message) {
    const message = event.message;
    if (message.role === 'toolResult') return;
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      // Single pass in content order: a harmony-style preamble (user-facing
      // text emitted before tool calls) must sit ABOVE its tool lines.
      for (const block of message.content) {
        if (block.type === 'toolCall') {
          pushLog(state, renderToolLine(block), 'tool');
        } else if (
          config.streaming === 'tools' &&
          block.type === 'text' &&
          typeof block.text === 'string' &&
          block.text.trim()
        ) {
          pushLog(state, condense(block.text), 'text');
        }
      }
      state.msgHasToolCall = false;
    }
  }
}

function renderToolLine(toolCall: any): string {
  const name = String(toolCall.name || 'tool').toLowerCase();
  const meta = TOOL_META[name] || { emoji: '🔧', verb: name };
  const args = toolCall.arguments;
  let argPreview = '';
  if (typeof args === 'string') {
    argPreview = args;
  } else if (args && typeof args === 'object') {
    argPreview =
      typeof args.command === 'string' ||
      typeof args.path === 'string' ||
      typeof args.query === 'string' ||
      typeof args.url === 'string'
        ? (args.command ?? args.path ?? args.query ?? args.url)
        : JSON.stringify(args);
  }
  argPreview = String(argPreview).replace(/\s+/gu, ' ').replace(/`/gu, "'").trim();
  // The activity log persists in the channel scrollback: strip credentials
  // that would otherwise land there verbatim (curl -H "Authorization: …",
  // exported tokens, API keys pasted in commands).
  argPreview = argPreview
    .replace(
      /(authorization|bearer|token|api[_-]?key|password|secret)\s*[:=]\s*\S+/gi,
      '$1: [REDACTED]',
    )
    .replace(/\b(sk|ghp|gho|xox[baprs]|AIza)[A-Za-z0-9_-]{8,}/g, '[REDACTED]');
  const short = argPreview.length > ARG_MAX ? `${argPreview.slice(0, ARG_MAX)}…` : argPreview;
  return short ? `${meta.emoji} ${meta.verb} \`${short}\`` : `${meta.emoji} ${meta.verb}`;
}

function condense(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > INTERSTITIAL_MAX ? `${flat.slice(0, INTERSTITIAL_MAX)}…` : flat;
}

/** Render the activity log: Hermes-tight, single newlines, no blank lines. */
export function renderLog(state: StreamState, entries: StreamLogEntry[] = state.log): string {
  let out = '';
  for (const entry of entries) {
    const text = entry.count && entry.count > 1 ? `${entry.text} (×${entry.count})` : entry.text;
    out = out ? `${out}\n${text}` : text;
  }
  return out;
}

/** First sentence of a text (courtesy preview while tools are pending). */
function firstSentence(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  const match = flat.match(/^[\s\S]*?[.?!](?=\s|$)/u);
  const sentence = (match?.[0] ?? flat).trim();
  return sentence.length > SENTENCE_MAX ? `${sentence.slice(0, SENTENCE_MAX)}…` : sentence;
}

function formatElapsed(state: StreamState): string {
  const secs = Math.max(0, Math.round((Date.now() - (state.startedAt || Date.now())) / 1000));
  const clock = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return state.turnCount > 1 ? `${clock} — iteration ${state.turnCount}` : clock;
}

/** Build the commentary markdown shown while the agent works. */
export function renderCommentary(state: StreamState): string {
  const entries = [...state.log];
  const build = (): string => {
    const log = renderLog(state, entries);
    const parts: string[] = log ? [log] : [];
    if (config.streaming !== 'tools') {
      if (!state.text && state.thinking.trim()) {
        parts.push(`🤔 _${tail(state.thinking.trim(), 200)}_`);
      }
      if (state.text.trim()) {
        parts.push(tail(state.text.trim(), 1400));
      }
    } else {
      if (!log && state.thinking.trim()) {
        parts.push(`🤔 _${firstSentence(state.thinking.trim())}_`);
      }
      // Live harmony preamble: text of an in-flight message that already
      // started a tool call streams into the tail, then moves into the log
      // at message_end. Final-answer text never has a toolCall → never
      // streamed here, never duplicated above the answer below.
      if (state.msgHasToolCall && state.text.trim()) {
        parts.push(tail(state.text.trim(), 1400));
      }
    }
    return parts.join('\n');
  };
  let body = build();
  // Discord hard cap: evict OLDEST log lines first so the live tail (newest
  // activity) stays visible, Hermes-style.
  while (body.length + 40 > COMMENTARY_MAX && entries.length > 1) {
    entries.shift();
    body = build();
  }
  return body ? `${body}\n-# ⏳ working — ${formatElapsed(state)}` : '⏳ Working…';
}

function tail(text: string, max: number): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}

/**
 * Post the placeholder message. Returns a handle; handle.message is null when
 * the placeholder could not be created (streaming silently disabled).
 */
export async function startStreamMessage(jid: string): Promise<StreamHandle> {
  const handle: StreamHandle = {
    jid,
    message: null,
    state: createStreamState(),
    lastEdit: 0,
    lastContent: '',
    editing: false,
    needsFlush: false,
    timer: undefined,
  };
  try {
    const channel = await fetchChannel(jid);
    if (channel) {
      handle.message = await channel.send({
        content: '⏳ Working…',
        allowedMentions: { parse: [] },
      });
    }
  } catch (err: any) {
    logger.warn(
      { jid, err: err?.message },
      'Streaming placeholder failed; will use single-shot response',
    );
  }
  return handle;
}

/** Feed one pi event into the handle (fire-and-forget safe). */
export async function pushStreamEvent(handle: StreamHandle, event: PiEvent): Promise<void> {
  try {
    applyEvent(handle.state, event);
    scheduleFlush(handle);
  } catch {
    // Never let a bad event break processing.
  }
}

function clearTimer(handle: StreamHandle): void {
  if (handle.timer !== undefined) {
    clearTimeout(handle.timer);
    handle.timer = undefined;
  }
}

function scheduleFlush(handle: StreamHandle): void {
  if (handle.done) return;
  if (handle.editing) {
    handle.needsFlush = true;
    return;
  }
  if (handle.timer !== undefined) return;
  const minInterval = config.streamingUpdateMs || MIN_EDIT_INTERVAL_MS_DEFAULT;
  const wait = Math.max(0, handle.lastEdit + minInterval - Date.now());
  handle.timer = setTimeout(() => {
    handle.timer = undefined;
    void flushNow(handle);
  }, wait);
}

async function flushNow(handle: StreamHandle): Promise<void> {
  if (!handle.message || handle.done || handle.flushInFlight) return;
  let reschedule = false;
  const run = (async () => {
    handle.editing = true;
    try {
      do {
        if (handle.done) break;
        handle.needsFlush = false;
        const content = renderCommentary(handle.state);
        if (content !== handle.lastContent) {
          await handle.message!.edit({
            content: content.slice(0, COMMENTARY_MAX),
            allowedMentions: { parse: [] },
          });
          handle.lastContent = content;
          handle.lastEdit = Date.now();
        }
        if (handle.needsFlush) {
          const minInterval = config.streamingUpdateMs || MIN_EDIT_INTERVAL_MS_DEFAULT;
          if (Date.now() - handle.lastEdit < minInterval || handle.done) {
            reschedule = true; // scheduleFlush is a no-op while editing=true
            break;
          }
        }
      } while (handle.needsFlush && !handle.done);
    } catch (err: any) {
      logger.debug({ jid: handle.jid, err: err?.message }, 'Streaming edit failed (continuing)');
    } finally {
      handle.editing = false;
      if (reschedule && !handle.done) {
        scheduleFlush(handle); // now that editing is false this actually arms the timer
      }
    }
  })();
  handle.flushInFlight = run;
  run
    .catch(() => undefined)
    .finally(() => {
      if (handle.flushInFlight === run) handle.flushInFlight = undefined;
    });
  await run;
}

/**
 * Remove trailing log entries that duplicate the final answer:
 * in tools mode the final assistant message's text blocks get pushed to the
 * log as if they were interstitial commentary; the answer must not appear
 * twice.
 *
 * Matching, walking backwards over the trailing text entries:
 * - complete entries must be a suffix of the (remaining) answer;
 * - truncated entries (condense() cut them at 500 chars and appended '…')
 *   are a PREFIX of their block: they match at the block's START, so the
 *   FIRST occurrence (indexOf) — the last one would land inside repeated
 *   content within the same block. The common single-block >500 answer ends
 *   up here, and a plain startsWith/endsWith check would miss it.
 */
export function stripDuplicateTail(state: StreamState, final?: string): void {
  if (!final) return;
  let remaining = final.replace(/\s+/gu, ' ').trim();
  while (state.log.length > 0) {
    const last = state.log[state.log.length - 1];
    if (last.kind !== 'text') break;
    const truncated = /…$/u.test(last.text.trim());
    const probe = last.text.replace(/…+$/u, '').trim();
    if (!probe || !remaining) break;

    let consumed = false;
    if (truncated) {
      const idx = remaining.indexOf(probe);
      if (idx !== -1) {
        remaining = remaining.slice(0, idx).trim();
        consumed = true;
      }
    } else if (remaining.endsWith(probe)) {
      remaining = remaining.slice(0, remaining.length - probe.length).trim();
      consumed = true;
    }

    if (!consumed) break;
    state.log.pop();
  }
}

/**
 * Finish the stream, Hermes-style: the activity log REMAINS as its own
 * message (footer removed, final-answer duplicates stripped) and the final
 * answer is always delivered by the caller as a separate message below.
 */
export async function finalizeStream(handle: StreamHandle, finalText?: string): Promise<void> {
  handle.done = true;
  clearTimer(handle);
  // Wait for any in-flight flush so its edit cannot land after ours and
  // bury the final log under a stale "⏳ working" commentary.
  if (handle.flushInFlight) {
    await handle.flushInFlight.catch(() => undefined);
  }
  if (!handle.message) return;
  stripDuplicateTail(handle.state, (finalText ?? '').trim());
  const log = renderLog(handle.state);
  if (!log) {
    // Nothing worth keeping (text-only answer, no tools): drop placeholder.
    await deletePlaceholder(handle);
    return;
  }
  try {
    await handle.message.edit({
      content: log.slice(0, COMMENTARY_MAX),
      allowedMentions: { parse: [] },
    });
  } catch (err: any) {
    logger.warn({ jid: handle.jid, err: err?.message }, 'Final streaming edit failed');
    await deletePlaceholder(handle);
  }
}

/** Abort the stream: drop the placeholder (best-effort). */
export async function cancelStream(handle: StreamHandle): Promise<void> {
  handle.done = true;
  clearTimer(handle);
  if (handle.flushInFlight) {
    await handle.flushInFlight.catch(() => undefined);
  }
  await deletePlaceholder(handle);
}

async function deletePlaceholder(handle: StreamHandle): Promise<void> {
  if (!handle.message) return;
  try {
    await handle.message.delete();
  } catch {
    // best-effort
  }
  handle.message = null;
}
