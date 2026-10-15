import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { logger } from '@haive/shared';

const moduleDb = vi.hoisted(() => ({ opened: vi.fn(), closed: vi.fn(async () => {}) }));

vi.mock('../src/redis.js', () => ({ getBullRedis: () => ({}) }));
vi.mock('../src/db.js', () => ({ getDb: () => ({}) }));
vi.mock('@haive/shared/module-db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/module-db')>()),
  openModuleDatabase: async (_db: unknown, moduleId: string) => {
    moduleDb.opened(moduleId);
    return {
      sql: {},
      withSchemaLock: async (run: (tx: unknown) => unknown) => run({}),
      close: moduleDb.closed,
    };
  },
}));

const { beginModuleTeardown, moduleJobsStarted, startModuleJobs } =
  await import('../src/modules/loader.js');
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

function moduleWithSchema(id: string) {
  const base = moduleWithJobs(id);
  const ensure = vi.fn(async () => {});
  return { ...base, ensure, entry: { ...base.entry, ensureSchema: ensure } as Entry };
}

function moduleWithSchemaOnly(id: string) {
  const ensure = vi.fn(async () => {});
  return {
    loaded: { manifest: { id } } as unknown as Loaded,
    entry: { ensureSchema: ensure } as unknown as Entry,
    ensure,
  };
}

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

  it('logs a start that fails at runtime, and retries it only after a deactivation and a reactivation', async () => {
    const m = moduleWithJobs('broken');
    m.jobs.mockRejectedValueOnce(new Error('no queue'));
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { reconcile, stopAll } = await startModuleJobs(
      [m.loaded],
      [m.entry],
      new Set(['broken']),
    );

    await expect(reconcile(new Set())).resolves.toBeUndefined();
    expect(m.jobs).toHaveBeenCalledOnce();
    expect(moduleJobsStarted('broken')).toBe(false);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ module: 'broken', err: expect.any(Error) }),
      expect.any(String),
    );

    await reconcile(new Set());
    expect(m.jobs).toHaveBeenCalledOnce();

    await reconcile(new Set(['broken']));
    await reconcile(new Set());
    expect(m.jobs).toHaveBeenCalledTimes(2);
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

  it('starts no jobs when the schema of a reactivated module cannot be ensured, and tries again only after another reactivation', async () => {
    const m = moduleWithSchema('doomed');
    m.ensure.mockRejectedValueOnce(new Error('ddl refused'));
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { reconcile, stopAll } = await startModuleJobs(
      [m.loaded],
      [m.entry],
      new Set(['doomed']),
    );

    await expect(reconcile(new Set())).resolves.toBeUndefined();
    expect(m.ensure).toHaveBeenCalledOnce();
    expect(m.jobs).not.toHaveBeenCalled();
    expect(moduleJobsStarted('doomed')).toBe(false);
    expect(moduleDb.closed).toHaveBeenCalledOnce();
    const logged = error.mock.calls[0]![0] as unknown as { module: string; err: Error };
    expect(logged.module).toBe('doomed');
    expect(logged.err.message).toBe('Module doomed schema bootstrap failed: ddl refused');

    await reconcile(new Set());
    expect(m.ensure).toHaveBeenCalledOnce();
    expect(m.jobs).not.toHaveBeenCalled();

    await reconcile(new Set(['doomed']));
    await reconcile(new Set());
    expect(m.ensure).toHaveBeenCalledTimes(2);
    expect(m.jobs).toHaveBeenCalledOnce();
    expect(moduleJobsStarted('doomed')).toBe(true);

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

  it('holds a module back until every teardown running for it has ended', async () => {
    const m = moduleWithJobs('twice');
    const { reconcile, stopAll } = await startModuleJobs([m.loaded], [m.entry], new Set(['twice']));

    const endFirst = beginModuleTeardown('twice');
    const endSecond = beginModuleTeardown('twice');
    endFirst();
    await reconcile(new Set());
    expect(m.jobs).not.toHaveBeenCalled();

    endSecond();
    await reconcile(new Set());
    expect(m.jobs).toHaveBeenCalledOnce();

    await stopAll();
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
});
