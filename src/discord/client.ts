/**
 * Discord channel adapter.
 *
 * Architecture borrowed from NanoClaw (https://github.com/qwibitai/nanoclaw).
 * Handles all Discord I/O: receiving messages, sending responses, typing indicators.
 * Contains zero business logic — that lives in the pi agent.
 */

import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Interaction,
  type Message,
  type TextChannel,
  type DMChannel,
} from 'discord.js';
import { type RegisteredChannel } from '../types.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  createDmChannel,
  getChannel,
  registerChannel as dbRegisterChannel,
  enqueueMessage,
} from '../db.js';
import {
  buildAttachmentOnlyPrompt,
  selectAttachmentsWithinLimits,
  type AttachmentMeta,
} from './attachments.js';
import { handleAutocomplete, handleChatCommand, registerGlobalCommands } from './slash-commands.js';

let client: Client | null = null;
let triggerPattern: RegExp;
let botId: string;
// Bot-peer loop guard: sliding window of message timestamps per "peerId:channelId"
const botPeerMsgTimes = new Map<string, number[]>();

export async function startDiscord(): Promise<void> {
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    // Required for DM message events in discord.js.
    partials: [Partials.Channel],
  });

  client.on(Events.MessageCreate, handleMessage);
  client.on(Events.InteractionCreate, handleInteraction);
  client.on(Events.Error, (err) => logger.error({ err: err.message }, 'Discord client error'));

  return new Promise<void>((resolve, reject) => {
    const onReady = async (ready: Client<true>) => {
      cleanup();
      botId = ready.user.id;
      triggerPattern = new RegExp(`^@${escapeRegExp(config.triggerName)}\\b`, 'i');
      logger.info({ tag: ready.user.tag, id: botId }, 'Discord bot connected');

      try {
        await registerGlobalCommands(ready);
      } catch (err: any) {
        logger.error({ err: err.message }, 'Failed to register global slash commands');
      }

      resolve();
    };

    const onStartupError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const cleanup = () => {
      client?.off(Events.ClientReady, onReady);
      client?.off(Events.Error, onStartupError);
    };

    client!.once(Events.ClientReady, onReady);
    client!.once(Events.Error, onStartupError);
    client!.login(config.discordToken).catch(onStartupError);
  });
}

async function handleInteraction(interaction: Interaction): Promise<void> {
  try {
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction);
      return;
    }

    if (interaction.isChatInputCommand()) {
      await handleChatCommand(interaction);
    }
  } catch (err: any) {
    logger.error({ err: err.message, id: interaction.id }, 'Interaction handler failed');
  }
}

async function handleMessage(message: Message): Promise<void> {
  // Never react to our own messages (defensive: misconfigured ALLOW_BOT_PEERS
  // containing our own ID would otherwise create a self-loop).
  if (message.author.id === botId) return;

  // Bot-to-bot: accept whitelisted peer bots that @mention us (pattern: OpenClaw allowBots=mentions,
  // Hermes-agent DISCORD_ALLOW_BOTS=mentions). All other bot messages are ignored as upstream.
  if (message.author.bot) {
    const peerAllowed =
      config.allowBotPeers.includes(message.author.id) &&
      (message.mentions.users.has(botId) ||
        message.content.includes(`<@${botId}>`) ||
        message.content.includes(`<@!${botId}>`));
    if (!peerAllowed) return;
    // Loop guard: sliding window per (peer, channel). Dropped messages are NOT
    // recorded — otherwise a peer retrying after a legitimate loop end would
    // keep tripping the ban until it stays silent for a full window.
    const guardKey = `${message.author.id}:${message.channelId}`;
    const now = Date.now();
    const peerTimes = recordBotPeerMessage(botPeerMsgTimes.get(guardKey), now, {
      max: config.botLoopMax,
      windowMs: config.botLoopWindowMs,
    });
    // ponytail: opportunistic sweep instead of a periodic timer — bounds the map
    // when many peer×channel keys accumulate.
    if (botPeerMsgTimes.size > 1000) {
      for (const [key, stamps] of botPeerMsgTimes) {
        if (!stamps.some((t) => now - t < config.botLoopWindowMs)) {
          botPeerMsgTimes.delete(key);
        }
      }
    }
    if (!peerTimes.accepted) {
      logger.warn(
        { guardKey, count: peerTimes.times.length, windowMs: config.botLoopWindowMs },
        'Bot-peer loop guard tripped, dropping message',
      );
      return;
    }
    botPeerMsgTimes.set(guardKey, peerTimes.times);
    logger.info(
      { peer: message.author.username, id: message.author.id, jid: `dc:${message.channelId}` },
      'Accepted bot-peer message',
    );
  }

  const isDM = !message.guild;
  const channelId = message.channelId;
  const jid = `dc:${channelId}`;

  // ── Build content ──
  let content = message.content;
  const senderName =
    message.member?.displayName || message.author.displayName || message.author.username;
  const sender = message.author.id;
  const timestamp = message.createdAt.toISOString();

  // Translate @bot mentions → trigger format
  if (client?.user) {
    const isMentioned =
      message.mentions.users.has(botId) ||
      content.includes(`<@${botId}>`) ||
      content.includes(`<@!${botId}>`);

    if (isMentioned) {
      content = content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
      if (!triggerPattern.test(content)) {
        content = `@${config.triggerName} ${content}`;
      }
    }
  }

  // Attachments → extract metadata for downstream download
  let acceptedAttachments: AttachmentMeta[] = [];
  let attachmentsJson: string | null = null;
  if (message.attachments.size > 0) {
    const metas: AttachmentMeta[] = [...message.attachments.values()].map((att) => ({
      url: att.url,
      name: att.name || 'file',
      contentType: att.contentType || '',
      size: att.size || 0,
    }));

    const selection = selectAttachmentsWithinLimits(metas, {
      maxFileBytes: config.maxAttachmentBytes,
      maxTotalBytes: config.maxTotalAttachmentBytes,
    });

    acceptedAttachments = selection.accepted;
    if (selection.rejected.length > 0) {
      logger.info(
        {
          jid,
          skipped: selection.rejected.map(({ attachment, reason, limitBytes }) => ({
            name: attachment.name,
            size: attachment.size,
            reason,
            limitBytes,
          })),
        },
        'Skipped oversized Discord attachments before enqueue',
      );
    }

    if (acceptedAttachments.length > 0) {
      attachmentsJson = JSON.stringify(acceptedAttachments);
    }
  }

  // ── Trigger pre-check (cheap, no REST) ──
  const hasTrigger = triggerPattern.test(content);

  // ── Channel registration check ── (before the reply fetch: unregistered
  // channels and non-triggered messages must not cost a REST call each)
  let channel = getChannel(jid);

  // Auto-register DMs
  if (!channel && isDM && config.autoRegisterDMs) {
    const reg = createDmChannel(jid, sender, senderName);
    dbRegisterChannel(reg);
    channel = reg;
    logger.info({ jid, senderName }, 'Auto-registered DM channel');
  }

  // Auto-register guild channels based on policy
  if (!channel && !isDM && config.channelPolicy !== 'allowlist') {
    if (config.excludedChannels.has(channelId)) {
      return;
    }

    const guildName = message.guild?.name || 'Unknown';
    const channelName = (message.channel as TextChannel).name || 'unknown';
    const name = `${guildName} #${channelName}`;
    const reg: RegisteredChannel = {
      jid,
      name,
      folder: `ch_${channelId}`,
      requiresTrigger: config.channelPolicy === 'open-trigger',
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    };
    dbRegisterChannel(reg);
    channel = reg;
    logger.info({ jid, name, policy: config.channelPolicy }, 'Auto-registered guild channel');
  }

  if (!channel) {
    logger.debug({ jid }, 'Message from unregistered channel, ignoring');
    return;
  }

  // ── Reply context ──
  // Fetched only when it can change the outcome (trigger bypass for a reply
  // to the bot) or when the message is heading to the agent anyway (context
  // tag). Unregistered channels and non-triggered messages skip the REST call.
  let isReplyToBot = false;
  let replyPrefix = '';
  if (
    (channel.requiresTrigger && !hasTrigger && message.reference?.messageId) ||
    (!channel.requiresTrigger && message.reference?.messageId)
  ) {
    try {
      const ref = await message.channel.messages.fetch(message.reference.messageId);
      isReplyToBot = ref.author?.id === botId;
      const refAuthor = ref.member?.displayName || ref.author.displayName || ref.author.username;
      replyPrefix = `[Reply to ${refAuthor}] `;
    } catch {
      // deleted message
    }
  }

  // Replying to a bot message counts as a trigger (conversation continuation)
  if (channel.requiresTrigger && !isReplyToBot && !hasTrigger) {
    logger.debug({ jid }, 'Message does not match trigger, ignoring');
    return;
  }

  // Strip trigger prefix from content sent to agent (before the reply prefix,
  // so the trigger stays anchored at the start of the original content)
  content = content.replace(triggerPattern, '').trim();
  if (!content && acceptedAttachments.length > 0) {
    content = buildAttachmentOnlyPrompt(acceptedAttachments.length);
  }
  if (replyPrefix) {
    content = `${replyPrefix}${content}`;
  }
  if (!content) return;

  // ── Enqueue ──
  enqueueMessage({
    channelJid: jid,
    sender,
    senderName,
    content,
    timestamp,
    attachments: attachmentsJson,
  });
  logger.info({ jid, sender: senderName, len: content.length }, 'Message enqueued');
}

/**
 * Bot-peer loop guard, pure: keep timestamps inside the sliding window and
 * decide whether this message is accepted. Only accepted messages are
 * recorded, so the ban cannot self-aliment while the peer keeps talking.
 */
export function recordBotPeerMessage(
  times: number[] | undefined,
  now: number,
  cfg: { max: number; windowMs: number },
): { times: number[]; accepted: boolean } {
  const kept = (times ?? []).filter((t) => now - t < cfg.windowMs);
  if (cfg.max > 0 && kept.length >= cfg.max) {
    return { times: kept, accepted: false };
  }
  kept.push(now);
  return { times: kept, accepted: true };
}

// ── Outbound ──

const DISCORD_MAX_LENGTH = 2000;

export async function sendResponse(jid: string, text: string): Promise<boolean> {
  if (!client) return false;

  const channelId = jid.replace(/^dc:/, '');

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !('send' in channel)) {
      logger.warn({ jid }, 'Channel not found or not text-based');
      return false;
    }

    const textChannel = channel as TextChannel | DMChannel;

    if (text.length <= DISCORD_MAX_LENGTH) {
      await sendChunkWithRetry(textChannel, text);
    } else {
      // Split at line boundaries when possible
      const chunks = splitMessage(text, DISCORD_MAX_LENGTH);
      for (const chunk of chunks) {
        await sendChunkWithRetry(textChannel, chunk);
      }
    }
    logger.info({ jid, length: text.length }, 'Response sent');
    return true;
  } catch (err: any) {
    logger.error({ jid, err: err.message }, 'Failed to send message');
    return false;
  }
}

export async function setTyping(jid: string): Promise<void> {
  if (!client) return;
  try {
    const channelId = jid.replace(/^dc:/, '');
    const channel = await client.channels.fetch(channelId);
    if (channel && 'sendTyping' in channel) {
      await (channel as TextChannel).sendTyping();
    }
  } catch {
    // best-effort
  }
}

/** Resolve a text channel by jid; undefined when unavailable (best-effort, never throws). */
export async function fetchChannel(jid: string): Promise<TextChannel | undefined> {
  if (!client) return undefined;
  const channelId = jid.replace(/^dc:/, '');
  try {
    const channel = await client.channels.fetch(channelId);
    return channel && 'send' in channel ? (channel as TextChannel) : undefined;
  } catch {
    return undefined;
  }
}

export function stopDiscord(): void {
  if (client) {
    client.destroy();
    client = null;
    logger.info('Discord bot stopped');
  }
}

export function getBotTag(): string | undefined {
  return client?.user?.tag;
}

// ── Helpers ──

export function splitMessage(text: string, max: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > max) {
    // Try to split at last newline within limit
    let splitAt = remaining.lastIndexOf('\n', max);
    if (splitAt <= 0) splitAt = max; // hard split if no newline
    // Never cut a UTF-16 surrogate pair in half (would corrupt emoji).
    if (splitAt > 1 && /^[\uDC00-\uDFFF]/.test(remaining[splitAt] ?? '')) {
      splitAt -= 1;
    }
    let chunk = remaining.slice(0, splitAt);
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
    // Never cut a ``` fence in half: close it at the end of the chunk and
    // reopen it at the start of the next one.
    const openFences = (chunk.match(/^```/gm) ?? []).length;
    if (openFences % 2 === 1 && remaining) {
      chunk = `${chunk}\n\u0060\u0060\u0060`;
      remaining = `\u0060\u0060\u0060${remaining}`;
    }
    chunks.push(chunk);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/** Send one chunk, retrying once after a short pause (rate-limit recovery). */
async function sendChunkWithRetry(
  textChannel: TextChannel | DMChannel,
  chunk: string,
): Promise<void> {
  try {
    await textChannel.send(chunk);
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'Chunk send failed once, retrying after pause');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await textChannel.send(chunk);
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
