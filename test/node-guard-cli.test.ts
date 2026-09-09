import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/util/node-floor.js', () => ({
  MIN_NODE_VERSION: '99.0.0',
  nodeVersionMeetsFloor: () => false,
}));

const { main } = await import('../src/cli/index.js');

describe('node floor guard (main entry)', () => {
  it('rejects before any command runs, naming floor and current version', async () => {
    await expect(main(['start'])).rejects.toThrow(
      /Node\.js >= 99\.0\.0 is required.*current version is \d+\.\d+\.\d+/s,
    );
  });

  it('guards help too — the entry links nothing but node:* and config', async () => {
    await expect(main(['help'])).rejects.toThrow('99.0.0');
  });
});
