import { describe, expect, it } from 'vitest';
import { contentHasMention, stripCode } from '../src/discord/mention-gate.js';

const BOT = '1543000708394127490';

describe('contentHasMention (live-tested semantics)', () => {
  it('ignores a mention inside a fenced block', () => {
    const content = `test\n\n~~~\n<@${BOT}>\n~~~\n\nriga inline: \`<@${BOT}>\``;
    expect(contentHasMention(content, BOT)).toBe(false);
  });

  it('ignores the real live-test message captured from Discord (2026-09-08)', () => {
    // Verbatim payload of the user message that confirmed hypothesis B:
    // mentions array contained the bot even though both mentions sit in code.
    const content =
      '`\ntest mention gate — riga 1\n\n~~~\n<@1543000708394127490>\n~~~\n\nriga inline: `<@1543000708394127490>`';
    expect(contentHasMention(content, '1543000708394127490')).toBe(false);
  });

  it('ignores a mention inside inline code', () => {
    expect(contentHasMention(`echo \`<@${BOT}>\``, BOT)).toBe(false);
  });

  it('triggers on a real mention outside code', () => {
    expect(contentHasMention(`ping <@${BOT}>`, BOT)).toBe(true);
    expect(contentHasMention(`<@!${BOT}> ciao`, BOT)).toBe(true);
  });

  it('triggers when a real mention coexists with an echoed one', () => {
    const content = `guarda: \`\`\`\n<@${BOT}>\n\`\`\`\` e ora <@${BOT}> davvero`;
    expect(contentHasMention(content, BOT)).toBe(true);
  });

  it('ignores a different user mention', () => {
    expect(contentHasMention('<@999>', BOT)).toBe(false);
  });

  it('stripCode removes fenced blocks and inline code but keeps prose', () => {
    expect(stripCode('a ```x``` b `y` c')).toBe('a  b  c');
  });
});
