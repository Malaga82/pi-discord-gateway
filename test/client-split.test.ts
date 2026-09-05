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

  it('never splits a surrogate pair even at degenerate max sizes', () => {
    // Pair at index [0,1], split candidate at 1 would orphan the high half.
    expect(splitMessage('😀b', 1)).toEqual(['😀', 'b']);
  });

  it('closes and reopens ``` fences cut by a hard split, within the length budget, preserving the language tag', () => {
    const text = '```js\n' + 'x'.repeat(6000) + '\n```\n';
    const chunks = splitMessage(text, 2000);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000); // never bust Discord's limit
      const fences = (chunk.match(/^```/gm) ?? []).length;
      expect(fences % 2).toBe(0); // balanced fences in every chunk
    }
    // The reopened fence carries the original language tag.
    expect(chunks[1].startsWith('```js\n')).toBe(true);
    // Content survives reassembly (modulo added fences).
    const reassembled = chunks.join('').replace(/```js\n|\n?```/g, '');
    expect(reassembled.replace(/\s+/g, '')).toBe('x'.repeat(6000));
  });

  it('terminates (no amplification) when a fence line is nearly as long as the cap', () => {
    // Regression: a 1996+ char fence line made the reopen step eat the whole
    // progress budget — infinite loop and OOM. The tail may flow unfenced.
    for (const fenceLen of [1988, 1993, 1995, 1996, 1999, 2103]) {
      const text = '```' + 'a'.repeat(fenceLen - 3) + '\n' + 'x'.repeat(1050);
      const chunks = splitMessage(text, 2000);
      expect(chunks.length).toBeLessThanOrEqual(3);
      const reassembled = chunks.join('');
      for (const ch of text) {
        expect(reassembled).toContain(ch === '\n' ? '\n' : ch);
      }
      // No character loss: total content length preserved (minus at most the
      // boundary newlines the splitter is allowed to drop).
      expect(reassembled.replace(/\n/g, '').length).toBeGreaterThanOrEqual(
        text.replace(/\n/g, '').length - 2,
      );
    }
  });

  it('always makes progress on pathological inputs (hard-split fallback)', () => {
    // Single line, no newline at all, longer than max → plain hard split.
    const text = 'y'.repeat(5000);
    const chunks = splitMessage(text, 2000);
    expect(chunks.join('')).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });
});
