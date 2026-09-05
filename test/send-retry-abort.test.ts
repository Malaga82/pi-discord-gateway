import { describe, expect, it } from 'vitest';
import { sendChunkWithRetry } from '../src/discord/client.js';

describe('sendChunkWithRetry abort handling', () => {
  it('abort during the backoff sleep cuts the wait short', async () => {
    const ac = new AbortController();
    const always503 = async () => {
      throw Object.assign(new Error('service unavailable'), { status: 503 });
    };
    const channel = { send: always503 };

    // Abort lands while the first (1s) backoff sleep is running.
    setTimeout(() => ac.abort(), 200);
    const start = Date.now();
    await expect(
      sendChunkWithRetry(
        channel as unknown as Parameters<typeof sendChunkWithRetry>[0],
        'x',
        ac.signal,
      ),
    ).rejects.toThrow();
    const elapsed = Date.now() - start;

    // Without the interruptible sleep this is ≥ 1000ms + jitter.
    expect(elapsed).toBeLessThan(900);
  });
});
