import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { AttachmentBuilder, Client, GatewayIntentBits } from 'discord.js';
import { config } from '../config.js';

export interface SendRequest {
  channelJid: string;
  text?: string;
  files: string[];
}

export function normalizeChannelJid(input: string): string {
  const value = input.trim();
  return value.startsWith('dc:') ? value : `dc:${value}`;
}

export function validateSendRequest(
  request: SendRequest,
  options: {
    maxAttachmentBytes: number;
    maxTotalBytes?: number;
    fileStat: (path: string) => { size: number };
  },
): void {
  const hasText = Boolean(request.text?.trim());

  if (!hasText && request.files.length === 0) {
    throw new Error('Either text or at least one file is required.');
  }

  if (request.files.length > 10) {
    throw new Error('At most 10 files can be sent in a single message.');
  }

  let totalBytes = 0;
  for (const filePath of request.files) {
    let file;

    try {
      file = options.fileStat(filePath);
    } catch {
      throw new Error(`File not found: ${filePath}`);
    }

    if (options.maxAttachmentBytes > 0 && file.size > options.maxAttachmentBytes) {
      throw new Error(
        `File exceeds max attachment size (${options.maxAttachmentBytes} bytes): ${filePath}`,
      );
    }
    totalBytes += file.size;
  }

  // Same total cap the ingress path enforces: without it 10 files just under
  // the per-file limit all passed validation (and used to be read fully into
  // the heap below).
  const maxTotalBytes = options.maxTotalBytes ?? 0;
  if (maxTotalBytes > 0 && totalBytes > maxTotalBytes) {
    throw new Error(
      `Total attachment size exceeds max (${maxTotalBytes} bytes): ${totalBytes} bytes requested.`,
    );
  }
}

export async function sendFilesToDiscord(request: SendRequest): Promise<{ sentFiles: number }> {
  validateSendRequest(request, {
    maxAttachmentBytes: config.maxAttachmentBytes,
    maxTotalBytes: config.maxTotalAttachmentBytes,
    fileStat: (filePath) => statSync(filePath),
  });

  const channelJid = normalizeChannelJid(request.channelJid);
  const channelId = channelJid.slice(3);
  // AttachmentBuilder accepts a path and streams on send: reading every file
  // into memory first put the whole payload in the heap at once.
  const attachments = request.files.map(
    (filePath) => new AttachmentBuilder(filePath, { name: basename(filePath) }),
  );

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  try {
    await client.login(config.discordToken);
    const channel = await client.channels.fetch(channelId);

    if (!channel || !channel.isTextBased() || !('send' in channel)) {
      throw new Error(`Channel not found or not text-based: ${channelJid}`);
    }

    await channel.send({
      content: request.text || undefined,
      allowedMentions: { parse: [] },
      ...(attachments.length > 0 ? { files: attachments } : {}),
    });
    return { sentFiles: attachments.length };
  } finally {
    client.destroy();
  }
}
