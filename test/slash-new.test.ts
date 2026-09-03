import { describe, expect, it, vi } from 'vitest';

const { isChannelProcessingMock, getChannelMock, clearPendingMock, rotateMock } = vi.hoisted(
  () => ({
    isChannelProcessingMock: vi.fn(),
    getChannelMock: vi.fn(),
    clearPendingMock: vi.fn(),
    rotateMock: vi.fn(),
  }),
);

vi.mock('../src/agent/queue.js', () => ({
  isChannelProcessing: isChannelProcessingMock,
  abortChannelTask: vi.fn(),
}));

vi.mock('../src/db.js', () => ({
  getChannel: getChannelMock,
  clearPendingMessages: clearPendingMock,
  createDmChannel: vi.fn(),
  registerChannel: vi.fn(),
  setChannelModelOverride: vi.fn(),
  setChannelThinkingOverride: vi.fn(),
  clearChannelModelOverride: vi.fn(),
}));

vi.mock('../src/session/path.js', () => ({
  rotateChannelSessionDir: rotateMock,
}));

function makeInteraction() {
  return {
    channelId: '42',
    guild: { id: 'g' },
    inGuild: () => true,
    user: { id: 'u1', username: 'tester' },
    options: { getSubcommand: () => 'new', getString: () => null },
    reply: vi.fn(async () => undefined),
  } as never;
}

const channel = {
  jid: 'dc:42',
  name: 'test',
  folder: 'ch_42',
  requiresTrigger: false,
  isMain: false,
  modelOverride: '',
  thinkingOverride: '',
  cwdOverride: '',
};

describe('handleNew processing guard', () => {
  it('refuses and does NOT rotate the session while the channel is processing', async () => {
    getChannelMock.mockReturnValue(channel);
    isChannelProcessingMock.mockReturnValue(true);

    const { handleNew } = await import('../src/discord/slash-commands.js');
    const interaction = makeInteraction();
    await handleNew(interaction);

    expect(interaction.reply).toHaveBeenCalledTimes(1);
    const payload = (interaction.reply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.content).toMatch(/currently processing/i);
    expect(rotateMock).not.toHaveBeenCalled();
    expect(clearPendingMock).not.toHaveBeenCalled();
  });

  it('proceeds (clear + rotate) when the channel is idle', async () => {
    getChannelMock.mockReturnValue(channel);
    isChannelProcessingMock.mockReturnValue(false);
    clearPendingMock.mockReturnValue(0);
    rotateMock.mockReturnValue('/tmp/archived');

    const { handleNew } = await import('../src/discord/slash-commands.js');
    const interaction = makeInteraction();
    await handleNew(interaction);

    expect(clearPendingMock).toHaveBeenCalledWith('dc:42');
    expect(rotateMock).toHaveBeenCalledWith('ch_42');
    expect(interaction.reply).toHaveBeenCalledTimes(1);
    const payload = (interaction.reply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.content).toContain('Started a fresh session');
  });
});
