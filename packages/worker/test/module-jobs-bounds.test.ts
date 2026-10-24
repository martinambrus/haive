import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { logger } from '@haive/shared';

vi.mock('../src/redis.js', () => ({ getBullRedis: () => ({}) }));
vi.mock('../src/db.js', () => ({ getDb: () => ({}) }));
vi.mock('@haive/shared/module-db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/module-db')>()),
  openModuleDatabase: async () => ({
    sql: {},
    withSchemaLock: async (run: (tx: unknown) => unknown) => run({}),
    close: async () => {},
  }),
}));

const {
  MODULE_JOB_START_WAIT_MS,
  MODULE_JOB_STOP_WAIT_MS,
  MODULE_REACTIVATION_ATTEMPTS,
  MODULE_SCHEMA_ENSURE_TIMEOUT_MS,
  MODULE_SHUTDOWN_WAIT_MS,
  ensureModuleSchemas,
  moduleJobsStarted,
  startModuleJobs,
} = await import('../src/modules/loader.js');

type Loaded = Parameters<typeof startModuleJobs>[0][number];
type Entry = Parameters<typeof startModuleJobs>[1][number];

function moduleWithJobs(id: string) {
  const stop = vi.fn(async () => {});
  const jobs = vi.fn(async () => stop);
  return {
    loaded: { manifest: { id } } as unknown as Loaded,
    entry: { jobs } as unknown as Entry,
    jobs,
    stop,
  };
}

function moduleWithHungStop(id: string) {
  const m = moduleWithJobs(id);
  m.stop.mockImplementationOnce(() => new Promise<void>(() => {}));
  return m;
}

function moduleWithSchema(id: string) {
  const base = moduleWithJobs(id);
  const ensure = vi.fn(async () => {});
  return { ...base, ensure, entry: { ...base.entry, ensureSchema: ensure } as Entry };
}

function moduleWithHungStart(id: string, hung: 'ensureSchema' | 'jobs') {
  const m = moduleWithSchema(id);
  let end!: { resolve: () => void; reject: (err: Error) => void };
  if (hung === 'ensureSchema') {
    m.ensure.mockImplementationOnce(
      () => new Promise<void>((resolve, reject) => (end = { resolve, reject })),
    );
  } else {
    m.jobs.mockImplementationOnce(
      () =>
        new Promise<typeof m.stop>((resolve, reject) => {
          end = { resolve: () => resolve(m.stop), reject };
        }),
    );
  }
  return { ...m, end: () => end };
}

const track = (promise: Promise<unknown>) => {
  const state = { settled: false };
  const settle = () => {
    state.settled = true;
  };
  void promise.then(settle, settle);
  return state;
};

const stamp = (moduleId: string, at: number) => new Map([[moduleId, at]]);

describe('the bounds on module work', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('startModuleJobs at boot with a start that does not end', () => {
    async function bootWithHungFirst(id: string) {
      const hung = moduleWithHungStart(id, 'jobs');
      const next = moduleWithJobs(`after-${id}`);
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
      const booting = startModuleJobs([hung.loaded, next.loaded], [hung.entry, next.entry]);
      const boot = track(booting);

      await vi.advanceTimersByTimeAsync(MODULE_JOB_START_WAIT_MS - 1);
      expect(boot.settled).toBe(false);
      expect(next.jobs).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(boot.settled).toBe(true);
      return { hung, next, warn, info, handle: await booting };
    }

    it('goes on after the wait without a module whose jobs never settle, starts the next module, and names the first in a warning', async () => {
      const { hung, next, warn } = await bootWithHungFirst('hung-at-boot');

      expect(next.jobs).toHaveBeenCalledOnce();
      expect(moduleJobsStarted('after-hung-at-boot')).toBe(true);
      expect(hung.jobs).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ module: 'hung-at-boot', waitMs: MODULE_JOB_START_WAIT_MS }),
        expect.stringMatching(/still starting/),
      );
    });

    it('keeps the module marked as started while its start runs, so a teardown of it is refused', async () => {
      await bootWithHungFirst('hung-claimed');

      expect(moduleJobsStarted('hung-claimed')).toBe(true);
    });

    it('records a start that ends after the wait as started, and stops it with the others', async () => {
      const { hung, next, handle, info } = await bootWithHungFirst('late-ok');

      hung.end().resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(hung.stop).not.toHaveBeenCalled();
      expect(moduleJobsStarted('late-ok')).toBe(true);
      expect(info).toHaveBeenCalledWith({ module: 'late-ok' }, expect.stringMatching(/started/));

      await handle.stopAll();
      expect(hung.stop).toHaveBeenCalledOnce();
      expect(next.stop).toHaveBeenCalledOnce();
      expect(moduleJobsStarted('late-ok')).toBe(false);
    });

    it('names the module in a warning when its start fails after the wait, and starts it on the first pass', async () => {
      const { hung, handle, warn } = await bootWithHungFirst('late-fail');
      warn.mockClear();

      hung.end().reject(new Error('no queue'));
      await vi.advanceTimersByTimeAsync(0);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ module: 'late-fail', err: expect.any(Error) }),
        expect.any(String),
      );
      expect(moduleJobsStarted('late-fail')).toBe(false);

      await handle.reconcile(new Set());
      expect(hung.ensure).toHaveBeenCalledOnce();
      expect(hung.jobs).toHaveBeenCalledTimes(2);
      expect(moduleJobsStarted('late-fail')).toBe(true);

      await handle.stopAll();
    });

    it('starts no second set of jobs while the late start runs, whatever the passes see of the module', async () => {
      const { hung, handle } = await bootWithHungFirst('late-no-twin');

      await handle.reconcile(new Set(), stamp('late-no-twin', 1));
      await handle.reconcile(new Set(), stamp('late-no-twin', 2));
      await handle.reconcile(new Set(['late-no-twin']), stamp('late-no-twin', 3));
      await handle.reconcile(new Set(), stamp('late-no-twin', 4));
      expect(hung.jobs).toHaveBeenCalledOnce();

      hung.end().resolve();
      await vi.advanceTimersByTimeAsync(0);
      await handle.reconcile(new Set(['late-no-twin']), stamp('late-no-twin', 5));
      expect(hung.stop).toHaveBeenCalledOnce();
      await handle.reconcile(new Set(), stamp('late-no-twin', 6));
      expect(hung.jobs).toHaveBeenCalledTimes(2);

      await handle.stopAll();
    });

    it('tries a module again on the next pass when a pass saw its stamp change during the late start and the start after it fails too', async () => {
      const { hung, handle } = await bootWithHungFirst('late-restamped');
      hung.jobs.mockRejectedValueOnce(new Error('queue gone'));

      await handle.reconcile(new Set(), stamp('late-restamped', 1));
      await handle.reconcile(new Set(), stamp('late-restamped', 2));
      hung.end().reject(new Error('no queue'));
      await vi.advanceTimersByTimeAsync(0);

      await handle.reconcile(new Set(), stamp('late-restamped', 2));
      expect(hung.jobs).toHaveBeenCalledTimes(2);
      expect(moduleJobsStarted('late-restamped')).toBe(false);

      await handle.reconcile(new Set(), stamp('late-restamped', 2));
      expect(hung.jobs).toHaveBeenCalledTimes(3);
      expect(moduleJobsStarted('late-restamped')).toBe(true);

      await handle.stopAll();
    });

    it('still fails boot, stopping the modules already started, when a later start fails within its wait, and stops the start that was still running', async () => {
      const slow = moduleWithHungStart('slow-first', 'jobs');
      const bad = {
        loaded: { manifest: { id: 'bad-second' } } as unknown as Loaded,
        entry: {
          jobs: vi.fn(async () => {
            throw new Error('no queue');
          }),
        } as unknown as Entry,
      };
      vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const booting = startModuleJobs([slow.loaded, bad.loaded], [slow.entry, bad.entry]);
      const failed = track(booting.catch(() => undefined));

      await vi.advanceTimersByTimeAsync(MODULE_JOB_START_WAIT_MS);
      expect(failed.settled).toBe(true);
      await expect(booting).rejects.toThrow(/Module bad-second jobs failed to start: no queue/);

      slow.end().resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(slow.stop).toHaveBeenCalledOnce();
      expect(moduleJobsStarted('slow-first')).toBe(false);
    });

    it('leaves no timer behind for starts that end within the wait', async () => {
      const m = moduleWithJobs('prompt-boot');

      await startModuleJobs([m.loaded], [m.entry]);

      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('ensureModuleSchemas with an ensure that does not end', () => {
    const db = {} as Database;

    it('goes on after the wait without a module whose ensureSchema never settles, reports it pending, ensures the next module, and names the first in a warning', async () => {
      const hung = moduleWithHungStart('hung-ensure', 'ensureSchema');
      const next = moduleWithSchema('after-hung-ensure');
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const ensuring = ensureModuleSchemas(
        db,
        [hung.loaded, next.loaded],
        [hung.entry, next.entry],
        new Set(),
      );
      const state = track(ensuring);

      await vi.advanceTimersByTimeAsync(MODULE_JOB_START_WAIT_MS - 1);
      expect(state.settled).toBe(false);
      expect(next.ensure).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(state.settled).toBe(true);
      expect(await ensuring).toEqual({ 'hung-ensure': 'pending', 'after-hung-ensure': 'ok' });
      expect(next.ensure).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ module: 'hung-ensure', waitMs: MODULE_JOB_START_WAIT_MS }),
        expect.stringMatching(/still starting/),
      );
    });

    it('rejects, naming the module, when an ensureSchema fails within the wait', async () => {
      const bad = moduleWithSchema('bad-ensure');
      bad.ensure.mockRejectedValueOnce(new Error('ddl refused'));

      await expect(ensureModuleSchemas(db, [bad.loaded], [bad.entry], new Set())).rejects.toThrow(
        /Module bad-ensure schema bootstrap failed: ddl refused/,
      );
    });

    it('names the module in a warning when its ensureSchema fails after the wait', async () => {
      const hung = moduleWithHungStart('late-ddl', 'ensureSchema');
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const ensuring = ensureModuleSchemas(db, [hung.loaded], [hung.entry], new Set());
      const state = track(ensuring);

      await vi.advanceTimersByTimeAsync(MODULE_JOB_START_WAIT_MS);
      expect(state.settled).toBe(true);
      await ensuring;
      warn.mockClear();

      hung.end().reject(new Error('ddl refused'));
      await vi.advanceTimersByTimeAsync(0);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ module: 'late-ddl', err: expect.any(Error) }),
        expect.any(String),
      );
    });

    it('leaves no timer behind for an ensure that ends within the wait', async () => {
      const m = moduleWithSchema('prompt-ensure');

      expect(await ensureModuleSchemas(db, [m.loaded], [m.entry], new Set())).toEqual({
        'prompt-ensure': 'ok',
      });

      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('the module part of shutdown', () => {
    it('is bounded below the Docker grace and below one stop wait', () => {
      expect(MODULE_SHUTDOWN_WAIT_MS).toBeGreaterThan(0);
      expect(MODULE_SHUTDOWN_WAIT_MS).toBeLessThanOrEqual(8_000);
      expect(MODULE_SHUTDOWN_WAIT_MS).toBeLessThan(MODULE_JOB_STOP_WAIT_MS);
    });

    it('ends at its deadline when the reconcile pass and a stop both hang, naming the modules still pending', async () => {
      const stuck = moduleWithHungStop('stuck-stop');
      const reviving = moduleWithHungStart('stuck-start', 'jobs');
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const handle = await startModuleJobs(
        [stuck.loaded, reviving.loaded],
        [stuck.entry, reviving.entry],
        new Set(['stuck-start']),
      );
      const pass = handle.reconcile(new Set());
      await vi.advanceTimersByTimeAsync(0);
      expect(reviving.jobs).toHaveBeenCalledOnce();

      const ended = track(handle.shutdown(pass));
      await vi.advanceTimersByTimeAsync(MODULE_SHUTDOWN_WAIT_MS - 1);
      expect(ended.settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(ended.settled).toBe(true);
      expect(stuck.stop).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ modules: expect.any(Array), waitMs: MODULE_SHUTDOWN_WAIT_MS }),
        expect.stringMatching(/still pending/),
      );
      const [fields] = warn.mock.calls.find(
        ([f]) => typeof f === 'object' && f !== null && 'modules' in f,
      )!;
      expect((fields as unknown as { modules: string[] }).modules.sort()).toEqual([
        'stuck-start',
        'stuck-stop',
      ]);
    });

    it('waits for no deadline when the pass and the stops are prompt, and logs no warning', async () => {
      const m = moduleWithJobs('prompt-exit');
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const handle = await startModuleJobs([m.loaded], [m.entry]);

      const ended = track(handle.shutdown(Promise.resolve()));
      await vi.advanceTimersByTimeAsync(0);

      expect(ended.settled).toBe(true);
      expect(m.stop).toHaveBeenCalledOnce();
      expect(moduleJobsStarted('prompt-exit')).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      expect(warn).not.toHaveBeenCalled();
    });

    it('stops the running modules while a pass is still in flight, without waiting for it first', async () => {
      const running = moduleWithJobs('running-while-pass');
      const reviving = moduleWithHungStart('pass-in-flight', 'jobs');
      vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const handle = await startModuleJobs(
        [running.loaded, reviving.loaded],
        [running.entry, reviving.entry],
        new Set(['pass-in-flight']),
      );
      const pass = handle.reconcile(new Set());
      await vi.advanceTimersByTimeAsync(0);

      void handle.shutdown(pass);
      await vi.advanceTimersByTimeAsync(0);

      expect(running.stop).toHaveBeenCalledOnce();
    });

    it('starts nothing more in a pass that is still running when it begins', async () => {
      const hung = moduleWithHungStart('first-hung', 'jobs');
      const next = moduleWithSchema('second-waiting');
      vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const handle = await startModuleJobs(
        [hung.loaded, next.loaded],
        [hung.entry, next.entry],
        new Set(['first-hung', 'second-waiting']),
      );
      const passRun = handle.reconcile(new Set());
      const pass = track(passRun);
      await vi.advanceTimersByTimeAsync(0);

      void handle.shutdown(passRun);
      await vi.advanceTimersByTimeAsync(MODULE_JOB_START_WAIT_MS);

      expect(pass.settled).toBe(true);
      expect(next.ensure).not.toHaveBeenCalled();
      expect(next.jobs).not.toHaveBeenCalled();
      expect(moduleJobsStarted('second-waiting')).toBe(false);
    });
  });

  describe('a start that ends after stopAll began', () => {
    it('stops itself at once when a pass started it, and leaves nothing to stop', async () => {
      const m = moduleWithHungStart('late-reactivation', 'jobs');
      vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
      const handle = await startModuleJobs([m.loaded], [m.entry], new Set(['late-reactivation']));
      const pass = track(handle.reconcile(new Set()));
      await vi.advanceTimersByTimeAsync(MODULE_JOB_START_WAIT_MS);
      expect(pass.settled).toBe(true);

      await handle.stopAll();
      expect(m.stop).not.toHaveBeenCalled();

      m.end().resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(m.stop).toHaveBeenCalledOnce();
      expect(moduleJobsStarted('late-reactivation')).toBe(false);
      expect(info).not.toHaveBeenCalledWith(
        { module: 'late-reactivation' },
        'module jobs started: the module is active again',
      );

      await handle.stopAll();
      expect(m.stop).toHaveBeenCalledOnce();
    });

    it('stops itself at once when it began at boot', async () => {
      const hung = moduleWithHungStart('late-at-boot', 'jobs');
      const next = moduleWithJobs('after-late-at-boot');
      vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const booting = startModuleJobs([hung.loaded, next.loaded], [hung.entry, next.entry]);
      const boot = track(booting);
      await vi.advanceTimersByTimeAsync(MODULE_JOB_START_WAIT_MS);
      expect(boot.settled).toBe(true);
      const handle = await booting;

      await handle.stopAll();
      expect(next.stop).toHaveBeenCalledOnce();
      expect(hung.stop).not.toHaveBeenCalled();

      hung.end().resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(hung.stop).toHaveBeenCalledOnce();
      expect(moduleJobsStarted('late-at-boot')).toBe(false);
    });
  });

  describe('a jobs start that does not return', () => {
    const beforeDeadline = MODULE_SCHEMA_ENSURE_TIMEOUT_MS - 1;

    it('releases the claim of a start boot went on without at the deadline, and lets the first pass start the module again', async () => {
      const m = moduleWithHungStart('boot-deadline', 'jobs');
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const booting = startModuleJobs([m.loaded], [m.entry]);
      await vi.advanceTimersByTimeAsync(MODULE_JOB_START_WAIT_MS);
      const handle = await booting;
      expect(moduleJobsStarted('boot-deadline')).toBe(true);

      await vi.advanceTimersByTimeAsync(beforeDeadline - MODULE_JOB_START_WAIT_MS);
      expect(moduleJobsStarted('boot-deadline')).toBe(true);

      await vi.advanceTimersByTimeAsync(1);
      expect(moduleJobsStarted('boot-deadline')).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ module: 'boot-deadline', err: expect.any(Error) }),
        expect.stringMatching(/first reconcile pass tries again/),
      );

      await handle.reconcile(new Set());
      expect(m.jobs).toHaveBeenCalledTimes(2);
      expect(moduleJobsStarted('boot-deadline')).toBe(true);

      await handle.stopAll();
    });

    it('releases the claim of a start a pass went on without at the deadline, counts it as an attempt, and starts the module again on the next pass', async () => {
      const m = moduleWithHungStart('pass-deadline', 'jobs');
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const handle = await startModuleJobs([m.loaded], [m.entry], new Set(['pass-deadline']));

      const pass = track(handle.reconcile(new Set()));
      await vi.advanceTimersByTimeAsync(MODULE_JOB_START_WAIT_MS);
      expect(pass.settled).toBe(true);
      expect(moduleJobsStarted('pass-deadline')).toBe(true);

      await vi.advanceTimersByTimeAsync(beforeDeadline - MODULE_JOB_START_WAIT_MS);
      expect(moduleJobsStarted('pass-deadline')).toBe(true);

      await vi.advanceTimersByTimeAsync(1);
      expect(moduleJobsStarted('pass-deadline')).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ module: 'pass-deadline', attempt: 1, err: expect.any(Error) }),
        expect.any(String),
      );

      await handle.reconcile(new Set());
      expect(m.jobs).toHaveBeenCalledTimes(2);
      expect(moduleJobsStarted('pass-deadline')).toBe(true);

      await handle.stopAll();
    });

    it('stops starting a module whose start never returns after its last attempt, and says so in the error log', async () => {
      const m = moduleWithJobs('attempts-deadline');
      m.jobs.mockImplementation(() => new Promise<typeof m.stop>(() => {}));
      vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
      const handle = await startModuleJobs([m.loaded], [m.entry], new Set(['attempts-deadline']));

      for (let attempt = 1; attempt <= MODULE_REACTIVATION_ATTEMPTS; attempt++) {
        const pass = track(handle.reconcile(new Set()));
        await vi.advanceTimersByTimeAsync(MODULE_SCHEMA_ENSURE_TIMEOUT_MS);
        expect(pass.settled).toBe(true);
        expect(moduleJobsStarted('attempts-deadline')).toBe(false);
        expect(m.jobs).toHaveBeenCalledTimes(attempt);
      }
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ module: 'attempts-deadline', err: expect.any(Error) }),
        expect.any(String),
      );

      await handle.reconcile(new Set());
      expect(m.jobs).toHaveBeenCalledTimes(MODULE_REACTIVATION_ATTEMPTS);
    });

    it('stops a start that returns after the deadline at once, and never counts it as started', async () => {
      const m = moduleWithHungStart('late-deadline', 'jobs');
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
      const handle = await startModuleJobs([m.loaded], [m.entry], new Set(['late-deadline']));

      const pass = track(handle.reconcile(new Set()));
      await vi.advanceTimersByTimeAsync(MODULE_SCHEMA_ENSURE_TIMEOUT_MS);
      expect(pass.settled).toBe(true);
      expect(moduleJobsStarted('late-deadline')).toBe(false);

      m.end().resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(m.stop).toHaveBeenCalledOnce();
      expect(moduleJobsStarted('late-deadline')).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        { module: 'late-deadline' },
        expect.stringMatching(/started after their deadline/),
      );
      expect(info).not.toHaveBeenCalledWith(
        { module: 'late-deadline' },
        'module jobs started: the module is active again',
      );

      await handle.stopAll();
      expect(m.stop).toHaveBeenCalledOnce();
    });

    it.each(['ends', 'fails'] as const)(
      'keeps the module marked as running while the stop of a start that returned after the deadline runs, until that stop %s',
      async (how) => {
        const id = `late-stopping-${how}`;
        const m = moduleWithHungStart(id, 'jobs');
        let endStop!: () => void;
        m.stop.mockImplementationOnce(
          () =>
            new Promise<void>((resolve, reject) => {
              endStop = how === 'ends' ? resolve : () => reject(new Error('stop refused'));
            }),
        );
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        const handle = await startModuleJobs([m.loaded], [m.entry], new Set([id]));

        const pass = track(handle.reconcile(new Set()));
        await vi.advanceTimersByTimeAsync(MODULE_SCHEMA_ENSURE_TIMEOUT_MS);
        expect(pass.settled).toBe(true);
        expect(moduleJobsStarted(id)).toBe(false);

        m.end().resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(m.stop).toHaveBeenCalledOnce();
        expect(moduleJobsStarted(id)).toBe(true);

        endStop();
        await vi.advanceTimersByTimeAsync(0);
        expect(moduleJobsStarted(id)).toBe(false);
        if (how === 'fails') {
          expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({ module: id, err: expect.any(Error) }),
            expect.stringMatching(/failed to stop/),
          );
        }
      },
    );

    it('logs a start that fails after the deadline without counting it again', async () => {
      const m = moduleWithHungStart('failing-deadline', 'jobs');
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
      const handle = await startModuleJobs([m.loaded], [m.entry], new Set(['failing-deadline']));

      const pass = track(handle.reconcile(new Set()));
      await vi.advanceTimersByTimeAsync(MODULE_SCHEMA_ENSURE_TIMEOUT_MS);
      expect(pass.settled).toBe(true);
      expect(moduleJobsStarted('failing-deadline')).toBe(false);

      m.end().reject(new Error('no queue'));
      await vi.advanceTimersByTimeAsync(0);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ module: 'failing-deadline', err: expect.any(Error) }),
        expect.stringMatching(/failed to start after their deadline/),
      );
      expect(error).not.toHaveBeenCalled();
      expect(moduleJobsStarted('failing-deadline')).toBe(false);

      await handle.reconcile(new Set());
      expect(m.jobs).toHaveBeenCalledTimes(2);
      expect(moduleJobsStarted('failing-deadline')).toBe(true);

      await handle.stopAll();
    });

    it('counts a start that returns just before the deadline as started, and leaves no timer behind', async () => {
      const m = moduleWithJobs('edge-deadline');
      m.jobs.mockImplementationOnce(
        () =>
          new Promise<typeof m.stop>((resolve) =>
            setTimeout(() => resolve(m.stop), MODULE_SCHEMA_ENSURE_TIMEOUT_MS - 1),
          ),
      );
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const handle = await startModuleJobs([m.loaded], [m.entry], new Set(['edge-deadline']));

      const pass = track(handle.reconcile(new Set()));
      await vi.advanceTimersByTimeAsync(beforeDeadline);
      expect(pass.settled).toBe(true);
      expect(moduleJobsStarted('edge-deadline')).toBe(true);

      await vi.advanceTimersByTimeAsync(MODULE_SCHEMA_ENSURE_TIMEOUT_MS);
      expect(moduleJobsStarted('edge-deadline')).toBe(true);
      expect(m.stop).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(warn).not.toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        expect.any(String),
      );

      await handle.stopAll();
      expect(m.stop).toHaveBeenCalledOnce();
    });
  });
});
