import { describe, expect, it } from 'vitest';
import { buildDurableMessageBody } from '../src/discord/client.js';

describe('durable message body', () => {
  it('always disables mention parsing (regression: durable path could ping)', () => {
    const body = buildDurableMessageBody('hello @everyone <@123> <@&456>', 'n-1');
    expect(body).toEqual({
      content: 'hello @everyone <@123> <@&456>',
      nonce: 'n-1',
      enforce_nonce: true,
      allowed_mentions: { parse: [] },
    });
  });
});

describe('skippedAttachmentsNotice', () => {
  it('returns undefined when nothing was rejected', async () => {
    const { skippedAttachmentsNotice } = await import('../src/discord/client.js');
    expect(skippedAttachmentsNotice([])).toBeUndefined();
  });

  it('lists skipped attachment names for the channel', async () => {
    const { skippedAttachmentsNotice } = await import('../src/discord/client.js');
    expect(
      skippedAttachmentsNotice([
        { attachment: { name: 'big.mov' } },
        { attachment: { name: 'huge.zip' } },
      ]),
    ).toBe('⚠️ Skipped 2 attachment(s) over the size limit: big.mov, huge.zip.');
  });
});
