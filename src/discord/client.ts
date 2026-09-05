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
  // Fetched for every reply that reaches this point (channel registered and
  // policy-passing): either the trigger bypass needs it, or the message is
  // heading to the agent anyway and gets the [Reply to X] context tag.
  // Unregistered/non-triggered messages never get here — zero wasted REST.
  let isReplyToBot = false;
  let replyPrefix = '';
  if (message.reference?.messageId) {
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
  // After the prefix concat: a bare `@bot` reply would otherwise become the
  // non-empty string "[Reply to Bot] " and trigger a full pi run on nothing.
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
      let sent = 0;
      try {
        for (const chunk of chunks) {
          await sendChunkWithRetry(textChannel, chunk);
          sent += 1;
        }
      } catch (err: any) {
        if (sent > 0) {
          // The user already received part of the answer — tell them it was
          // truncated instead of silently marking the message failed.
          await textChannel
            .send(`⚠️ Delivery interrupted: response truncated (${sent}/${chunks.length} parts).`)
            .catch(() => undefined);
        }
        throw err;
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

  const isLowSurrogate = (i: number) => /^[\uDC00-\uDFFF]/.test(remaining[i] ?? '');

  while (remaining.length > max) {
    // Try to split at last newline within limit
    let splitAt = remaining.lastIndexOf('\n', max);
    if (splitAt <= 0) splitAt = max; // hard split if no newline
    // Never cut a UTF-16 surrogate pair in half (would corrupt emoji).
    // splitAt pointing AT a low surrogate = cut between the pair's halves.
    // splitAt===1 with a pair at [0,1] can't step back to 0 (empty chunk,
    // infinite loop) — include the whole pair in the chunk instead.
    if (isLowSurrogate(splitAt)) {
      splitAt = splitAt > 1 ? splitAt - 1 : Math.min(2, remaining.length);
    }

    let chunk = remaining.slice(0, splitAt);
    let rest = remaining.slice(splitAt).replace(/^\n/, '');
    let fenceLines = chunk.match(/^```.*$/gm) ?? [];

    // Never cut a ``` fence in half: close it at the end of the chunk and
    // reopen it (same tag line) at the start of the next one. The closing
    // "\n```" needs 4 chars of budget, and the split must consume MORE than
    // the reopen prefix adds, or `remaining` would grow and loop forever
    // (degenerate case: the only newline nearby is the fence line itself).
    if (fenceLines.length % 2 === 1 && rest) {
      let openFence = fenceLines[fenceLines.length - 1] ?? '```';
      const minSplit = openFence.length + 2;
      if (chunk.length > max - 4 || splitAt < minSplit) {
        splitAt = max - 4;
        if (isLowSurrogate(splitAt)) {
          splitAt = splitAt > 1 ? splitAt - 1 : Math.min(2, remaining.length);
        }
        chunk = remaining.slice(0, splitAt);
        rest = remaining.slice(splitAt);
        fenceLines = chunk.match(/^```.*$/gm) ?? [];
        openFence = fenceLines[fenceLines.length - 1] ?? '```';
      }
      // Reopening costs openFence.length+1 chars of every subsequent
      // iteration. A fence line comparable to the cap shrinks progress to a
      // crawl (7 KB answer → thousands of 2 KB messages) or to zero (infinite
      // loop, OOM). Require the fence to be well under half the cap so each
      // pass consumes a useful chunk; otherwise leave the tail unfenced
      // (degraded rendering beats a flooded channel or a hung gateway).
      if (fenceLines.length % 2 === 1 && openFence.length + 1 < max / 2) {
        chunk = `${chunk}\n\u0060\u0060\u0060`;
        rest = `${openFence}\n${rest.replace(/^\n/, '')}`;
      }
    }

    if (rest.length >= remaining.length) {
      // Hard guarantee of forward progress, whatever the fence logic did.
      // Unreachable while the reopen threshold holds, but keep it surrogate-
      // safe in case the threshold ever changes.
      let cut = max;
      if (isLowSurrogate(cut)) cut = cut > 1 ? cut - 1 : Math.min(2, remaining.length);
      chunks.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut);
      continue;
    }

    chunks.push(chunk);
    remaining = rest;
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/** Send one chunk, retrying transient failures (429 / 5xx / network) with
 * bounded exponential backoff. Non-transient errors (400/403/…) fail fast: a
 * retry would just burn time and fail identically. allowedMentions parse:[]
 * keeps model-generated <@id>/<@&role>/@everyone from pinging anyone. */
export async function sendChunkWithRetry(
  textChannel: TextChannel | DMChannel,
  chunk: string,
): Promise<void> {
  const DELAYS = [1_000, 3_000, 8_000];
  for (let attempt = 0; ; attempt++) {
    try {
      await textChannel.send({ content: chunk, allowedMentions: { parse: [] } });
      return;
    } catch (err: any) {
      const status: unknown = err?.status;
      const transient =
        status === undefined || status === 429 || (typeof status === 'number' && status >= 500);
      if (!transient || attempt >= DELAYS.length) throw err;
      const reported: unknown = err?.timeToReset ?? err?.retryAfter;
      const wait = typeof reported === 'number' ? reported : DELAYS[attempt];
      const jitter = Math.random() * 250; // parallel chunks must not retry in sync
      logger.warn(
        { err: err?.message, status, waitMs: wait + jitter, attempt },
        'Chunk send failed, retrying',
      );
      await new Promise((resolve) => setTimeout(resolve, wait + jitter));
    }
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
