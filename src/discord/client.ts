/**
 * Discord channel adapter.
 *
 * Architecture borrowed from NanoClaw (https://github.com/qwibitai/nanoclaw).
 * Handles all Discord I/O: receiving messages, sending responses, typing indicators.
 * Contains zero business logic — that lives in the pi agent.
 */

import {
  Client,
  ChannelType,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  type Interaction,
  type Message,
  type DMChannel,
  type TextChannel,
} from 'discord.js';
import { handleThreadDeleted, registerIncomingThread, setThreadTransport } from './threads.js';
import { type RegisteredChannel } from '../types.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  createDmChannel,
  getChannel,
  registerChannel as dbRegisterChannel,
  enqueueMessage,
  isRoutingThread,
} from '../db.js';
import {
  buildAttachmentOnlyPrompt,
  selectAttachmentsWithinLimits,
  type AttachmentMeta,
} from './attachments.js';
import { handleAutocomplete, handleChatCommand, registerGlobalCommands } from './slash-commands.js';
import { contentHasMention } from './mention-gate.js';
import { deliverResponse, splitMessage, type DeliveryTransport } from './delivery.js';

export { splitMessage };

let client: Client | null = null;
let triggerPattern: RegExp;
let botId: string;
// Bot-peer loop guard: sliding window of message timestamps per "peerId:channelId"
const botPeerMsgTimes = new Map<string, number[]>();
let deliveryRest: REST | undefined;

export async function startDiscord(): Promise<void> {
  // The persisted delivery queue owns the retry budget for outbound answers.
  deliveryRest = new REST({
    version: '10',
    retries: 0,
    timeout: 10_000,
    rejectOnRateLimit: () => true,
  }).setToken(config.discordToken);
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

  client.on(Events.MessageCreate, (message) => {
    void handleMessage(message).catch((err) => logger.error({ err }, 'Message reception failed'));
  });
  client.on(Events.ThreadDelete, (thread) => handleThreadDeleted(thread.id));
  setThreadTransport({
    get: getThreadInfo,
    create: async (parentId, anchorId, name) => {
      const parent = (await deliveryRest!.get(Routes.channel(parentId))) as {
        default_auto_archive_duration?: number;
      };
      const thread = (await deliveryRest!.post(Routes.threads(parentId, anchorId), {
        body: { name, auto_archive_duration: parent.default_auto_archive_duration ?? 1440 },
      })) as RawThread;
      return threadInfo(thread);
    },
    sendAnchor: deliveryTransport.send,
    findAnchor: deliveryTransport.find,
  });
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
  // System notices (including ThreadCreated) are not user prompts.
  if (message.system) return;

  if (message.author.bot) {
    const peerAllowed =
      config.allowBotPeers.includes(message.author.id) && contentHasMention(message.content, botId);
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
    // MEASURED (live test 2026-09-08): Discord INCLUDES fenced/inline-code
    // mentions in message.mentions.users — so the collection alone triggers
    // on echoed text (a fenced `echo <@bot>`, a quoted log line). Gate on a
    // code-stripped content instead: only mentions outside code count.
    const isMentioned = contentHasMention(content, botId);

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
  let attachmentSelection: ReturnType<typeof selectAttachmentsWithinLimits> | undefined;
  if (message.attachments.size > 0) {
    const metas: AttachmentMeta[] = [...message.attachments.values()].map((att) => ({
      url: att.url,
      name: att.name || 'file',
      contentType: att.contentType || '',
      size: att.size || 0,
    }));

    attachmentSelection = selectAttachmentsWithinLimits(metas, {
      maxFileBytes: config.maxAttachmentBytes,
      maxTotalBytes: config.maxTotalAttachmentBytes,
    });

    acceptedAttachments = attachmentSelection.accepted;
    if (attachmentSelection.rejected.length > 0) {
      logger.info(
        {
          jid,
          skipped: attachmentSelection.rejected.map(({ attachment, reason, limitBytes }) => ({
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
  if (channel?.deletedAt) return;
  if (message.channel.isThread() && message.channel.parentId) {
    const parentId = message.channel.parentId;
    if (
      !channel &&
      (config.excludedChannels.has(channelId) || config.excludedChannels.has(parentId))
    )
      return;
    const managed = isRoutingThread(channelId);
    if (!channel && config.channelPolicy === 'allowlist' && !managed) return;
    channel = registerIncomingThread(
      jid,
      message.channel.name,
      parentId,
      channel,
      managed ? false : config.channelPolicy !== 'open',
    );
  }

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

  // Tell the channel about attachments dropped at the gate. Without this the
  // only trace was a server-side log: pi ran without the file (or the whole
  // attachment-only message silently vanished) and the user never knew.
  const skippedNotice = skippedAttachmentsNotice(attachmentSelection?.rejected ?? []);
  if (skippedNotice) {
    await message
      .reply({ content: skippedNotice, allowedMentions: { parse: [] } })
      .catch(() => undefined);
  }

  // ── Enqueue ──
  enqueueMessage({
    channelJid: jid,
    sender,
    senderName,
    content,
    timestamp,
    attachments: attachmentsJson,
    sourceMessageId: message.id,
    routeThread: !message.channel.isThread() && channel.threadMode === 'auto',
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

export async function sendResponse(
  jid: string,
  text: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!client) return false;

  try {
    const channelId = jid.replace(/^dc:/, '');
    const channel = await client.channels.fetch(channelId);
    if (!channel || !('send' in channel)) {
      logger.warn({ jid }, 'Channel not found or not text-based');
      return false;
    }

    const textChannel = channel as TextChannel | DMChannel;

    if (text.length <= DISCORD_MAX_LENGTH) {
      await sendChunkWithRetry(textChannel, text, signal);
    } else {
      // Split at line boundaries when possible
      const chunks = splitMessage(text, DISCORD_MAX_LENGTH);
      let sent = 0;
      try {
        for (const chunk of chunks) {
          await sendChunkWithRetry(textChannel, chunk, signal);
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

/** REST body for durable delivery sends. allowed_mentions parse:[] keeps
 * model-generated <@id>/<@&role>/@everyone from pinging anyone — without it
 * Discord applies default parsing and real users get pinged. */
export function buildDurableMessageBody(
  content: string,
  nonce: string,
): {
  content: string;
  nonce: string;
  enforce_nonce: boolean;
  allowed_mentions: { parse: string[] };
} {
  return { content, nonce, enforce_nonce: true, allowed_mentions: { parse: [] } };
}

/** User-facing notice for attachments rejected by the ingress size gate.
 * Returns undefined when nothing was rejected. */
export function skippedAttachmentsNotice(
  rejected: ReadonlyArray<{ attachment: { name: string } }>,
): string | undefined {
  if (rejected.length === 0) return undefined;
  const names = rejected.map(({ attachment }) => attachment.name).join(', ');
  return `⚠️ Skipped ${rejected.length} attachment(s) over the size limit: ${names}.`;
}

export const deliveryTransport: DeliveryTransport = {
  async send(jid, content, nonce) {
    if (!deliveryRest) throw new Error('Discord is not connected');
    const message = (await deliveryRest.post(Routes.channelMessages(jid.replace(/^dc:/, '')), {
      body: buildDurableMessageBody(content, nonce),
    })) as { id: string };
    return message.id;
  },
  async find(jid, nonce) {
    if (!deliveryRest) return undefined;
    const messages = (await deliveryRest.get(Routes.channelMessages(jid.replace(/^dc:/, '')), {
      query: new URLSearchParams({ limit: '100' }),
    })) as Array<{ id: string; nonce?: string; author: { id: string } }>;
    return messages.find((message) => message.author.id === botId && message.nonce === nonce)?.id;
  },
};

export function sendDurableResponse(rowid: number, signal: AbortSignal): Promise<boolean> {
  return deliverResponse(rowid, deliveryTransport, signal);
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

interface RawThread {
  id: string;
  name?: string;
  type: number;
  parent_id?: string;
}
function threadInfo(channel: RawThread) {
  return {
    id: channel.id,
    name: channel.name ?? 'Pi conversation',
    parentId: channel.parent_id,
    isThread: [
      ChannelType.PublicThread,
      ChannelType.PrivateThread,
      ChannelType.AnnouncementThread,
    ].includes(channel.type),
    textParent: channel.type === ChannelType.GuildText,
  };
}
async function getThreadInfo(id: string) {
  if (!deliveryRest) throw new Error('Discord is not connected');
  return threadInfo((await deliveryRest.get(Routes.channel(id))) as RawThread);
}

/** Send one chunk, retrying transient failures (429 / 5xx / network) with
 * bounded exponential backoff. Non-transient errors (400/403/…) fail fast: a
 * retry would just burn time and fail identically. allowedMentions parse:[]
 * keeps model-generated <@id>/<@&role>/@everyone from pinging anyone.
 * Abort-aware: a shutdown signal cuts the backoff short instead of holding
 * the channel through up to 12s of sleeps per chunk. */
export async function sendChunkWithRetry(
  textChannel: TextChannel | DMChannel,
  chunk: string,
  signal?: AbortSignal,
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
      if (!transient || attempt >= DELAYS.length || signal?.aborted) throw err;
      const reported: unknown = err?.timeToReset ?? err?.retryAfter;
      const wait = typeof reported === 'number' ? reported : DELAYS[attempt];
      const jitter = Math.random() * 250; // parallel chunks must not retry in sync
      logger.warn(
        { err: err?.message, status, waitMs: wait + jitter, attempt },
        'Chunk send failed, retrying',
      );
      // Interruptible sleep: an abort lands within the backoff window, not
      // after it — a shutdown must not wait out a full 8s sleep per chunk.
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, wait + jitter);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true },
        );
      });
      if (signal?.aborted) throw err; // stop mid-backoff, don't retry after abort
    }
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
