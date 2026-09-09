import { expect, it } from 'vitest';
import { ModelRegistry, ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';

// The gateway statically links these three exports (src/agent/model-catalog.ts).
// pi's peer range allows future versions; if one renames a symbol, this test
// goes red instead of the gateway failing to boot in production.
it('pi-coding-agent still exports the symbols model-catalog links against', () => {
  expect(typeof ModelRegistry).toBe('function');
  expect(typeof ModelRuntime).toBe('function');
  expect(typeof SettingsManager).toBe('function');
});
