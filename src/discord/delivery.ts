import {
  beginChunk,
  finishChunk,
  getQueuedMessage,
  getResponseChunks,
  retryDelivery,
  resetUnsentChunk,
  setMessageState,
  type ResponseChunk,
} from '../db.js';

export interface DeliveryTransport {
  send(jid: string, content: string, nonce: string): Promise<string>;
  find(jid: string, nonce: string): Promise<string | undefined>;
}

export async function deliverResponse(
  rowid: number,
  transport: DeliveryTransport,
  signal: AbortSignal,
): Promise<boolean> {
  const message = getQueuedMessage(rowid);
  if (!message || message.status !== 'delivering') return false;
  for (const chunk of getResponseChunks(rowid)) {
    if (chunk.status === 'sent') continue;
    if (signal.aborted || getQueuedMessage(rowid)?.status !== 'delivering') return false;
    try {
      const previous =
        chunk.status === 'sending'
          ? await transport.find(message.channel_jid, chunk.nonce).catch(() => undefined)
          : undefined;
      if (previous) {
        finishChunk(rowid, chunk.part, previous);
        continue;
      }
      if (signal.aborted || getQueuedMessage(rowid)?.status !== 'delivering') return false;
      if (isUncertainChunk(chunk)) {
        setMessageState(
          rowid,
          'delivery_uncertain',
          `Delivery of task #${rowid} could not be confirmed. The saved answer is available with piscord result ${rowid}; the task will not run again.`,
        );
        return false;
      }
      if (signal.aborted) return false;
      beginChunk(rowid, chunk.part);
      const id = await transport.send(message.channel_jid, chunk.content, chunk.nonce);
      finishChunk(rowid, chunk.part, id);
    } catch (error) {
      // A late network result must not overwrite /stop or shutdown state.
      if (signal.aborted || getQueuedMessage(rowid)?.status !== 'delivering') return false;
      const failure = error as { status?: number; name?: string; timeToReset?: number };
      const status = failure.status;
      const rateLimited = status === 429 || failure.name === 'RateLimitError';
      if (rateLimited || (status && status >= 400 && status < 500))
        resetUnsentChunk(rowid, chunk.part);
      if (status && status >= 400 && status < 500 && status !== 429) {
        setMessageState(
          rowid,
          'delivery_failed',
          `Could not deliver task #${rowid} (Discord ${status}). Its answer was saved; use piscord result ${rowid}.`,
        );
      } else if ((getQueuedMessage(rowid)?.delivery_attempts ?? 0) >= 2) {
        setMessageState(
          rowid,
          'delivery_uncertain',
          `Delivery of task #${rowid} failed after retries. Its answer was saved; use piscord result ${rowid}. Check Discord before sending it again.`,
        );
      } else {
        const delay =
          rateLimited && Number.isFinite(failure.timeToReset)
            ? Math.max(1_000, Math.min(failure.timeToReset! + 500, 300_000))
            : 5_000;
        retryDelivery(rowid, delay);
      }
      return false;
    }
  }
  return !signal.aborted && getQueuedMessage(rowid)?.status === 'delivering';
}

// Discord only promises nonce deduplication for the past few minutes.
export function isUncertainChunk(chunk: ResponseChunk): boolean {
  return (
    chunk.status === 'sending' && (!chunk.sending_at || Date.now() - chunk.sending_at > 120_000)
  );
}

export function splitMessage(text: string, max: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  const isLowSurrogate = (i: number) => /^[\uDC00-\uDFFF]/.test(remaining[i] ?? '');

  while (remaining.length > max) {
    // Try to split at last newline within limit
    let splitAt = remaining.lastIndexOf('\n', max);
    if (splitAt <= 0) splitAt = max; // hard split if no newline
    // Never cut a UTF-16 surrogate pair in half (would corrupt emoji).
    // splitAt pointing AT a low surrogate = cut between the pair's halves.
    // splitAt===1 with a pair at [0,1] can't step back to 0 (empty chunk,
    // infinite loop) — include the whole pair in the chunk instead.
    if (isLowSurrogate(splitAt)) {
      splitAt = splitAt > 1 ? splitAt - 1 : Math.min(2, remaining.length);
    }

    let chunk = remaining.slice(0, splitAt);
    let rest = remaining.slice(splitAt).replace(/^\n/, '');
    let fenceLines = chunk.match(/^```.*$/gm) ?? [];

    // Never cut a ``` fence in half: close it at the end of the chunk and
    // reopen it (same tag line) at the start of the next one. The closing
    // "\n```" needs 4 chars of budget, and the split must consume MORE than
    // the reopen prefix adds, or `remaining` would grow and loop forever
    // (degenerate case: the only newline nearby is the fence line itself).
    if (fenceLines.length % 2 === 1 && rest) {
      let openFence = fenceLines[fenceLines.length - 1] ?? '```';
      const minSplit = openFence.length + 2;
      if (chunk.length > max - 4 || splitAt < minSplit) {
        splitAt = max - 4;
        if (isLowSurrogate(splitAt)) {
          splitAt = splitAt > 1 ? splitAt - 1 : Math.min(2, remaining.length);
        }
        chunk = remaining.slice(0, splitAt);
        rest = remaining.slice(splitAt);
        fenceLines = chunk.match(/^```.*$/gm) ?? [];
        openFence = fenceLines[fenceLines.length - 1] ?? '```';
      }
      // Reopening costs openFence.length+1 chars of every subsequent
      // iteration. A fence line comparable to the cap shrinks progress to a
      // crawl (7 KB answer → thousands of 2 KB messages) or to zero (infinite
      // loop, OOM). Require the fence to be well under half the cap so each
      // pass consumes a useful chunk; otherwise leave the tail unfenced
      // (degraded rendering beats a flooded channel or a hung gateway).
      if (fenceLines.length % 2 === 1 && openFence.length + 1 < max / 2) {
        chunk = `${chunk}\n\u0060\u0060\u0060`;
        rest = `${openFence}\n${rest.replace(/^\n/, '')}`;
      }
    }

    if (rest.length >= remaining.length) {
      // Hard guarantee of forward progress, whatever the fence logic did.
      // Unreachable while the reopen threshold holds, but keep it surrogate-
      // safe in case the threshold ever changes.
      let cut = max;
      if (isLowSurrogate(cut)) cut = cut > 1 ? cut - 1 : Math.min(2, remaining.length);
      chunks.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut);
      continue;
    }

    chunks.push(chunk);
    remaining = rest;
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
