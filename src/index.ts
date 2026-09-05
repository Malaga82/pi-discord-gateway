import { config } from './config.js';
import { logger } from './logger.js';
import { initDb, closeDb, getAllChannels } from './db.js';
import { startDiscord, stopDiscord, getBotTag } from './discord/client.js';
import { startArchiveCleanup } from './session/archive-cleanup.js';
import { startMediaCleanup } from './session/media.js';
import { refreshModelCatalogAsync } from './agent/model-catalog.js';
import { startProcessingLoop, stopProcessingLoop } from './agent/queue.js';
import { startScheduler } from './agent/scheduler.js';
import { acquireInstanceLock, releaseInstanceLock } from './single-instance.js';

/**
 * pi-discord-gateway - Lightweight Discord gateway for pi coding agent.
 *
 * Architecture inspired by NanoClaw (https://github.com/qwibitai/nanoclaw).
 * Discord messages -> SQLite queue -> pi subprocess -> Discord response.
 */
export async function startGateway(): Promise<void> {
  if (!config.discordToken) {
    throw new Error(
      'DISCORD_BOT_TOKEN is required. Set it in config.env, .env, or the environment.',
    );
  }

  // Lock before touching the DB: a second instance must not init/migrate
  // anything before losing the race.
  const lockPath = `${config.dbPath}.lock`;
  acquireInstanceLock(lockPath);
  initDb();

  let stopArchiveCleanup = () => {};
  let stopMediaCleanup = () => {};
  let stopScheduler = () => {};
  let processingStarted = false;
  let shutdownPromise: Promise<void> | null = null;

  let resolveSignalWait!: () => void;
  const signalWait = new Promise<void>((resolve) => {
    resolveSignalWait = resolve;
  });

  const onSignal = (sig: NodeJS.Signals) => {
    void shutdown(`received ${sig}`).then(resolveSignalWait, resolveSignalWait);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  if (process.platform === 'win32') {
    process.once('SIGBREAK', onSignal);
  }

  const shutdown = (reason: string) => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      if (process.platform === 'win32') {
        process.off('SIGBREAK', onSignal);
      }

      logger.info({ reason }, 'Shutting down gateway');

      stopScheduler();
      stopArchiveCleanup();
      stopMediaCleanup();

      if (processingStarted) {
        await stopProcessingLoop({ timeoutMs: config.shutdownTimeoutMs });
      }

      stopDiscord();
      closeDb();
      releaseInstanceLock(lockPath);
      logger.info('Gateway stopped');
    })();

    return shutdownPromise;
  };

  try {
    logger.info('Starting pi-discord-gateway...');
    // Async + parallel: no serial blocking spawnSync chain at startup.
    void warmModelCatalogs();

    await startDiscord();
    if (shutdownPromise) {
      await shutdownPromise;
      return;
    }

    startProcessingLoop();
    processingStarted = true;
    stopScheduler = startScheduler();
    stopArchiveCleanup = startArchiveCleanup();
    stopMediaCleanup = startMediaCleanup();

    logger.info(
      {
        bot: getBotTag(),
        trigger: `@${config.triggerName}`,
        concurrency: config.maxConcurrency,
        scheduledConcurrency: config.maxScheduledConcurrency,
        sessionsDir: config.sessionsDir,
      },
      'Gateway running',
    );

    await signalWait;
  } catch (err) {
    await shutdown('startup failure');
    throw err;
  }
}

async function warmModelCatalogs(): Promise<void> {
  const workingDirectories = new Set([
    config.piCwd,
    ...getAllChannels()
      .map((channel) => channel.cwdOverride)
      .filter(Boolean),
  ]);

  await Promise.all(
    [...workingDirectories].map(async (cwd) => {
      try {
        await refreshModelCatalogAsync(cwd);
        logger.info({ cwd }, 'Model catalog warmed');
      } catch (err: any) {
        logger.warn({ cwd, err: err?.message }, 'Failed to warm model catalog');
      }
    }),
  );
}
