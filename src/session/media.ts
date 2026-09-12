/**
 * Media handling — download Discord attachments to disk for pi @file processing.
 *
 * The gateway acts as a pure relay: download to disk, pass path to pi via @file,
 * let pi decide how to handle each file type natively.
 * Periodic cleanup removes stale media files.
 */

import { createWriteStream, mkdirSync, type Dirent } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { type AttachmentMeta } from '../discord/attachments.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { resolveChannelMediaMessageDir } from './path.js';
import { runPool } from '../util/run-pool.js';

/** Discord allows 10 attachments per message; 4 keeps a small board clear. */
const ATTACHMENT_CONCURRENCY = 4;

/** Attachment bytes come from Discord's CDN only — never follow a redirect to
 * a third-party host, and refuse URLs pointing elsewhere outright. */
const ALLOWED_ATTACHMENT_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

/** A successfully downloaded file */
export interface DownloadedFile {
  filePath: string;
  originalName: string;
  size: number;
  contentType: string;
}

/** Download stall timeout: aborts when NO data flows for this long (a slow
 * but flowing transfer is fine; a hung one is not). */
const DOWNLOAD_STALL_MS = 30_000;

/** Convert configured media retention to milliseconds. */
function mediaTtlMs(): number {
  return config.mediaRetentionHours * 60 * 60 * 1000;
}

/**
 * Download all attachments to a per-message directory under the channel session.
 * Returns the list of successfully downloaded files.
 */
export async function downloadAttachments(
  attachments: AttachmentMeta[],
  channelFolder: string,
  messageId: string,
  signal?: AbortSignal,
): Promise<DownloadedFile[]> {
  if (attachments.length === 0) return [];

  const mediaDir = resolveChannelMediaMessageDir(channelFolder, messageId);
  mkdirSync(mediaDir, { recursive: true });

  // Parallel with a cap: each download has a 30s stall watchdog, so n slow
  // attachments used to serialize into n×30s of channel lock. Order of the
  // result array stays = order of the message (buildAttachmentPathPrompt
  // lists the paths to the model — "the first file" must stay the first).
  const tasks = attachments.map((att, index) => async (): Promise<DownloadedFile | undefined> => {
    const safeName = sanitizeFilename(att.name || 'file');
    const fileName = index > 0 ? `${index}_${safeName}` : safeName;
    const filePath = join(mediaDir, fileName);

    try {
      await streamAttachmentToFile(att, filePath, signal);
      const fileStats = await stat(filePath);

      logger.debug(
        { name: att.name, size: fileStats.size, path: filePath },
        'Attachment downloaded',
      );
      return {
        filePath,
        originalName: att.name || 'file',
        size: fileStats.size,
        contentType: att.contentType || 'application/octet-stream',
      };
    } catch (err: any) {
      await rm(filePath, { force: true }).catch(() => undefined);
      logger.warn({ name: att.name, err: err.message }, 'Attachment download error');
      return undefined;
    }
  });

  const settled = await runPool(tasks, ATTACHMENT_CONCURRENCY);
  return settled.filter((r): r is DownloadedFile => r !== undefined);
}

/** Make filenames safe for the filesystem */
function sanitizeFilename(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
  // '.' and '..' survive the regex and would escape the media dir on join.
  if (sanitized === '.' || sanitized === '..') return 'file';
  return sanitized || 'file';
}

async function streamAttachmentToFile(
  attachment: AttachmentMeta,
  filePath: string,
  parentSignal?: AbortSignal,
): Promise<void> {
  const stallController = new AbortController();
  let stallTimer: NodeJS.Timeout | undefined;
  const armStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stallController.abort(new Error('attachment download stalled'));
    }, DOWNLOAD_STALL_MS);
    stallTimer.unref();
  };
  armStall();

  const signal = parentSignal
    ? AbortSignal.any([parentSignal, stallController.signal])
    : stallController.signal;

  try {
    const host = new URL(attachment.url).hostname;
    if (!ALLOWED_ATTACHMENT_HOSTS.has(host)) {
      throw new Error(`attachment host ${host} is not an allowed CDN`);
    }

    // redirect: 'error' — a CDN URL must not bounce us to arbitrary hosts.
    const res = await fetch(attachment.url, { signal, redirect: 'error' });

    if (!res.ok) {
      throw new Error(`Attachment download failed with status ${res.status}`);
    }

    if (!res.body) {
      throw new Error('Attachment download returned an empty body');
    }

    const body = Readable.fromWeb(res.body as any);
    // Progress watchdog as a transform stage: attaching a 'data' listener
    // would flip the stream to flowing mode before pipeline attaches, which
    // only works by accident when pipeline runs in the same tick.
    // Also the enforcement point of MAX_ATTACHMENT_BYTES: the config value
    // already existed — counting bytes here is what makes it real. 0 = off.
    const cap = config.maxAttachmentBytes;
    let total = 0;
    const progress = new Transform({
      transform(chunk: Buffer, _enc, callback) {
        armStall();
        if (cap > 0) {
          total += chunk.length;
          if (total > cap) {
            callback(new Error(`attachment exceeds MAX_ATTACHMENT_BYTES (${cap} bytes)`));
            return;
          }
        }
        callback(null, chunk);
      },
    });
    await pipeline(body, progress, createWriteStream(filePath), { signal });
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
  }
}

/** Start the periodic media cleanup timer */
export function startMediaCleanup(): () => void {
  // Run every 30 minutes
  const timer = setInterval(
    () => {
      cleanupExpiredMedia().catch((err: any) => {
        logger.warn({ err: err.message }, 'Media cleanup error');
      });
    },
    30 * 60 * 1000,
  );

  return () => clearInterval(timer);
}

/** Remove media directories older than MEDIA_TTL_MS */
async function cleanupExpiredMedia(): Promise<void> {
  const now = Date.now();
  const ttlMs = mediaTtlMs();
  let cleaned = 0;

  // Depth bound: channel/media is depth 2, archived-channel/media is depth 3.
  // ponytail: the unbounded walk of the whole sessionsDir was linear in the
  // entire history; if channel layouts ever get deeper, iterate the
  // registered channel folders from the DB instead.
  for (const mediaRoot of await findMediaRoots(config.sessionsDir, 3)) {
    let msgDirs;
    try {
      msgDirs = await readdir(mediaRoot, { withFileTypes: true });
    } catch {
      continue; // Media root vanished mid-scan.
    }
    for (const msgDir of msgDirs) {
      if (!msgDir.isDirectory() || !msgDir.name.startsWith('msg-')) continue;

      const dirPath = join(mediaRoot, msgDir.name);
      try {
        const st = await stat(dirPath);
        if (now - st.mtimeMs > ttlMs) {
          await rm(dirPath, { recursive: true, force: true });
          cleaned++;
        }
      } catch {
        // Skip entries that disappear mid-scan.
      }
    }
  }

  if (cleaned > 0) {
    logger.info({ cleaned }, 'Cleaned up expired media directories');
  }
}

async function findMediaRoots(dirPath: string, maxDepth = 3): Promise<string[]> {
  if (maxDepth <= 0) return [];
  let entries: Dirent[];

  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const mediaRoots: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const entryPath = join(dirPath, entry.name);
    if (entry.name === 'media') {
      mediaRoots.push(entryPath);
      continue;
    }

    mediaRoots.push(...(await findMediaRoots(entryPath, maxDepth - 1)));
  }

  return mediaRoots;
}
