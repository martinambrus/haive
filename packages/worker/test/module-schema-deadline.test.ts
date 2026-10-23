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
  MODULE_JOB_START_WAIT_MS,
  MODULE_SCHEMA_ENSURE_TIMEOUT_MS,
  ensureModuleSchemas,
  moduleJobsStarted,
  moduleTeardownRunning,
  startModuleJobs,
} = await import('../src/modules/loader.js');
const { ModuleTeardownRefusedError, runModuleTeardown } =
  await import('../src/queues/module-control-queue.js');
const { markModuleSchemaReady, markModuleSchemaUnready, moduleSchemaUnready } =
  await import('../src/modules/schema-ready.js');

type Loaded = Parameters<typeof startModuleJobs>[0][number];
type Entry = Parameters<typeof startModuleJobs>[1][number];
type Hook = NonNullable<Entry['teardown']>;

const DEADLINE_MS = 10 * 60_000;
const DRAIN_MS = 5_000;

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

const teardownDeps = (m: { loaded: Loaded; entry: Entry }, teardown: Hook) => ({
  db: deactivatedRowDb,
  loaded: [m.loaded],
  entries: [{ ...m.entry, teardown }],
  jobsStarted: moduleJobsStarted,
  teardownRunning: moduleTeardownRunning,
});

type Ending = { resolve: () => void; reject: (err: Error) => void };

function moduleWithSchema(id: string, hangs: 'once' | 'always' | 'never' = 'once') {
  const stop = vi.fn(async () => {});
  const jobs = vi.fn(async () => stop);
  const ensure = vi.fn(async () => {});
  let end!: Ending;
  const hang = () => new Promise<void>((resolve, reject) => (end = { resolve, reject }));
  if (hangs === 'once') ensure.mockImplementationOnce(hang);
  if (hangs === 'always') ensure.mockImplementation(hang);
  return {
    loaded: { manifest: { id } } as unknown as Loaded,
    entry: { jobs, ensureSchema: ensure } as unknown as Entry,
    jobs,
    ensure,
    end: () => end,
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

const used: string[] = [];
const fresh = (id: string, hangs?: 'once' | 'always' | 'never') => {
  used.push(id);
  return moduleWithSchema(id, hangs);
};

describe('the deadline on a module schema setup', () => {
  beforeEach(() => {
    moduleDb.gate = undefined;
    moduleDb.opened.mockClear();
    moduleDb.closed.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    moduleDb.gate = undefined;
    for (const id of used.splice(0)) markModuleSchemaReady(id);
  });

  it('cuts off a boot schema setup that never settles, frees the teardown and leaves the module unready', async () => {
    const id = 'deadline-boot';
    const m = fresh(id);
    const hook = vi.fn<Hook>(async () => {});
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const ensuring = ensureModuleSchemas({} as Database, [m.loaded], [m.entry], new Set());
    await vi.advanceTimersByTimeAsync(MODULE_JOB_START_WAIT_MS);
    expect(await ensuring).toEqual({ [id]: 'pending' });
    expect(moduleJobsStarted(id)).toBe(true);
    expect(m.ensure).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1 - MODULE_JOB_START_WAIT_MS);
    expect(moduleJobsStarted(id)).toBe(true);

    await vi.advanceTimersByTimeAsync(1 + DRAIN_MS);
    expect(moduleJobsStarted(id)).toBe(false);
    expect(moduleDb.closed).toHaveBeenCalledOnce();
    expect(moduleSchemaUnready(id)).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({
          message: expect.stringMatching(/did not finish within 600 s/),
        }),
      }),
      expect.any(String),
    );
    await runModuleTeardown(teardownDeps(m, hook), id);
    expect(hook).toHaveBeenCalledOnce();
  });

  it('cuts off a schema setup of the reconcile pass the same way', async () => {
    const id = 'deadline-pass';
    const m = fresh(id);
    const hook = vi.fn<Hook>(async () => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { reconcile } = await startModuleJobs([m.loaded], [m.entry], new Set([id]));

    const pass = track(reconcile(new Set()));
    await vi.advanceTimersByTimeAsync(MODULE_JOB_START_WAIT_MS);
    expect(pass.settled).toBe(true);
    expect(moduleJobsStarted(id)).toBe(true);

    await vi.advanceTimersByTimeAsync(DEADLINE_MS + DRAIN_MS);
    expect(moduleJobsStarted(id)).toBe(false);
    await runModuleTeardown(teardownDeps(m, hook), id);
    expect(hook).toHaveBeenCalledOnce();
  });

  it('tries a schema setup that never settles three times, then only logs the way out', async () => {
    const id = 'deadline-retry';
    const m = fresh(id, 'always');
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { reconcile } = await startModuleJobs([m.loaded], [m.entry], new Set([id]));

    const pass = async () => {
      const running = track(reconcile(new Set()));
      await vi.advanceTimersByTimeAsync(MODULE_JOB_START_WAIT_MS);
      expect(running.settled).toBe(true);
    };

    await pass();
    expect(m.ensure).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS + DRAIN_MS);
    expect(error).not.toHaveBeenCalled();

    await pass();
    expect(m.ensure).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS + DRAIN_MS);

    await pass();
    expect(m.ensure).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS + DRAIN_MS);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ module: id }),
      expect.stringMatching(/deactivate and reactivate/),
    );

    await reconcile(new Set());
    expect(m.ensure).toHaveBeenCalledTimes(3);
  });

  it('closes a module database that opens after the deadline and never runs the setup on it', async () => {
    const id = 'deadline-late-open';
    const m = fresh(id, 'never');
    let openGate!: () => void;
    moduleDb.gate = new Promise<void>((resolve) => (openGate = resolve));
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const ensuring = ensureModuleSchemas({} as Database, [m.loaded], [m.entry], new Set());
    await vi.advanceTimersByTimeAsync(MODULE_JOB_START_WAIT_MS);
    expect(await ensuring).toEqual({ [id]: 'pending' });

    await vi.advanceTimersByTimeAsync(DEADLINE_MS + DRAIN_MS);
    expect(moduleDb.opened).toHaveBeenCalledOnce();
    openGate();
    await vi.advanceTimersByTimeAsync(0);

    expect(m.ensure).not.toHaveBeenCalled();
    expect(moduleDb.closed).toHaveBeenCalledOnce();
    expect(moduleSchemaUnready(id)).toBe(true);
  });

  it('ignores a boot schema setup that settles after the deadline', async () => {
    const id = 'deadline-late-boot';
    const m = fresh(id);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const ensuring = ensureModuleSchemas({} as Database, [m.loaded], [m.entry], new Set());
    await vi.advanceTimersByTimeAsync(MODULE_JOB_START_WAIT_MS);
    expect(await ensuring).toEqual({ [id]: 'pending' });
    await vi.advanceTimersByTimeAsync(DEADLINE_MS + DRAIN_MS);

    m.end().resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(moduleSchemaUnready(id)).toBe(true);
    expect(moduleJobsStarted(id)).toBe(false);
  });

  it('ignores a pass schema setup that settles after the deadline', async () => {
    const id = 'deadline-late-pass';
    const m = fresh(id);
    markModuleSchemaUnready(id);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { reconcile } = await startModuleJobs([m.loaded], [m.entry], new Set([id]));
    const pass = track(reconcile(new Set()));
    await vi.advanceTimersByTimeAsync(MODULE_JOB_START_WAIT_MS);
    expect(pass.settled).toBe(true);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS + DRAIN_MS);

    m.end().resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(moduleSchemaUnready(id)).toBe(true);
    expect(moduleJobsStarted(id)).toBe(false);
  });

  const slowClose = () => {
    let release!: () => void;
    moduleDb.closed.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    return () => release();
  };

  it('rejects a boot schema setup that settles while the expired close is still pending', async () => {
    const id = 'deadline-close-window-boot';
    const m = fresh(id);
    const release = slowClose();
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const ensuring = ensureModuleSchemas({} as Database, [m.loaded], [m.entry], new Set());
    await vi.advanceTimersByTimeAsync(MODULE_JOB_START_WAIT_MS);
    expect(await ensuring).toEqual({ [id]: 'pending' });
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);

    m.end().resolve();
    await vi.advanceTimersByTimeAsync(0);
    release();
    await vi.advanceTimersByTimeAsync(DRAIN_MS);

    expect(moduleSchemaUnready(id)).toBe(true);
    expect(moduleJobsStarted(id)).toBe(false);
  });

  it('rejects a pass schema setup that settles while the expired close is still pending', async () => {
    const id = 'deadline-close-window-pass';
    const m = fresh(id);
    markModuleSchemaUnready(id);
    const release = slowClose();
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { reconcile } = await startModuleJobs([m.loaded], [m.entry], new Set([id]));
    const pass = track(reconcile(new Set()));
    await vi.advanceTimersByTimeAsync(MODULE_JOB_START_WAIT_MS);
    expect(pass.settled).toBe(true);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);

    m.end().resolve();
    await vi.advanceTimersByTimeAsync(0);
    release();
    await vi.advanceTimersByTimeAsync(DRAIN_MS);

    expect(moduleSchemaUnready(id)).toBe(true);
    expect(moduleJobsStarted(id)).toBe(false);
  });

  it('rejects a schema setup whose database opens after the deadline and closes later', async () => {
    const id = 'deadline-late-open-reject';
    const m = fresh(id, 'never');
    const release = slowClose();
    let openGate!: () => void;
    moduleDb.gate = new Promise<void>((resolve) => (openGate = resolve));
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const ensuring = ensureModuleSchemas({} as Database, [m.loaded], [m.entry], new Set());
    await vi.advanceTimersByTimeAsync(MODULE_JOB_START_WAIT_MS);
    expect(await ensuring).toEqual({ [id]: 'pending' });
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);

    openGate();
    await vi.advanceTimersByTimeAsync(0);
    release();
    await vi.advanceTimersByTimeAsync(DRAIN_MS);

    expect(m.ensure).not.toHaveBeenCalled();
    expect(moduleSchemaUnready(id)).toBe(true);
    expect(moduleJobsStarted(id)).toBe(false);
  });

  it('leaves no timer and no warning behind a schema setup that ends in time', async () => {
    const id = 'deadline-in-time';
    const m = fresh(id, 'never');
    m.ensure.mockImplementationOnce(
      () => new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    );
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const ensuring = ensureModuleSchemas({} as Database, [m.loaded], [m.entry], new Set());
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await ensuring).toEqual({ [id]: 'ok' });
    expect(vi.getTimerCount()).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('exports the deadline as ten minutes', () => {
    expect(MODULE_SCHEMA_ENSURE_TIMEOUT_MS).toBe(600_000);
  });

  it('names the deadline in the teardown refusal', async () => {
    const id = 'deadline-wording';
    const m = fresh(id);
    const hook = vi.fn<Hook>(async () => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const ensuring = ensureModuleSchemas({} as Database, [m.loaded], [m.entry], new Set());
    await vi.advanceTimersByTimeAsync(MODULE_JOB_START_WAIT_MS);
    await ensuring;

    const refusal = (await runModuleTeardown(teardownDeps(m, hook), id).catch(
      (err: unknown) => err,
    )) as Error;
    expect(refusal).toBeInstanceOf(ModuleTeardownRefusedError);
    expect(refusal.message).toMatch(/schema setup.*cut off after 10 minutes/);
    expect(hook).not.toHaveBeenCalled();
  });
});
