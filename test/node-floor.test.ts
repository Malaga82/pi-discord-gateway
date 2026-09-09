import { describe, expect, it } from 'vitest';
import { MIN_NODE_VERSION, nodeVersionMeetsFloor } from '../src/util/node-floor.js';

describe('nodeVersionMeetsFloor', () => {
  it('accepts the floor itself and anything newer', () => {
    expect(nodeVersionMeetsFloor(MIN_NODE_VERSION)).toBe(true);
    expect(nodeVersionMeetsFloor('22.19.1')).toBe(true);
    expect(nodeVersionMeetsFloor('23.0.0')).toBe(true);
    expect(nodeVersionMeetsFloor('24.14.1')).toBe(true);
  });

  it('rejects versions below the floor', () => {
    expect(nodeVersionMeetsFloor('18.20.0')).toBe(false);
    expect(nodeVersionMeetsFloor('20.19.0')).toBe(false);
    expect(nodeVersionMeetsFloor('22.18.9')).toBe(false);
  });
});
