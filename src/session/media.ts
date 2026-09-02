/**
 * Media handling — download Discord attachments to disk for pi @file processing.
 *
 * The gateway acts as a pure relay: download to disk, pass path to pi via @file,
 * let pi decide how to handle each file type natively.
 * Periodic cleanup removes stale media files.
 */

import { createWriteStream, mkdirSync, readdirSync, rmSync, statSync, type Dirent } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { type AttachmentMeta } from '../discord/attachments.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { resolveChannelMediaMessageDir } from './path.js';

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

  const results: DownloadedFile[] = [];

  for (const [index, att] of attachments.entries()) {
    const safeName = sanitizeFilename(att.name || 'file');
    const fileName = index > 0 ? `${index}_${safeName}` : safeName;
    const filePath = join(mediaDir, fileName);

    try {
      await streamAttachmentToFile(att, filePath, signal);
      const fileStats = await stat(filePath);

      results.push({
        filePath,
        originalName: att.name || 'file',
        size: fileStats.size,
        contentType: att.contentType || 'application/octet-stream',
      });
      logger.debug(
        { name: att.name, size: fileStats.size, path: filePath },
        'Attachment downloaded',
      );
    } catch (err: any) {
      await rm(filePath, { force: true }).catch(() => undefined);
      logger.warn({ name: att.name, err: err.message }, 'Attachment download error');
    }
  }

  return results;
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
    const res = await fetch(attachment.url, { signal });

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
    const progress = new Transform({
      transform(chunk: Buffer, _enc, callback) {
        armStall();
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
      try {
        cleanupExpiredMedia();
      } catch (err: any) {
        logger.warn({ err: err.message }, 'Media cleanup error');
      }
    },
    30 * 60 * 1000,
  );

  return () => clearInterval(timer);
}

/** Remove media directories older than MEDIA_TTL_MS */
function cleanupExpiredMedia(): void {
  const now = Date.now();
  const ttlMs = mediaTtlMs();
  let cleaned = 0;

  // Depth bound: channel/media is depth 2, archived-channel/media is depth 3.
  // ponytail: the unbounded walk of the whole sessionsDir was linear in the
  // entire history; if channel layouts ever get deeper, iterate the
  // registered channel folders from the DB instead.
  for (const mediaRoot of findMediaRoots(config.sessionsDir, 3)) {
    try {
      const msgDirs = readdirSync(mediaRoot, { withFileTypes: true });
      for (const msgDir of msgDirs) {
        if (!msgDir.isDirectory() || !msgDir.name.startsWith('msg-')) continue;

        const dirPath = join(mediaRoot, msgDir.name);
        try {
          const st = statSync(dirPath);
          if (now - st.mtimeMs > ttlMs) {
            rmSync(dirPath, { recursive: true, force: true });
            cleaned++;
          }
        } catch {
          // Skip entries that disappear mid-scan.
        }
      }
    } catch {
      // Media root vanished mid-scan.
    }
  }

  if (cleaned > 0) {
    logger.info({ cleaned }, 'Cleaned up expired media directories');
  }
}

function findMediaRoots(dirPath: string, maxDepth = 3): string[] {
  if (maxDepth <= 0) return [];
  let entries: Dirent[];

  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
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

    mediaRoots.push(...findMediaRoots(entryPath, maxDepth - 1));
  }

  return mediaRoots;
}
