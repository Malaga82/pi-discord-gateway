import { describe, expect, it } from 'vitest';
import { splitMessage } from '../src/discord/client.js';

function assertNoBrokenSurrogates(chunk: string): void {
  // No chunk may end with a lone high surrogate or start with a lone low one.
  expect(/[\uD800-\uDBFF]$/.test(chunk)).toBe(false);
  expect(/^[\uDC00-\uDFFF]/.test(chunk)).toBe(false);
}

describe('splitMessage', () => {
  it('does not split a surrogate pair at the hard-split boundary', () => {
    const text = 'a'.repeat(1999) + '😀' + 'b'.repeat(10);
    const chunks = splitMessage(text, 2000);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
      assertNoBrokenSurrogates(chunk);
    }
  });

  it('does not split a surrogate pair right after a newline boundary', () => {
    const text = 'x'.repeat(1998) + '\n😀' + 'y'.repeat(10);
    const chunks = splitMessage(text, 2000);

    // splitMessage drops the boundary newline by design.
    expect(chunks.join('')).toBe('x'.repeat(1998) + '😀' + 'y'.repeat(10));
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
      assertNoBrokenSurrogates(chunk);
    }
  });

  it('returns short texts untouched', () => {
    expect(splitMessage('hello 😀', 2000)).toEqual(['hello 😀']);
  });
});
