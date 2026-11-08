import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@haive/shared';
import { MODULES_LOADED_WORKER_KEY, MODULE_RUNTIME_REASON_MAX } from '@haive/shared/modularity';
import { markModuleSchemaUnready } from '../src/modules/schema-ready.js';

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

const { MODULE_JOB_START_WAIT_MS, publishWorkerBootReport, startModuleJobs } =
  await import('../src/modules/loader.js');

type Loaded = Parameters<typeof startModuleJobs>[0][number];
type Entry = Parameters<typeof startModuleJobs>[1][number];
type Redis = Parameters<typeof publishWorkerBootReport>[0];

type ReportModule = Record<string, unknown> & { id: string; runtime?: Record<string, unknown> };

function makeModule(
  id: string,
  hooks: { jobs?: boolean; ensureSchema?: boolean } = { jobs: true },
) {
  const stop = vi.fn(async () => {});
  const jobs = vi.fn(async () => stop);
  const ensure = vi.fn(async () => {});
  const entry: Record<string, unknown> = {};
  if (hooks.jobs) entry.jobs = jobs;
  if (hooks.ensureSchema) entry.ensureSchema = ensure;
  return {
    id,
    loaded: {
      packageName: `@haive/module-${id}`,
      manifest: { id, version: '1.2.3' },
      stepIds: [`${id}-step`],
      composable: [],
    } as unknown as Loaded,
    entry: entry as unknown as Entry,
    jobs,
    ensure,
    stop,
  };
}

type Mod = ReturnType<typeof makeModule>;

function fakeRedis() {
  const set = vi.fn(async (..._args: unknown[]): Promise<unknown> => 'OK');
  return { set, redis: { set } as unknown as Redis };
}

const reports = (set: ReturnType<typeof fakeRedis>['set']) =>
  set.mock.calls
    .filter((call) => call[0] === MODULES_LOADED_WORKER_KEY)
    .map((call) => JSON.parse(call[1] as string) as { at: string; modules: ReportModule[] });

const lastModule = (set: ReturnType<typeof fakeRedis>['set'], id: string): ReportModule => {
  const all = reports(set);
  const found = all[all.length - 1]!.modules.find((m) => m.id === id);
  expect(found).toBeDefined();
  return found!;
};

const runtimeOf = (set: ReturnType<typeof fakeRedis>['set'], id: string) =>
  lastModule(set, id).runtime;

async function boot(mods: Mod[], deactivated: ReadonlySet<string> = new Set()) {
  const { set, redis } = fakeRedis();
  await publishWorkerBootReport(
    redis,
    mods.map((m) => m.loaded),
    {},
    {},
  );
  const handle = await startModuleJobs(
    mods.map((m) => m.loaded),
    mods.map((m) => m.entry),
    deactivated,
  );
  return { set, redis, handle };
}

const stamp = (moduleId: string, at: number) => new Map([[moduleId, at]]);

describe('the per-module runtime in the worker report', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('W1 reports a module whose jobs started at boot as ready, and leaves the other fields as published', async () => {
    const m = makeModule('rt-w1');
    const { set, handle } = await boot([m]);

    expect(runtimeOf(set, m.id)).toEqual({
      state: 'ready',
      schema: 'none',
      jobs: 'running',
      attempts: 0,
      reason: null,
    });
    const { runtime: _runtime, ...rest } = lastModule(set, m.id);
    const { runtime: _bootRuntime, ...bootRest } = reports(set)[0]!.modules[0]!;
    expect(rest).toEqual(bootRest);
    await handle.stopAll();
  });

  it('W2 reports a failing start as pending with its attempts and the error text', async () => {
    const m = makeModule('rt-w2');
    m.jobs.mockRejectedValue(new Error('boom-w2'));
    const { set, handle } = await boot([m], new Set([m.id]));

    await handle.reconcile(new Set());
    expect(runtimeOf(set, m.id)).toMatchObject({
      state: 'pending',
      schema: 'none',
      jobs: 'stopped',
      attempts: 1,
    });
    expect(String(runtimeOf(set, m.id)?.reason)).toContain('boom-w2');

    await handle.reconcile(new Set());
    expect(runtimeOf(set, m.id)).toMatchObject({ state: 'pending', jobs: 'stopped', attempts: 2 });
    expect(String(runtimeOf(set, m.id)?.reason)).toContain('boom-w2');
  });

  it('W3 reports a module that used all its attempts as failed, with the error text', async () => {
    const m = makeModule('rt-w3');
    m.jobs.mockRejectedValue(new Error('boom-w3'));
    const { set, handle } = await boot([m], new Set([m.id]));

    for (let pass = 0; pass < 3; pass++) await handle.reconcile(new Set());
    expect(runtimeOf(set, m.id)).toMatchObject({
      state: 'failed',
      schema: 'none',
      jobs: 'stopped',
      attempts: 3,
    });
    expect(String(runtimeOf(set, m.id)?.reason)).toContain('boom-w3');
    expect(m.jobs).toHaveBeenCalledTimes(3);
  });

  it('W4 reports a failing schema ensure as schema failed, and never starts the jobs', async () => {
    const m = makeModule('rt-w4', { jobs: true, ensureSchema: true });
    m.ensure.mockRejectedValue(new Error('ddl-refused-w4'));
    const { set, handle } = await boot([m], new Set([m.id]));

    for (let pass = 0; pass < 3; pass++) await handle.reconcile(new Set());
    expect(runtimeOf(set, m.id)).toMatchObject({
      state: 'failed',
      schema: 'failed',
      jobs: 'stopped',
      attempts: 3,
    });
    expect(String(runtimeOf(set, m.id)?.reason)).toContain('ddl-refused-w4');
    expect(m.jobs).not.toHaveBeenCalled();
  });

  it('W5 reports a failed module as ready with no attempts once a new stamp lets it start', async () => {
    const m = makeModule('rt-w5');
    m.jobs.mockRejectedValue(new Error('boom-w5'));
    const { set, handle } = await boot([m], new Set([m.id]));

    for (let pass = 0; pass < 3; pass++) await handle.reconcile(new Set(), stamp(m.id, 1000));
    expect(runtimeOf(set, m.id)).toMatchObject({ state: 'failed', attempts: 3 });

    m.jobs.mockReset();
    m.jobs.mockImplementation(async () => m.stop);
    await handle.reconcile(new Set(), stamp(m.id, 2000));
    expect(runtimeOf(set, m.id)).toEqual({
      state: 'ready',
      schema: 'none',
      jobs: 'running',
      attempts: 0,
      reason: null,
    });
    await handle.stopAll();
  });

  it('W5b restarts the attempts at a new stamp while the hook still fails', async () => {
    const m = makeModule('rt-w5b');
    m.jobs.mockRejectedValue(new Error('boom-w5b'));
    const { set, handle } = await boot([m], new Set([m.id]));

    for (let pass = 0; pass < 3; pass++) await handle.reconcile(new Set(), stamp(m.id, 1000));
    expect(runtimeOf(set, m.id)).toMatchObject({ state: 'failed', attempts: 3 });

    await handle.reconcile(new Set(), stamp(m.id, 2000));
    expect(runtimeOf(set, m.id)).toMatchObject({ state: 'pending', jobs: 'stopped', attempts: 1 });
  });

  it('W6 drops the runtime of a ready module once it is deactivated', async () => {
    const m = makeModule('rt-w6');
    const { set, handle } = await boot([m]);
    expect(runtimeOf(set, m.id)).toMatchObject({ state: 'ready', jobs: 'running' });

    await handle.reconcile(new Set([m.id]));
    expect(m.stop).toHaveBeenCalledOnce();
    expect('runtime' in lastModule(set, m.id)).toBe(false);
  });

  it('W6b drops the runtime of a failed module once it is deactivated', async () => {
    const m = makeModule('rt-w6b');
    m.jobs.mockRejectedValue(new Error('boom-w6b'));
    const { set, handle } = await boot([m], new Set([m.id]));
    for (let pass = 0; pass < 3; pass++) await handle.reconcile(new Set(), stamp(m.id, 1000));
    expect(runtimeOf(set, m.id)).toMatchObject({ state: 'failed', attempts: 3 });

    await handle.reconcile(new Set([m.id]), stamp(m.id, 1500));
    expect('runtime' in lastModule(set, m.id)).toBe(false);
  });

  it('W6c reports attempts from zero when a failed, deactivated module is activated again', async () => {
    const m = makeModule('rt-w6c');
    m.jobs.mockRejectedValue(new Error('boom-w6c'));
    const { set, handle } = await boot([m], new Set([m.id]));
    for (let pass = 0; pass < 3; pass++) await handle.reconcile(new Set(), stamp(m.id, 1000));
    await handle.reconcile(new Set([m.id]), stamp(m.id, 1500));

    m.jobs.mockReset();
    m.jobs.mockImplementation(async () => m.stop);
    await handle.reconcile(new Set(), stamp(m.id, 2000));
    expect(runtimeOf(set, m.id)).toEqual({
      state: 'ready',
      schema: 'none',
      jobs: 'running',
      attempts: 0,
      reason: null,
    });
    await handle.stopAll();
  });

  it('W7 writes nothing for a pass that changes no runtime', async () => {
    const m = makeModule('rt-w7');
    m.jobs.mockRejectedValue(new Error('boom-w7'));
    const { set, handle } = await boot([m], new Set([m.id]));
    for (let pass = 0; pass < 3; pass++) await handle.reconcile(new Set());
    expect(runtimeOf(set, m.id)).toMatchObject({ state: 'failed', attempts: 3 });

    const before = set.mock.calls.length;
    await handle.reconcile(new Set());
    await handle.reconcile(new Set());
    expect(set.mock.calls.length).toBe(before);
  });

  it('W8 gives a module with neither jobs nor ensureSchema no runtime, and changes none of its fields', async () => {
    const plain = makeModule('rt-w8', {});
    const failing = makeModule('rt-w8-other');
    failing.jobs.mockRejectedValue(new Error('boom-w8'));
    const { set, handle } = await boot([plain, failing], new Set([failing.id]));

    for (let pass = 0; pass < 3; pass++) await handle.reconcile(new Set());
    for (const report of reports(set)) {
      const found = report.modules.find((m) => m.id === plain.id)!;
      expect('runtime' in found).toBe(false);
      expect(found).toEqual(reports(set)[0]!.modules.find((m) => m.id === plain.id));
    }
    expect(runtimeOf(set, failing.id)).toMatchObject({ state: 'failed', attempts: 3 });
  });

  it('W9 goes on with its attempts when the report cannot be written', async () => {
    const m = makeModule('rt-w9');
    m.jobs.mockRejectedValue(new Error('boom-w9'));
    const { set, redis } = fakeRedis();
    await publishWorkerBootReport(redis, [m.loaded], {}, {});
    set.mockRejectedValue(new Error('redis down'));
    const handle = await startModuleJobs([m.loaded], [m.entry], new Set([m.id]));

    for (let pass = 0; pass < 3; pass++)
      await expect(handle.reconcile(new Set())).resolves.toBeUndefined();
    expect(m.jobs).toHaveBeenCalledTimes(3);
    expect(set.mock.calls.length).toBeGreaterThan(1);
  });

  it('W10 cuts the reason of a long error to MODULE_RUNTIME_REASON_MAX', async () => {
    expect(MODULE_RUNTIME_REASON_MAX).toBe(500);
    const m = makeModule('rt-w10');
    m.jobs.mockRejectedValue(new Error('x'.repeat(5000)));
    const { set, handle } = await boot([m], new Set([m.id]));

    await handle.reconcile(new Set());
    const runtime = runtimeOf(set, m.id);
    expect(runtime).toBeDefined();
    const reason = runtime!.reason as string;
    expect(reason.length).toBeGreaterThan(0);
    expect(reason.length).toBeLessThanOrEqual(MODULE_RUNTIME_REASON_MAX);
  });

  it('W11 reports an attempt still in flight as pending, and ready once it ends', async () => {
    const m = makeModule('rt-w11');
    let release!: () => void;
    m.jobs.mockImplementationOnce(
      () => new Promise<typeof m.stop>((resolve) => (release = () => resolve(m.stop))),
    );
    const { set, handle } = await boot([m], new Set([m.id]));

    const pass = handle.reconcile(new Set());
    await vi.advanceTimersByTimeAsync(0);
    // The attempt has begun and not ended: the report says so before the pass returns.
    expect(runtimeOf(set, m.id)).toMatchObject({ state: 'pending', jobs: 'stopped', attempts: 0 });
    await vi.advanceTimersByTimeAsync(MODULE_JOB_START_WAIT_MS);
    await pass;
    expect(runtimeOf(set, m.id)).toMatchObject({ state: 'pending', jobs: 'stopped', attempts: 0 });

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtimeOf(set, m.id)).toMatchObject({ state: 'ready', jobs: 'running', attempts: 0 });
    await handle.stopAll();
  });

  it('W12 reports a module whose schema is still unready as schema pending until the ensure ends', async () => {
    const m = makeModule('rt-w12', { jobs: true, ensureSchema: true });
    let finish!: () => void;
    m.ensure.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    markModuleSchemaUnready(m.id);
    const { set, handle } = await boot([m], new Set([m.id]));

    const pass = handle.reconcile(new Set());
    await vi.advanceTimersByTimeAsync(MODULE_JOB_START_WAIT_MS);
    await pass;
    expect(runtimeOf(set, m.id)).toMatchObject({
      state: 'pending',
      schema: 'pending',
      jobs: 'stopped',
      attempts: 0,
    });

    finish();
    await vi.advanceTimersByTimeAsync(10);
    expect(runtimeOf(set, m.id)).toEqual({
      state: 'ready',
      schema: 'ready',
      jobs: 'running',
      attempts: 0,
      reason: null,
    });
    await handle.stopAll();
  });

  it('W13 reports a module with only a schema hook as ready with no jobs, or failed when it cannot ensure', async () => {
    const ok = makeModule('rt-w13', { ensureSchema: true });
    const bad = makeModule('rt-w13-bad', { ensureSchema: true });
    bad.ensure.mockRejectedValue(new Error('ddl-refused-w13'));
    const { set, handle } = await boot([ok, bad], new Set([ok.id, bad.id]));

    await handle.reconcile(new Set());
    expect(runtimeOf(set, ok.id)).toEqual({
      state: 'ready',
      schema: 'ready',
      jobs: 'none',
      attempts: 0,
      reason: null,
    });
    for (let pass = 0; pass < 2; pass++) await handle.reconcile(new Set());
    expect(runtimeOf(set, bad.id)).toMatchObject({
      state: 'failed',
      schema: 'failed',
      jobs: 'none',
      attempts: 3,
    });
    expect(String(runtimeOf(set, bad.id)?.reason)).toContain('ddl-refused-w13');
    expect(bad.ensure).toHaveBeenCalledTimes(3);
  });

  it('W13b reports a module with only a schema hook as ready once boot has gone through it', async () => {
    const m = makeModule('rt-w13b', { ensureSchema: true });
    const { set } = await boot([m]);

    expect(runtimeOf(set, m.id)).toEqual({
      state: 'ready',
      schema: 'ready',
      jobs: 'none',
      attempts: 0,
      reason: null,
    });
  });
});
