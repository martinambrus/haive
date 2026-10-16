import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { logger } from '@haive/shared';

const h = vi.hoisted(() => {
  const fake = (id: string) => {
    const stop = vi.fn(async () => {});
    return { id, ensure: vi.fn(async () => {}), jobs: vi.fn(async () => stop), stop };
  };
  return {
    alpha: fake('alpha'),
    beta: fake('beta'),
    reports: [] as string[],
    deactivated: vi.fn<(db: unknown) => Promise<Set<string>>>(),
  };
});

vi.mock('../src/redis.js', () => ({
  getRedis: () => ({ set: async (_key: string, value: string) => void h.reports.push(value) }),
  getBullRedis: () => ({}),
}));
vi.mock('../src/db.js', () => ({ getDb: () => ({}) }));
vi.mock('@haive/shared/module-db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/module-db')>()),
  openModuleDatabase: async () => ({
    sql: {},
    withSchemaLock: async (run: (tx: unknown) => unknown) => run({}),
    close: async () => {},
  }),
}));
vi.mock('../src/modules.generated.js', () => ({
  moduleRegistry: [h.alpha, h.beta].map((m) => ({
    packageName: `@haive/module-${m.id}`,
    manifest: { id: m.id, name: m.id, version: '1.0.0', schemaVersion: 1 },
    ensureSchema: m.ensure,
    jobs: m.jobs,
  })),
}));
vi.mock('../src/modules/activation.js', () => ({ deactivatedModuleIds: h.deactivated }));
vi.mock('../src/modules/intent.js', () => ({ syncModuleIntent: async () => {} }));
vi.mock('../src/step-engine/step-catalog.js', () => ({ syncStepCatalog: async () => {} }));
vi.mock('../src/step-engine/task-type-seed.js', () => ({
  syncTaskTypeDefinitions: async () => ({}),
}));

const { bootStepEngine } = await import('../src/step-engine/boot.js');
const { MODULE_JOB_START_WAIT_MS, startModuleJobs } = await import('../src/modules/loader.js');

const db = {} as Database;

const reportedSchemas = (): Record<string, string> =>
  Object.fromEntries(
    (
      JSON.parse(h.reports.at(-1)!) as { modules: { id: string; ensureSchema: string }[] }
    ).modules.map((m) => [m.id, m.ensureSchema]),
  );

const track = (promise: Promise<unknown>) => {
  const state = { settled: false };
  const settle = () => {
    state.settled = true;
  };
  void promise.then(settle, settle);
  return state;
};

describe('the worker boot with a module schema ensure that does not end', () => {
  beforeAll(async () => {
    h.deactivated.mockResolvedValue(new Set());
    await bootStepEngine(db);
  }, 120_000);

  beforeEach(() => {
    vi.useFakeTimers();
    h.reports.length = 0;
    h.deactivated.mockReset();
    h.deactivated.mockResolvedValue(new Set());
    for (const m of [h.alpha, h.beta]) {
      m.ensure.mockReset();
      m.ensure.mockImplementation(async () => {});
      m.jobs.mockClear();
      m.stop.mockClear();
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('goes on to the report after the wait, naming the module and reporting its schema as pending', async () => {
    h.alpha.ensure.mockImplementationOnce(() => new Promise<void>(() => {}));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const booting = bootStepEngine(db);
    const boot = track(booting);
    await vi.advanceTimersByTimeAsync(MODULE_JOB_START_WAIT_MS - 1);
    expect(boot.settled).toBe(false);
    expect(h.reports).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(boot.settled).toBe(true);
    await booting;
    expect(reportedSchemas()).toEqual({ alpha: 'pending', beta: 'ok' });
    expect(h.beta.ensure).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ module: 'alpha', waitMs: MODULE_JOB_START_WAIT_MS }),
      expect.stringMatching(/still starting/),
    );
  });

  it('holds the jobs of that module back until the first pass has ensured its schema again, and starts the others', async () => {
    h.alpha.ensure.mockImplementationOnce(() => new Promise<void>(() => {}));
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const booting = bootStepEngine(db);
    const boot = track(booting);
    await vi.advanceTimersByTimeAsync(MODULE_JOB_START_WAIT_MS);
    expect(boot.settled).toBe(true);
    const booted = await booting;
    expect([...booted.deactivated]).toEqual(['alpha']);

    const { reconcile, stopAll } = await startModuleJobs(
      booted.loaded,
      booted.entries,
      booted.deactivated,
    );
    expect(h.alpha.jobs).not.toHaveBeenCalled();
    expect(h.beta.jobs).toHaveBeenCalledOnce();

    await reconcile(new Set());
    expect(h.alpha.ensure).toHaveBeenCalledTimes(2);
    expect(h.alpha.jobs).toHaveBeenCalledOnce();
    expect(h.alpha.ensure.mock.invocationCallOrder[1]).toBeLessThan(
      h.alpha.jobs.mock.invocationCallOrder[0]!,
    );
    expect(h.beta.ensure).toHaveBeenCalledOnce();
    expect(h.beta.jobs).toHaveBeenCalledOnce();

    await stopAll();
    expect(h.alpha.stop).toHaveBeenCalledOnce();
    expect(h.beta.stop).toHaveBeenCalledOnce();
  });

  it('reports every schema as it did and holds back only the deactivated module when no ensure is late', async () => {
    h.deactivated.mockResolvedValue(new Set(['alpha']));

    const booted = await bootStepEngine(db);

    expect(reportedSchemas()).toEqual({ alpha: 'deactivated', beta: 'ok' });
    expect([...booted.deactivated]).toEqual(['alpha']);
    expect(vi.getTimerCount()).toBe(0);
  });
});
