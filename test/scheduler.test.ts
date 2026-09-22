import { describe, expect, it, vi } from 'vitest';

const originalDbPath = process.env.DB_PATH;

describe('computeNextRun', () => {
  it('returns a future date for a cron expression', async () => {
    vi.resetModules();
    const { computeNextRun } = await import('../src/agent/scheduler.js');

    const nextRun = computeNextRun('* * * * *', 'recurring');

    expect(nextRun).not.toBeNull();
    expect(new Date(nextRun ?? '').getTime()).toBeGreaterThan(Date.now());
  });

  it('returns null for a past ISO one-time schedule', async () => {
    vi.resetModules();
    const { computeNextRun } = await import('../src/agent/scheduler.js');

    const nextRun = computeNextRun(new Date(Date.now() - 60_000).toISOString(), 'once');

    expect(nextRun).toBeNull();
  });

  it('returns the original future ISO one-time schedule', async () => {
    vi.resetModules();
    const { computeNextRun } = await import('../src/agent/scheduler.js');
    const futureIso = new Date(Date.now() + 60_000).toISOString();

    const nextRun = computeNextRun(futureIso, 'once');

    expect(nextRun).toBe(futureIso);
  });
});

describe('scheduled task db helpers', () => {
  it('adds, lists, and removes scheduled tasks in an in-memory database', async () => {
    process.env.DB_PATH = ':memory:';
    vi.resetModules();

    const db = await import('../src/db.js');
    db.initDb();

    try {
      const id = db.addScheduledTask({
        name: 'Daily summary',
        type: 'recurring',
        schedule: '* * * * *',
        channelJid: 'dc:123',
        prompt: 'post summary',
        createdBy: 'tester',
        nextRunAt: new Date(Date.now() + 60_000).toISOString(),
      });

      expect(id).toBeGreaterThan(0);

      const tasks = db.listScheduledTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        id,
        name: 'Daily summary',
        type: 'recurring',
        schedule: '* * * * *',
        channel_jid: 'dc:123',
        prompt: 'post summary',
        enabled: 1,
        created_by: 'tester',
      });
      expect(tasks[0].next_run_at).toBeTruthy();

      expect(db.removeScheduledTask(id)).toBe(true);
      expect(db.listScheduledTasks()).toHaveLength(0);
    } finally {
      db.closeDb();
      vi.resetModules();

      if (originalDbPath === undefined) {
        delete process.env.DB_PATH;
      } else {
        process.env.DB_PATH = originalDbPath;
      }
    }
  });
});

describe('silent cron disable observability', () => {
  it('warns when a due task has no next run and gets disabled', async () => {
    process.env.DB_PATH = ':memory:';
    vi.stubEnv('LOG_LEVEL', 'silent');
    vi.resetModules();
    const db = await import('../src/db.js');
    const { logger } = await import('../src/logger.js');
    const { startScheduler } = await import('../src/agent/scheduler.js');
    db.initDb();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      // 30 February never exists: croner yields no next run, and
      // updateTaskAfterRun flips enabled = 0. The warn is the only signal.
      db.addScheduledTask({
        name: 'impossible',
        type: 'recurring',
        schedule: '0 0 30 2 *',
        channelJid: 'dc:123',
        prompt: 'never',
        createdBy: 'tester',
        nextRunAt: new Date(Date.now() - 1000).toISOString(),
      });
      const stop = startScheduler();
      stop();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: expect.any(Number), schedule: '0 0 30 2 *' }),
        'Scheduled task has no next run for its schedule and is now disabled',
      );
      expect(db.listScheduledTasks()[0]).toMatchObject({
        enabled: 0,
      });
    } finally {
      warnSpy.mockRestore();
      db.closeDb();
      vi.unstubAllEnvs();
    }
  });
});
