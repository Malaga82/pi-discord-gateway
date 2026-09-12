import { describe, expect, it } from 'vitest';
import { buildStatusMessage } from '../src/discord/slash-commands.js';
import type { EffectiveChannelSettings } from '../src/agent/channel-settings.js';

function fakeEffective(): EffectiveChannelSettings {
  return {
    rawModelRef: 'test/model',
    displayModel: 'test/model',
    modelInfo: undefined,
    modelSource: 'default',
    requestedThinking: 'default',
    effectiveThinking: 'default',
    hasManagedThinking: false,
    thinkingSource: 'pi runtime default',
    thinkingAdjusted: false,
    effectiveCwd: '/srv/secret/project',
    cwdSource: 'default',
  } as unknown as EffectiveChannelSettings;
}

const sessionStatus = { createdAt: new Date('2026-01-01T00:00:00Z').toISOString() };

describe('buildStatusMessage DM handling', () => {
  it('hides the working dir in DMs (host path must not leak)', () => {
    const text = buildStatusMessage(fakeEffective(), sessionStatus as never, { isDm: true });
    expect(text).not.toContain('/srv/secret/project');
    expect(text).not.toContain('Working dir');
    expect(text).toContain('Model');
  });

  it('keeps the working dir in guild channels', () => {
    const text = buildStatusMessage(fakeEffective(), sessionStatus as never, { isDm: false });
    expect(text).toContain('/srv/secret/project');
    expect(text).toContain('Working dir');
  });
});
