import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { logger } from '@haive/shared';

const moduleDb = vi.hoisted(() => ({
  opened: vi.fn(),
  closed: vi.fn(async () => {}),
  gate: undefined as Promise<void> | undefined,
}));

vi.mock('../src/redis.js', () => ({ getBullRedis: () => ({}) }));
vi.mock('../src/db.js', () => ({ getDb: () => ({}) }));
vi.mock('@haive/shared/module-db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/module-db')>()),
  openModuleDatabase: async (_db: unknown, moduleId: string) => {
    moduleDb.opened(moduleId);
    await moduleDb.gate;
    return {
      sql: {},
      withSchemaLock: async (run: (tx: unknown) => unknown) => run({}),
      close: moduleDb.closed,
    };
  },
}));

const {
  MODULE_JOBS_RECONCILE_MS,
  MODULE_JOB_START_WAIT_MS,
  MODULE_JOB_STOP_WAIT_MS,
  beginModuleTeardown,
  moduleJobsStarted,
  moduleTeardownRunning,
  startModuleJobs,
} = await import('../src/modules/loader.js');
const { ModuleTeardownRefusedError, runModuleTeardown } =
  await import('../src/queues/module-control-queue.js');

type Loaded = Parameters<typeof startModuleJobs>[0][number];
type Entry = Parameters<typeof startModuleJobs>[1][number];
type Hook = NonNullable<Entry['teardown']>;

const deactivatedRowDb = {
  select: () => ({
    from: () => ({
      where: () => ({ limit: async () => [{ deactivatedAt: new Date(), missingAt: null }] }),
    }),
  }),
  update: () => ({
    set: () => ({ where: () => ({ returning: async () => [{ tornDownAt: new Date() }] }) }),
  }),
} as unknown as Database;

const teardownDeps = (
  m: { loaded: Loaded; entry: Entry },
  teardown: Hook,
  hookTimeoutMs?: number,
) => ({
  db: deactivatedRowDb,
  loaded: [m.loaded],
  entries: [{ ...m.entry, teardown }],
  jobsStarted: moduleJobsStarted,
  teardownRunning: moduleTeardownRunning,
  hookTimeoutMs,
});

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
  let end!: { resolve: () => void; reject: (err: Error) => void };
  m.stop.mockImplementationOnce(
    () => new Promise<void>((resolve, reject) => (end = { resolve, reject })),
  );
  return { ...m, end: () => end };
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

function moduleWithSchemaOnly(id: string) {
  const ensure = vi.fn(async () => {});
  return {
    loaded: { manifest: { id } } as unknown as Loaded,
    entry: { ensureSchema: ensure } as unknown as Entry,
    ensure,
  };
}

const track = (promise: Promise<unknown>) => {
  const state = { settled: false };
  const settle = () => {
    state.settled = true;
  };
  void promise.then(settle, settle);
  return state;
};

describe('startModuleJobs', () => {
  it('starts no job of a deactivated module and every job of an active one', async () => {
    const off = moduleWithJobs('alpha');
    const on = moduleWithJobs('beta');
    const { stopAll } = await startModuleJobs(
      [off.loaded, on.loaded],
      [off.entry, on.entry],
      new Set(['alpha']),
    );
    expect(off.jobs).not.toHaveBeenCalled();
    expect(on.jobs).toHaveBeenCalledOnce();
    await stopAll();
    expect(on.stop).toHaveBeenCalledOnce();
    expect(off.stop).not.toHaveBeenCalled();
  });

  it('starts every module when none is deactivated', async () => {
    const a = moduleWithJobs('alpha');
    await startModuleJobs([a.loaded], [a.entry]);
    expect(a.jobs).toHaveBeenCalledOnce();
  });

  it('reports the modules whose jobs it started, and forgets them once they are stopped', async () => {
    const off = moduleWithJobs('quiet');
    const on = moduleWithJobs('busy');
    const bare = { loaded: { manifest: { id: 'bare' } } as unknown as Loaded, entry: {} as Entry };
    const { stopAll } = await startModuleJobs(
      [off.loaded, on.loaded, bare.loaded],
      [off.entry, on.entry, bare.entry],
      new Set(['quiet']),
    );
    expect(['quiet', 'busy', 'bare', 'ghost'].map(moduleJobsStarted)).toEqual([
      false,
      true,
      false,
      false,
    ]);
    await stopAll();
    expect(moduleJobsStarted('busy')).toBe(false);
  });

  it('forgets the jobs it started when a later module fails to start', async () => {
    const ok = moduleWithJobs('first');
    const bad = {
      loaded: { manifest: { id: 'second' } } as unknown as Loaded,
      entry: {
        jobs: vi.fn(async () => {
          throw new Error('no queue');
        }),
      } as unknown as Entry,
    };
    await expect(startModuleJobs([ok.loaded, bad.loaded], [ok.entry, bad.entry])).rejects.toThrow(
      /Module second jobs failed to start: no queue/,
    );
    expect(ok.stop).toHaveBeenCalledOnce();
    expect(moduleJobsStarted('first')).toBe(false);
  });
});

describe('the jobs reconcile', () => {
  beforeEach(() => {
    moduleDb.opened.mockClear();
    moduleDb.closed.mockClear();
    moduleDb.gate = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stops the jobs of a module deactivated while they run, and starts them once it is reactivated', async () => {
    const m = moduleWithJobs('flip');
    const { reconcile, stopAll } = await startModuleJobs([m.loaded], [m.entry]);
    expect(m.jobs).toHaveBeenCalledOnce();

    await reconcile(new Set(['flip']));
    expect(m.stop).toHaveBeenCalledOnce();
    expect(moduleJobsStarted('flip')).toBe(false);

    await reconcile(new Set(['flip']));
    expect(m.stop).toHaveBeenCalledOnce();

    await reconcile(new Set());
    expect(m.jobs).toHaveBeenCalledTimes(2);
    expect(moduleJobsStarted('flip')).toBe(true);

    await stopAll();
    expect(m.stop).toHaveBeenCalledTimes(2);
    expect(moduleJobsStarted('flip')).toBe(false);
  });

  it('starts the jobs of a module deactivated at boot once it is reactivated', async () => {
    const m = moduleWithJobs('late');
    const { reconcile, stopAll } = await startModuleJobs([m.loaded], [m.entry], new Set(['late']));
    expect(m.jobs).not.toHaveBeenCalled();

    await reconcile(new Set(['late']));
    expect(m.jobs).not.toHaveBeenCalled();
    expect(moduleJobsStarted('late')).toBe(false);

    await reconcile(new Set());
    expect(m.jobs).toHaveBeenCalledOnce();
    expect(moduleJobsStarted('late')).toBe(true);

    await stopAll();
    expect(m.stop).toHaveBeenCalledOnce();
  });

  it('stops only the module that was deactivated', async () => {
    const a = moduleWithJobs('pair-a');
    const b = moduleWithJobs('pair-b');
    const { reconcile, stopAll } = await startModuleJobs([a.loaded, b.loaded], [a.entry, b.entry]);

    await reconcile(new Set());
    expect(a.stop).not.toHaveBeenCalled();
    expect(b.stop).not.toHaveBeenCalled();

    await reconcile(new Set(['pair-a']));
    expect(a.stop).toHaveBeenCalledOnce();
    expect(b.stop).not.toHaveBeenCalled();
    expect([a, b].map((m) => m.jobs.mock.calls.length)).toEqual([1, 1]);
    expect(moduleJobsStarted('pair-b')).toBe(true);

    await stopAll();
    expect(b.stop).toHaveBeenCalledOnce();
  });

  it('keeps a module whose jobs failed to stop marked as started, and stops them on the next pass', async () => {
    const m = moduleWithJobs('stuck');
    m.stop.mockRejectedValueOnce(new Error('queue gone'));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { reconcile, stopAll } = await startModuleJobs([m.loaded], [m.entry]);

    await expect(reconcile(new Set(['stuck']))).resolves.toBeUndefined();
    expect(m.stop).toHaveBeenCalledOnce();
    expect(moduleJobsStarted('stuck')).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ module: 'stuck', err: expect.any(Error) }),
      expect.any(String),
    );

    await reconcile(new Set(['stuck']));
    expect(m.stop).toHaveBeenCalledTimes(2);
    expect(moduleJobsStarted('stuck')).toBe(false);

    await stopAll();
    expect(m.stop).toHaveBeenCalledTimes(2);
  });

  it('starts no second set of jobs when a reactivation overtakes a stop that failed', async () => {
    const m = moduleWithJobs('overtaken');
    m.stop.mockRejectedValueOnce(new Error('queue gone'));
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { reconcile, stopAll } = await startModuleJobs([m.loaded], [m.entry]);

    await reconcile(new Set(['overtaken']));
    await reconcile(new Set());
    expect(m.jobs).toHaveBeenCalledOnce();
    expect(moduleJobsStarted('overtaken')).toBe(true);

    await reconcile(new Set(['overtaken']));
    expect(m.stop).toHaveBeenCalledTimes(2);
    expect(moduleJobsStarted('overtaken')).toBe(false);

    await stopAll();
  });

  it('tries a start that fails at runtime three times in all, and again only after a deactivation and a reactivation', async () => {
    const m = moduleWithJobs('broken');
    const refused = new Error('no queue');
    m.jobs
      .mockRejectedValueOnce(refused)
      .mockRejectedValueOnce(refused)
      .mockRejectedValueOnce(refused);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { reconcile, stopAll } = await startModuleJobs(
      [m.loaded],
      [m.entry],
      new Set(['broken']),
    );

    await expect(reconcile(new Set())).resolves.toBeUndefined();
    expect(m.jobs).toHaveBeenCalledOnce();
    expect(moduleJobsStarted('broken')).toBe(false);
    expect(error).not.toHaveBeenCalled();

    await reconcile(new Set());
    await reconcile(new Set());
    expect(m.jobs).toHaveBeenCalledTimes(3);
    expect(moduleJobsStarted('broken')).toBe(false);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ module: 'broken', err: expect.any(Error) }),
      expect.any(String),
    );

    await reconcile(new Set());
    expect(m.jobs).toHaveBeenCalledTimes(3);

    await reconcile(new Set(['broken']));
    await reconcile(new Set());
    expect(m.jobs).toHaveBeenCalledTimes(4);
    expect(moduleJobsStarted('broken')).toBe(true);

    await stopAll();
    expect(m.stop).toHaveBeenCalledOnce();
  });

  it('ensures the schema of a reactivated module once, before its jobs, and not when the jobs start at boot', async () => {
    const m = moduleWithSchema('revived');
    const { reconcile, stopAll } = await startModuleJobs([m.loaded], [m.entry]);
    expect(m.jobs).toHaveBeenCalledOnce();
    expect(m.ensure).not.toHaveBeenCalled();

    await reconcile(new Set(['revived']));
    expect(m.ensure).not.toHaveBeenCalled();

    await reconcile(new Set());
    expect(m.ensure).toHaveBeenCalledOnce();
    expect(m.ensure).toHaveBeenCalledWith(expect.objectContaining({ moduleId: 'revived' }));
    expect(moduleDb.opened).toHaveBeenCalledWith('revived');
    expect(moduleDb.closed).toHaveBeenCalledOnce();
    expect(m.jobs).toHaveBeenCalledTimes(2);
    const [bootStart, restart] = m.jobs.mock.invocationCallOrder;
    const [ensured] = m.ensure.mock.invocationCallOrder;
    expect(ensured).toBeGreaterThan(bootStart!);
    expect(ensured).toBeLessThan(restart!);

    await reconcile(new Set());
    expect(m.ensure).toHaveBeenCalledOnce();

    await stopAll();
  });

  it.each(['ensureSchema', 'jobs'] as const)(
    'starts the jobs of a reactivated module whose %s hook failed twice, on the third pass',
    async (which) => {
      const id = `flaky-${which}`;
      const m = moduleWithSchema(id);
      const refused = new Error('refused');
      if (which === 'ensureSchema') {
        m.ensure.mockRejectedValueOnce(refused).mockRejectedValueOnce(refused);
      } else {
        m.jobs.mockRejectedValueOnce(refused).mockRejectedValueOnce(refused);
      }
      vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
      const { reconcile, stopAll } = await startModuleJobs([m.loaded], [m.entry], new Set([id]));

      await reconcile(new Set());
      await reconcile(new Set());
      expect(m.ensure).toHaveBeenCalledTimes(2);
      expect(moduleJobsStarted(id)).toBe(false);

      await reconcile(new Set());
      expect(m.ensure).toHaveBeenCalledTimes(3);
      expect(m.jobs).toHaveBeenCalledTimes(which === 'jobs' ? 3 : 1);
      expect(moduleJobsStarted(id)).toBe(true);

      await reconcile(new Set());
      expect(m.ensure).toHaveBeenCalledTimes(3);
      expect(error).not.toHaveBeenCalled();

      await stopAll();
    },
  );

  it('tries a reactivation that keeps failing three times in all, warning of the first two and logging the error for the third, and three more after a deactivation and a reactivation', async () => {
    const m = moduleWithSchema('doomed-for-good');
    m.ensure.mockRejectedValue(new Error('ddl refused'));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { reconcile, stopAll } = await startModuleJobs(
      [m.loaded],
      [m.entry],
      new Set(['doomed-for-good']),
    );

    for (let pass = 0; pass < 5; pass++) await reconcile(new Set());
    expect(m.ensure).toHaveBeenCalledTimes(3);
    expect(m.jobs).not.toHaveBeenCalled();
    expect(moduleJobsStarted('doomed-for-good')).toBe(false);
    expect(moduleDb.closed).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(2);
    for (const attempt of [1, 2]) {
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ module: 'doomed-for-good', attempt, err: expect.any(Error) }),
        expect.any(String),
      );
    }
    expect(error).toHaveBeenCalledOnce();
    const logged = error.mock.calls[0]![0] as unknown as { module: string; err: Error };
    expect(logged.module).toBe('doomed-for-good');
    expect(logged.err.message).toBe('Module doomed-for-good schema bootstrap failed: ddl refused');

    await reconcile(new Set(['doomed-for-good']));
    for (let pass = 0; pass < 5; pass++) await reconcile(new Set());
    expect(m.ensure).toHaveBeenCalledTimes(6);
    expect(warn).toHaveBeenCalledTimes(4);
    expect(error).toHaveBeenCalledTimes(2);

    await stopAll();
  });

  it('counts the attempts of a reactivation afresh once the module has been deactivated and activated again', async () => {
    const m = moduleWithSchema('restarted');
    m.ensure.mockRejectedValue(new Error('ddl refused'));
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { reconcile, stopAll } = await startModuleJobs(
      [m.loaded],
      [m.entry],
      new Set(['restarted']),
    );

    await reconcile(new Set());
    expect(m.ensure).toHaveBeenCalledOnce();

    await reconcile(new Set(['restarted']));
    for (let pass = 0; pass < 5; pass++) await reconcile(new Set());
    expect(m.ensure).toHaveBeenCalledTimes(4);
    expect(error).toHaveBeenCalledOnce();

    await stopAll();
  });

  it('gives a module torn down and activated again between two passes attempts of its own, whatever the reactivation before it used', async () => {
    const m = moduleWithSchema('torn-after-failing');
    m.ensure.mockRejectedValue(new Error('ddl refused'));
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { reconcile, stopAll } = await startModuleJobs(
      [m.loaded],
      [m.entry],
      new Set(['torn-after-failing']),
    );

    for (let pass = 0; pass < 5; pass++) await reconcile(new Set());
    expect(m.ensure).toHaveBeenCalledTimes(3);

    beginModuleTeardown('torn-after-failing')();
    for (let pass = 0; pass < 5; pass++) await reconcile(new Set());
    expect(m.ensure).toHaveBeenCalledTimes(6);

    await stopAll();
  });

  it('gives a module torn down and activated again mid-retry, between two passes, three attempts of its own', async () => {
    const m = moduleWithSchema('torn-mid-retry');
    m.ensure.mockRejectedValue(new Error('ddl refused'));
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { reconcile, stopAll } = await startModuleJobs(
      [m.loaded],
      [m.entry],
      new Set(['torn-mid-retry']),
    );

    await reconcile(new Set());
    expect(m.ensure).toHaveBeenCalledTimes(1);

    beginModuleTeardown('torn-mid-retry')();
    for (let pass = 0; pass < 5; pass++) await reconcile(new Set());
    expect(m.ensure).toHaveBeenCalledTimes(4);

    await stopAll();
  });

  it('starts no jobs, and ensures no schema, of a module while its teardown runs, and starts them on the first pass after it ends', async () => {
    const m = moduleWithSchema('torn');
    const { reconcile, stopAll } = await startModuleJobs([m.loaded], [m.entry], new Set(['torn']));

    const endTeardown = beginModuleTeardown('torn');
    await reconcile(new Set());
    await reconcile(new Set());
    expect(m.ensure).not.toHaveBeenCalled();
    expect(m.jobs).not.toHaveBeenCalled();
    expect(moduleJobsStarted('torn')).toBe(false);

    endTeardown();
    await reconcile(new Set());
    expect(m.ensure).toHaveBeenCalledOnce();
    expect(m.jobs).toHaveBeenCalledOnce();
    expect(moduleJobsStarted('torn')).toBe(true);

    await stopAll();
  });

  it('holds back only the module whose teardown runs', async () => {
    const a = moduleWithSchema('tear-a');
    const b = moduleWithSchema('tear-b');
    const { reconcile, stopAll } = await startModuleJobs(
      [a.loaded, b.loaded],
      [a.entry, b.entry],
      new Set(['tear-a', 'tear-b']),
    );

    const endTeardown = beginModuleTeardown('tear-a');
    await reconcile(new Set());
    expect(a.jobs).not.toHaveBeenCalled();
    expect(b.jobs).toHaveBeenCalledOnce();
    expect(moduleJobsStarted('tear-b')).toBe(true);

    endTeardown();
    await reconcile(new Set());
    expect(a.jobs).toHaveBeenCalledOnce();
    expect(b.jobs).toHaveBeenCalledOnce();

    await stopAll();
  });

  it('warns once per hold when passes keep a reactivated module back for its running teardown hook, and logs nothing more when the hold ends', async () => {
    const m = moduleWithSchemaOnly('held');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { reconcile, stopAll } = await startModuleJobs([m.loaded], [m.entry], new Set(['held']));

    const endFirst = beginModuleTeardown('held');
    await reconcile(new Set());
    await reconcile(new Set());
    await reconcile(new Set());
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ module: 'held' }),
      expect.stringMatching(/teardown hook is still running/),
    );

    endFirst();
    await reconcile(new Set());
    expect(m.ensure).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();

    const endSecond = beginModuleTeardown('held');
    await reconcile(new Set());
    await reconcile(new Set());
    expect(warn).toHaveBeenCalledTimes(2);

    await reconcile(new Set(['held']));
    await reconcile(new Set());
    expect(warn).toHaveBeenCalledTimes(3);

    endSecond();
    await stopAll();
  });

  it('never starts or stops a module without jobs', async () => {
    const bare = { loaded: { manifest: { id: 'plain' } } as unknown as Loaded, entry: {} as Entry };
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { reconcile, stopAll } = await startModuleJobs([bare.loaded], [bare.entry]);

    await reconcile(new Set(['plain']));
    await reconcile(new Set());
    expect(moduleJobsStarted('plain')).toBe(false);

    await stopAll();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('ensures the schema of a reactivated module that has no jobs once, and not while its teardown runs', async () => {
    const m = moduleWithSchemaOnly('schema-only');
    const { reconcile, stopAll } = await startModuleJobs(
      [m.loaded],
      [m.entry],
      new Set(['schema-only']),
    );

    await reconcile(new Set(['schema-only']));
    expect(m.ensure).not.toHaveBeenCalled();

    await reconcile(new Set());
    expect(m.ensure).toHaveBeenCalledOnce();
    expect(moduleJobsStarted('schema-only')).toBe(false);

    await reconcile(new Set());
    expect(m.ensure).toHaveBeenCalledOnce();

    await reconcile(new Set(['schema-only']));
    const endTeardown = beginModuleTeardown('schema-only');
    await reconcile(new Set());
    expect(m.ensure).toHaveBeenCalledOnce();

    endTeardown();
    await reconcile(new Set());
    expect(m.ensure).toHaveBeenCalledTimes(2);
    expect(moduleJobsStarted('schema-only')).toBe(false);

    await stopAll();
  });

  it('ensures the schema of a module torn down and activated again between two passes once, on the first pass after the hook', async () => {
    const m = moduleWithSchemaOnly('between-passes');
    const { reconcile, stopAll } = await startModuleJobs([m.loaded], [m.entry]);
    const hook = vi.fn<Hook>(async () => {});

    await runModuleTeardown(teardownDeps(m, hook), 'between-passes');
    expect(hook).toHaveBeenCalledOnce();
    expect(m.ensure).not.toHaveBeenCalled();

    await reconcile(new Set());
    expect(m.ensure).toHaveBeenCalledOnce();

    await reconcile(new Set());
    expect(m.ensure).toHaveBeenCalledOnce();

    await stopAll();
  });

  it('ensures a module with jobs once, and starts its jobs once more, after a deactivation, a teardown and an activation', async () => {
    const m = moduleWithSchema('cycled');
    const { reconcile, stopAll } = await startModuleJobs([m.loaded], [m.entry]);
    const hook = vi.fn<Hook>(async () => {});

    await reconcile(new Set(['cycled']));
    await runModuleTeardown(teardownDeps(m, hook), 'cycled');
    await reconcile(new Set());
    await reconcile(new Set());

    expect(hook).toHaveBeenCalledOnce();
    expect(m.ensure).toHaveBeenCalledOnce();
    expect(m.jobs).toHaveBeenCalledTimes(2);

    await stopAll();
  });

  it('refuses a teardown begun while a reactivated module is starting, and allows one once the start has failed', async () => {
    const m = moduleWithSchema('claimed');
    let endEnsure!: () => void;
    let endJobs!: () => void;
    m.ensure.mockImplementationOnce(() => new Promise<void>((resolve) => (endEnsure = resolve)));
    m.jobs.mockImplementationOnce(
      () => new Promise<typeof m.stop>((resolve) => (endJobs = () => resolve(m.stop))),
    );
    const hook = vi.fn<Hook>(async () => {});
    const refusal = async () =>
      (await runModuleTeardown(teardownDeps(m, hook), 'claimed').catch(
        (err: unknown) => err,
      )) as Error;
    const { reconcile, stopAll } = await startModuleJobs(
      [m.loaded],
      [m.entry],
      new Set(['claimed']),
    );

    const pass = reconcile(new Set());
    await vi.waitFor(() => expect(m.ensure).toHaveBeenCalledOnce());
    expect(moduleJobsStarted('claimed')).toBe(true);
    const whileEnsuring = await refusal();
    expect(whileEnsuring).toBeInstanceOf(ModuleTeardownRefusedError);
    expect(whileEnsuring.message).toMatch(/claimed.*jobs.*still running/);

    endEnsure();
    await vi.waitFor(() => expect(m.jobs).toHaveBeenCalledOnce());
    expect(await refusal()).toBeInstanceOf(ModuleTeardownRefusedError);

    endJobs();
    await pass;
    expect(moduleJobsStarted('claimed')).toBe(true);
    expect(hook).not.toHaveBeenCalled();
    await stopAll();

    const bad = moduleWithSchema('abandoned');
    bad.ensure.mockRejectedValueOnce(new Error('ddl refused'));
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const failing = await startModuleJobs([bad.loaded], [bad.entry], new Set(['abandoned']));
    await failing.reconcile(new Set());
    expect(moduleJobsStarted('abandoned')).toBe(false);
    await runModuleTeardown(teardownDeps(bad, hook), 'abandoned');
    expect(hook).toHaveBeenCalledOnce();
  });

  it('refuses a teardown begun while a schema-only module is being ensured, in words that fit a schema setup', async () => {
    const m = moduleWithSchemaOnly('ensuring');
    let endEnsure!: () => void;
    m.ensure.mockImplementationOnce(() => new Promise<void>((resolve) => (endEnsure = resolve)));
    const hook = vi.fn<Hook>(async () => {});
    const { reconcile, stopAll } = await startModuleJobs(
      [m.loaded],
      [m.entry],
      new Set(['ensuring']),
    );

    const pass = reconcile(new Set());
    await vi.waitFor(() => expect(m.ensure).toHaveBeenCalledOnce());
    const refusal = (await runModuleTeardown(teardownDeps(m, hook), 'ensuring').catch(
      (err: unknown) => err,
    )) as Error;

    expect(refusal).toBeInstanceOf(ModuleTeardownRefusedError);
    expect(refusal.message).toMatch(
      new RegExp(`ensuring.*schema setup.*about ${MODULE_JOBS_RECONCILE_MS / 1000} seconds`),
    );
    expect(hook).not.toHaveBeenCalled();

    endEnsure();
    await pass;
    await stopAll();
  });

  it.each(['resolves', 'rejects'] as const)(
    'keeps a module whose teardown job timed out from starting until the hook itself %s',
    async (how) => {
      const id = `outlasted-${how}`;
      const m = moduleWithJobs(id);
      const { reconcile, stopAll } = await startModuleJobs([m.loaded], [m.entry], new Set([id]));
      let endHook!: () => void;
      const hook: Hook = () =>
        new Promise<void>((resolve, reject) => {
          endHook = how === 'resolves' ? resolve : () => reject(new Error('late failure'));
        });

      const failure = await runModuleTeardown(teardownDeps(m, hook, 20), id).catch(
        (err: unknown) => err,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(ModuleTeardownRefusedError);

      await reconcile(new Set());
      expect(m.jobs).not.toHaveBeenCalled();
      expect(moduleJobsStarted(id)).toBe(false);

      endHook();
      await new Promise((resolve) => setImmediate(resolve));
      await reconcile(new Set());
      expect(m.jobs).toHaveBeenCalledOnce();
      expect(moduleJobsStarted(id)).toBe(true);

      await stopAll();
    },
  );

  it('refuses a teardown of a module while the hook of an earlier teardown of it still runs, and allows one once that hook has ended', async () => {
    const m = moduleWithJobs('twice');
    let endFirst!: () => void;
    const first: Hook = () => new Promise<void>((resolve) => (endFirst = resolve));
    const second = vi.fn<Hook>(async () => {});

    const timedOut = await runModuleTeardown(teardownDeps(m, first, 20), 'twice').catch(
      (err: unknown) => err,
    );
    expect(timedOut).toBeInstanceOf(Error);
    expect(timedOut).not.toBeInstanceOf(ModuleTeardownRefusedError);

    const refusal = (await runModuleTeardown(teardownDeps(m, second), 'twice').catch(
      (err: unknown) => err,
    )) as Error;
    expect(refusal).toBeInstanceOf(ModuleTeardownRefusedError);
    expect(refusal.message).toMatch(/twice.*earlier teardown.*still running on this worker/);
    expect(second).not.toHaveBeenCalled();

    endFirst();
    await new Promise((resolve) => setImmediate(resolve));
    await runModuleTeardown(teardownDeps(m, second), 'twice');
    expect(second).toHaveBeenCalledOnce();
  });

  it('frees a module whose teardown hook throws before it returns a promise', async () => {
    const m = moduleWithJobs('throws-early');
    const { reconcile, stopAll } = await startModuleJobs(
      [m.loaded],
      [m.entry],
      new Set(['throws-early']),
    );
    const hook: Hook = () => {
      throw new Error('hook refused');
    };

    await expect(runModuleTeardown(teardownDeps(m, hook), 'throws-early')).rejects.toThrow(
      'hook refused',
    );
    await reconcile(new Set());
    expect(m.jobs).toHaveBeenCalledOnce();

    await stopAll();
  });

  it('rejects a database a hook asks for after its timeout, and opens nothing', async () => {
    const m = moduleWithJobs('outlasting');
    let ctx!: Parameters<Hook>[0];
    let endHook!: () => void;
    const hook: Hook = (c) =>
      new Promise<void>((resolve) => {
        ctx = c;
        endHook = resolve;
      });

    await runModuleTeardown(teardownDeps(m, hook, 20), 'outlasting').catch(() => undefined);
    const late = await ctx.openDatabase().catch((err: unknown) => err);

    expect(late).toBeInstanceOf(Error);
    expect((late as Error).name).toBe('ModuleTeardownEndedError');
    expect((late as Error).message).toMatch(/outlasting/);
    expect(moduleDb.opened).not.toHaveBeenCalled();
    endHook();
  });

  it('closes a database a hook was still opening when its timeout fired, and rejects that call', async () => {
    const m = moduleWithJobs('straddling');
    let openGate!: () => void;
    moduleDb.gate = new Promise<void>((resolve) => (openGate = resolve));
    let opening!: Promise<unknown>;
    let endHook!: () => void;
    const hook: Hook = (c) =>
      new Promise<void>((resolve) => {
        endHook = resolve;
        opening = c.openDatabase().catch((err: unknown) => err);
      });

    await runModuleTeardown(teardownDeps(m, hook, 20), 'straddling').catch(() => undefined);
    expect(moduleDb.opened).toHaveBeenCalledOnce();
    expect(moduleDb.closed).not.toHaveBeenCalled();

    openGate();
    const settled = await opening;
    expect(settled).toBeInstanceOf(Error);
    expect((settled as Error).name).toBe('ModuleTeardownEndedError');
    expect(moduleDb.closed).toHaveBeenCalledOnce();
    endHook();
  });
});

describe('the jobs reconcile with a stop that does not end', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('goes on after the wait without a module whose jobs never stop, having handled the other modules of that pass', async () => {
    const hung = moduleWithHungStop('hung');
    const prompt = moduleWithJobs('prompt');
    const back = moduleWithJobs('back');
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { reconcile } = await startModuleJobs(
      [hung.loaded, prompt.loaded, back.loaded],
      [hung.entry, prompt.entry, back.entry],
      new Set(['back']),
    );

    const pass = track(reconcile(new Set(['hung', 'prompt'])));
    await vi.advanceTimersByTimeAsync(MODULE_JOB_STOP_WAIT_MS - 1);
    expect(pass.settled).toBe(false);
    expect(moduleJobsStarted('prompt')).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(pass.settled).toBe(true);
    expect(back.jobs).toHaveBeenCalledOnce();
    expect(hung.stop).toHaveBeenCalledOnce();
  });

  it('lets stopAll go on after the same wait, so a shutdown does not hang on a module whose jobs never stop', async () => {
    const hung = moduleWithHungStop('hung-at-exit');
    const prompt = moduleWithJobs('prompt-at-exit');
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { stopAll } = await startModuleJobs(
      [hung.loaded, prompt.loaded],
      [hung.entry, prompt.entry],
    );

    const all = track(stopAll());
    await vi.advanceTimersByTimeAsync(MODULE_JOB_STOP_WAIT_MS - 1);
    expect(all.settled).toBe(false);
    expect(moduleJobsStarted('prompt-at-exit')).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(all.settled).toBe(true);
    expect(moduleJobsStarted('hung-at-exit')).toBe(true);
  });

  it('calls the stop of a module once while it still runs, whether a later pass or stopAll comes', async () => {
    const m = moduleWithHungStop('once-only');
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { reconcile, stopAll } = await startModuleJobs([m.loaded], [m.entry]);

    void reconcile(new Set(['once-only']));
    await vi.advanceTimersByTimeAsync(MODULE_JOB_STOP_WAIT_MS);
    const later = track(reconcile(new Set(['once-only'])));
    const all = track(stopAll());
    await vi.advanceTimersByTimeAsync(MODULE_JOB_STOP_WAIT_MS);

    expect(m.stop).toHaveBeenCalledOnce();
    expect(later.settled).toBe(true);
    expect(all.settled).toBe(true);
  });

  it('keeps a module whose jobs are still stopping marked as started, so its teardown is refused', async () => {
    const m = moduleWithHungStop('pinned');
    const hook = vi.fn<Hook>(async () => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { reconcile } = await startModuleJobs([m.loaded], [m.entry]);

    const pass = track(reconcile(new Set(['pinned'])));
    await vi.advanceTimersByTimeAsync(MODULE_JOB_STOP_WAIT_MS);
    expect(pass.settled).toBe(true);
    expect(moduleJobsStarted('pinned')).toBe(true);

    const refusal = (await runModuleTeardown(teardownDeps(m, hook), 'pinned').catch(
      (err: unknown) => err,
    )) as Error;
    expect(refusal).toBeInstanceOf(ModuleTeardownRefusedError);
    expect(refusal.message).toMatch(/pinned.*still running/);
    expect(hook).not.toHaveBeenCalled();
  });

  it('warns once for a stop that outlives the wait, naming the module and the wait, and not again for later passes', async () => {
    const m = moduleWithHungStop('slow-stop');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { reconcile, stopAll } = await startModuleJobs([m.loaded], [m.entry]);

    void reconcile(new Set(['slow-stop']));
    await vi.advanceTimersByTimeAsync(MODULE_JOB_STOP_WAIT_MS);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ module: 'slow-stop', waitMs: MODULE_JOB_STOP_WAIT_MS }),
      expect.any(String),
    );

    void reconcile(new Set(['slow-stop']));
    void stopAll();
    await vi.advanceTimersByTimeAsync(MODULE_JOB_STOP_WAIT_MS * 2);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('logs no warning for a stop that ends within the wait, however long the clock then runs', async () => {
    const quick = moduleWithJobs('quick');
    const nearly = moduleWithJobs('nearly');
    nearly.stop.mockImplementationOnce(
      () => new Promise<void>((resolve) => setTimeout(resolve, MODULE_JOB_STOP_WAIT_MS - 1)),
    );
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { reconcile } = await startModuleJobs(
      [quick.loaded, nearly.loaded],
      [quick.entry, nearly.entry],
    );

    const pass = track(reconcile(new Set(['quick', 'nearly'])));
    await vi.advanceTimersByTimeAsync(MODULE_JOB_STOP_WAIT_MS - 1);
    expect(pass.settled).toBe(true);
    expect(moduleJobsStarted('quick')).toBe(false);
    expect(moduleJobsStarted('nearly')).toBe(false);

    await vi.advanceTimersByTimeAsync(MODULE_JOB_STOP_WAIT_MS * 2);
    expect(warn).not.toHaveBeenCalled();
  });

  it('forgets a module whose stop ends after the wait, and starts its jobs again once the module is active', async () => {
    const m = moduleWithHungStop('stopped-late');
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const { reconcile } = await startModuleJobs([m.loaded], [m.entry]);

    const pass = track(reconcile(new Set(['stopped-late'])));
    await vi.advanceTimersByTimeAsync(MODULE_JOB_STOP_WAIT_MS);
    expect(pass.settled).toBe(true);
    await reconcile(new Set());
    expect(m.jobs).toHaveBeenCalledOnce();
    expect(moduleJobsStarted('stopped-late')).toBe(true);

    m.end().resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(moduleJobsStarted('stopped-late')).toBe(false);
    expect(info).toHaveBeenCalledWith({ module: 'stopped-late' }, 'module jobs stopped');

    await reconcile(new Set());
    expect(m.jobs).toHaveBeenCalledTimes(2);
    expect(moduleJobsStarted('stopped-late')).toBe(true);
  });

  it('keeps a module whose stop fails after the wait marked as started, and stops its jobs again on the next pass', async () => {
    const m = moduleWithHungStop('failing-late');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { reconcile } = await startModuleJobs([m.loaded], [m.entry]);

    const pass = track(reconcile(new Set(['failing-late'])));
    await vi.advanceTimersByTimeAsync(MODULE_JOB_STOP_WAIT_MS);
    expect(pass.settled).toBe(true);
    warn.mockClear();

    m.end().reject(new Error('queue gone'));
    await vi.advanceTimersByTimeAsync(0);
    expect(moduleJobsStarted('failing-late')).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ module: 'failing-late', err: expect.any(Error) }),
      'module jobs failed to stop',
    );
    expect(m.stop).toHaveBeenCalledOnce();

    await reconcile(new Set(['failing-late']));
    expect(m.stop).toHaveBeenCalledTimes(2);
    expect(moduleJobsStarted('failing-late')).toBe(false);
  });
});

describe('the jobs reconcile with a start that does not end', () => {
  const hooks = ['ensureSchema', 'jobs'] as const;

  beforeEach(() => {
    moduleDb.gate = undefined;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(hooks)(
    'goes on after the wait without a module whose %s hook never settles, having started the other modules of that pass',
    async (which) => {
      const hung = moduleWithHungStart(`hung-${which}`, which);
      const next = moduleWithJobs(`after-hung-${which}`);
      vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const { reconcile } = await startModuleJobs(
        [hung.loaded, next.loaded],
        [hung.entry, next.entry],
        new Set([`hung-${which}`, `after-hung-${which}`]),
      );

      const pass = track(reconcile(new Set()));
      await vi.advanceTimersByTimeAsync(MODULE_JOB_START_WAIT_MS - 1);
      expect(pass.settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(pass.settled).toBe(true);
      expect(next.jobs).toHaveBeenCalledOnce();
      expect(moduleJobsStarted(`after-hung-${which}`)).toBe(true);
      expect(hung.ensure).toHaveBeenCalledOnce();
      expect(hung.jobs).toHaveBeenCalledTimes(which === 'jobs' ? 1 : 0);
    },
  );

  it.each(hooks)(
    'records a module whose %s hook ends after the wait as started, as a prompt start would',
    async (which) => {
      const id = `started-late-${which}`;
      const m = moduleWithHungStart(id, which);
      vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
      const { reconcile, stopAll } = await startModuleJobs([m.loaded], [m.entry], new Set([id]));

      const pass = track(reconcile(new Set()));
      await vi.advanceTimersByTimeAsync(MODULE_JOB_START_WAIT_MS);
      expect(pass.settled).toBe(true);
      expect(moduleJobsStarted(id)).toBe(true);
      expect(info).not.toHaveBeenCalledWith(
        { module: id },
        'module jobs started: the module is active again',
      );

      m.end().resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(m.jobs).toHaveBeenCalledOnce();
      expect(moduleJobsStarted(id)).toBe(true);
      expect(info).toHaveBeenCalledWith(
        { module: id },
        'module jobs started: the module is active again',
      );

      await stopAll();
      expect(m.stop).toHaveBeenCalledOnce();
      expect(moduleJobsStarted(id)).toBe(false);
    },
  );

  it.each(hooks)(
    'counts a failure of the %s hook after the wait as a failed attempt, leaves the module not started, and tries it again on the next pass',
    async (which) => {
      const id = `failed-late-${which}`;
      const jobsCalls = which === 'jobs' ? 1 : 0;
      const m = moduleWithHungStart(id, which);
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
      const { reconcile, stopAll } = await startModuleJobs([m.loaded], [m.entry], new Set([id]));

      const pass = track(reconcile(new Set()));
      await vi.advanceTimersByTimeAsync(MODULE_JOB_START_WAIT_MS);
      expect(pass.settled).toBe(true);
      expect(warn).not.toHaveBeenCalledWith(
        expect.objectContaining({ attempt: expect.anything() }),
        expect.any(String),
      );

      m.end().reject(new Error('no queue'));
      await vi.advanceTimersByTimeAsync(0);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ module: id, attempt: 1, err: expect.any(Error) }),
        expect.any(String),
      );
      expect(error).not.toHaveBeenCalled();
      expect(moduleJobsStarted(id)).toBe(false);

      await reconcile(new Set());
      expect(m.ensure).toHaveBeenCalledTimes(2);
      expect(m.jobs).toHaveBeenCalledTimes(jobsCalls + 1);
      expect(moduleJobsStarted(id)).toBe(true);

      await stopAll();
    },
  );

  it('does not count a start that fails after a pass saw its module deactivated against the activation after it', async () => {
    const id = 'toggled-late';
    const m = moduleWithHungStart(id, 'ensureSchema');
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { reconcile, stopAll } = await startModuleJobs([m.loaded], [m.entry], new Set([id]));

    const pass = track(reconcile(new Set()));
    await vi.advanceTimersByTimeAsync(MODULE_JOB_START_WAIT_MS);
    expect(pass.settled).toBe(true);
    await reconcile(new Set([id]));

    m.ensure.mockRejectedValue(new Error('ddl refused'));
    m.end().reject(new Error('ddl refused'));
    await vi.advanceTimersByTimeAsync(0);
    for (let next = 0; next < 5; next++) await reconcile(new Set());
    expect(m.ensure).toHaveBeenCalledTimes(1 + 3);

    await stopAll();
  });

  it.each(hooks)(
    'starts the jobs of a module once when it is deactivated and activated again while its %s hook still runs',
    async (which) => {
      const id = `flipped-${which}`;
      const m = moduleWithHungStart(id, which);
      vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const { reconcile, stopAll } = await startModuleJobs([m.loaded], [m.entry], new Set([id]));

      const pass = track(reconcile(new Set()));
      await vi.advanceTimersByTimeAsync(MODULE_JOB_START_WAIT_MS);
      expect(pass.settled).toBe(true);

      await reconcile(new Set([id]));
      await reconcile(new Set());
      await reconcile(new Set());
      expect(m.ensure).toHaveBeenCalledOnce();
      expect(m.jobs).toHaveBeenCalledTimes(which === 'jobs' ? 1 : 0);

      m.end().resolve();
      await vi.advanceTimersByTimeAsync(0);
      await reconcile(new Set());
      expect(m.ensure).toHaveBeenCalledOnce();
      expect(m.jobs).toHaveBeenCalledOnce();
      expect(moduleJobsStarted(id)).toBe(true);

      await stopAll();
      expect(m.stop).toHaveBeenCalledOnce();
    },
  );

  it.each(hooks)(
    'does not wait on a module deactivated while its %s hook still runs, and stops it on the first pass after the start ends',
    async (which) => {
      const id = `off-while-starting-${which}`;
      const m = moduleWithHungStart(id, which);
      vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const { reconcile, stopAll } = await startModuleJobs([m.loaded], [m.entry], new Set([id]));

      const first = track(reconcile(new Set()));
      await vi.advanceTimersByTimeAsync(MODULE_JOB_START_WAIT_MS);
      expect(first.settled).toBe(true);

      const during = track(reconcile(new Set([id])));
      await vi.advanceTimersByTimeAsync(0);
      expect(during.settled).toBe(true);
      expect(moduleJobsStarted(id)).toBe(true);

      m.end().resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(m.jobs).toHaveBeenCalledOnce();
      expect(m.stop).not.toHaveBeenCalled();
      expect(moduleJobsStarted(id)).toBe(true);

      await reconcile(new Set([id]));
      expect(m.stop).toHaveBeenCalledOnce();
      expect(moduleJobsStarted(id)).toBe(false);

      await reconcile(new Set());
      expect(m.jobs).toHaveBeenCalledTimes(2);
      expect(moduleJobsStarted(id)).toBe(true);

      await stopAll();
    },
  );

  it('warns once for each start that outlives the wait, naming the module and the wait, and not again for later passes', async () => {
    const slowSchema = moduleWithHungStart('slow-schema', 'ensureSchema');
    const slowJobs = moduleWithHungStart('slow-jobs', 'jobs');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { reconcile } = await startModuleJobs(
      [slowSchema.loaded, slowJobs.loaded],
      [slowSchema.entry, slowJobs.entry],
      new Set(['slow-schema', 'slow-jobs']),
    );

    const pass = track(reconcile(new Set()));
    await vi.advanceTimersByTimeAsync(MODULE_JOB_START_WAIT_MS * 2);
    expect(pass.settled).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
    for (const module of ['slow-schema', 'slow-jobs']) {
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ module, waitMs: MODULE_JOB_START_WAIT_MS }),
        expect.any(String),
      );
    }

    await reconcile(new Set());
    await reconcile(new Set(['slow-schema', 'slow-jobs']));
    await vi.advanceTimersByTimeAsync(MODULE_JOB_START_WAIT_MS * 2);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('logs no warning for a start that ends within the wait, however long the clock then runs', async () => {
    const m = moduleWithJobs('nearly-started');
    m.jobs.mockImplementationOnce(
      () =>
        new Promise<typeof m.stop>((resolve) =>
          setTimeout(() => resolve(m.stop), MODULE_JOB_START_WAIT_MS - 1),
        ),
    );
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { reconcile, stopAll } = await startModuleJobs(
      [m.loaded],
      [m.entry],
      new Set(['nearly-started']),
    );

    const pass = track(reconcile(new Set()));
    await vi.advanceTimersByTimeAsync(MODULE_JOB_START_WAIT_MS - 1);
    expect(pass.settled).toBe(true);
    expect(moduleJobsStarted('nearly-started')).toBe(true);

    await vi.advanceTimersByTimeAsync(MODULE_JOB_START_WAIT_MS * 2);
    expect(warn).not.toHaveBeenCalled();

    await stopAll();
  });

  it.each(hooks)(
    'keeps a module whose %s hook still runs marked as started, so its teardown is refused until the start has failed',
    async (which) => {
      const id = `pinned-${which}`;
      const m = moduleWithHungStart(id, which);
      const teardown = vi.fn<Hook>(async () => {});
      vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      vi.spyOn(logger, 'error').mockImplementation(() => undefined);
      const { reconcile } = await startModuleJobs([m.loaded], [m.entry], new Set([id]));

      const pass = track(reconcile(new Set()));
      await vi.advanceTimersByTimeAsync(MODULE_JOB_START_WAIT_MS);
      expect(pass.settled).toBe(true);
      expect(moduleJobsStarted(id)).toBe(true);

      const refusal = (await runModuleTeardown(teardownDeps(m, teardown), id).catch(
        (err: unknown) => err,
      )) as Error;
      expect(refusal).toBeInstanceOf(ModuleTeardownRefusedError);
      expect(refusal.message).toMatch(new RegExp(`${id}.*still running`));
      expect(teardown).not.toHaveBeenCalled();

      m.end().reject(new Error('no queue'));
      await vi.advanceTimersByTimeAsync(0);
      expect(moduleJobsStarted(id)).toBe(false);
      await runModuleTeardown(teardownDeps(m, teardown), id);
      expect(teardown).toHaveBeenCalledOnce();
    },
  );

  it('goes on after the wait without the schema setup of a module that has no jobs, and ensures it once', async () => {
    const m = moduleWithSchemaOnly('schema-only-hung');
    let endEnsure!: () => void;
    m.ensure.mockImplementationOnce(() => new Promise<void>((resolve) => (endEnsure = resolve)));
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { reconcile } = await startModuleJobs(
      [m.loaded],
      [m.entry],
      new Set(['schema-only-hung']),
    );

    const pass = track(reconcile(new Set()));
    await vi.advanceTimersByTimeAsync(MODULE_JOB_START_WAIT_MS);
    expect(pass.settled).toBe(true);
    expect(moduleJobsStarted('schema-only-hung')).toBe(true);

    await reconcile(new Set());
    expect(m.ensure).toHaveBeenCalledOnce();

    endEnsure();
    await vi.advanceTimersByTimeAsync(0);
    expect(moduleJobsStarted('schema-only-hung')).toBe(false);

    await reconcile(new Set());
    expect(m.ensure).toHaveBeenCalledOnce();
  });
});
