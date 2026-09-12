/**
 * Mention gate helpers.
 *
 * MEASURED against the live Discord API (2026-09-08, message from a real
 * user account with the mention inside a ~~~ fence and inside inline
 * backticks): the gateway `mentions` array INCLUDES users mentioned inside
 * code blocks. So both `message.mentions.users` and a raw content.includes()
 * over-trigger on echoed mention text (fenced `echo <@bot>`, quoted logs,
 * peers relaying text). The gate must strip code first, then match.
 */

/** Strip fenced code blocks (``` and ~~~) and inline code from a message body. */
export function stripCode(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/`[^`\n]*`/g, '');
}

/** True when <@botId> (or <@!botId>) appears OUTSIDE code blocks/inline code. */
export function contentHasMention(content: string, botId: string): boolean {
  return new RegExp(`<@!?${botId}>`).test(stripCode(content));
}
