import { afterEach, describe, expect, it, vi } from 'vitest';
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

const activation = await import('../src/modules/activation.js');
const { moduleDeactivationMessage } = activation;
const { markModuleSchemaReady, markModuleSchemaUnready } =
  await import('../src/modules/schema-ready.js');
const { beginModuleTeardown, startModuleJobs } = await import('../src/modules/loader.js');

type Loaded = Parameters<typeof startModuleJobs>[0][number];
type Entry = Parameters<typeof startModuleJobs>[1][number];

const deactivatedRowDb = {
  select: () => ({
    from: () => ({
      where: () => ({ limit: async () => [{ deactivatedAt: new Date(), missingAt: null }] }),
    }),
  }),
} as unknown as Database;

const activeRowDb = {
  select: () => ({
    from: () => ({ where: () => ({ limit: async () => [{ deactivatedAt: null }] }) }),
  }),
} as unknown as Database;

const untouchedDb = {
  select: () => {
    throw new Error('the database was read');
  },
} as unknown as Database;

// Not yet exported by the unchanged code: calling the namespace member fails by assertion, not by TypeError.
const waitMessage = async (db: Database, stepId: string): Promise<string | null> => {
  const fn = (
    activation as { moduleSchemaWaitMessage?: (d: Database, s: string) => Promise<string | null> }
  ).moduleSchemaWaitMessage;
  if (typeof fn !== 'function') return 'moduleSchemaWaitMessage is not exported';
  return fn(db, stepId);
};

const touched = new Set<string>();
const unready = (id: string) => {
  touched.add(id);
  markModuleSchemaUnready(id);
};

afterEach(() => {
  for (const id of touched) markModuleSchemaReady(id);
  touched.clear();
  vi.restoreAllMocks();
});

describe('moduleSchemaWaitMessage', () => {
  it('says the schema is being set up, naming the step and where to rerun it', async () => {
    unready('alpha-wait');
    const message = await waitMessage(activeRowDb, 'module.alpha-wait.x');
    expect(message).toContain("Module alpha-wait's schema is being set up");
    expect(message).toContain('module.alpha-wait.x');
    expect(message).toContain('Admin > Modules');
  });

  it('says the teardown hook is running while one runs, and the setup words after it ends', async () => {
    unready('beta-wait');
    const release = beginModuleTeardown('beta-wait');
    const during = await waitMessage(activeRowDb, 'module.beta-wait.x');
    expect(during).toContain('teardown hook is still running');
    expect(during).not.toContain('worker log');
    release();
    expect(await waitMessage(activeRowDb, 'module.beta-wait.x')).toContain(
      "Module beta-wait's schema is being set up",
    );
  });

  it('says the setup is no longer retried after three failed attempts, and nothing once an ensure succeeds', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const ensure = vi.fn(async () => {
      throw new Error('ddl refused');
    });
    const loaded = { manifest: { id: 'gamma-wait' } } as unknown as Loaded;
    const entry = { ensureSchema: ensure } as unknown as Entry;
    const { reconcile, stopAll } = await startModuleJobs(
      [loaded],
      [entry],
      new Set(['gamma-wait']),
    );
    unready('gamma-wait');
    for (let pass = 0; pass < 4; pass++) await reconcile(new Set());
    expect(ensure).toHaveBeenCalledTimes(3);
    expect(await waitMessage(activeRowDb, 'module.gamma-wait.x')).toContain(
      'no longer being retried',
    );

    ensure.mockResolvedValue(undefined as never);
    await reconcile(new Set(['gamma-wait']));
    await reconcile(new Set());
    expect(ensure).toHaveBeenCalledTimes(4);
    expect(await waitMessage(activeRowDb, 'module.gamma-wait.x')).toBeNull();
    await stopAll();
  });

  it('reads nothing and answers null when the flag is clear or the step is not a module step', async () => {
    expect(await waitMessage(untouchedDb, 'module.delta-wait.x')).toBeNull();
    unready('delta-wait');
    for (const stepId of ['01-core-step', 'custom.t.some-step', 'not a step id']) {
      expect(await waitMessage(untouchedDb, stepId)).toBeNull();
    }
  });

  it('answers null for a deactivated module, whose row fails with the deactivation words', async () => {
    unready('eps-wait');
    expect(await waitMessage(deactivatedRowDb, 'module.eps-wait.x')).toBeNull();
    expect(await moduleDeactivationMessage(deactivatedRowDb, 'module.eps-wait.x')).toContain(
      'is deactivated',
    );
  });
});

describe('moduleDeactivationMessage', () => {
  it('no longer answers for a module whose schema is not ready', async () => {
    unready('zeta-wait');
    expect(await moduleDeactivationMessage(activeRowDb, 'module.zeta-wait.x')).toBeNull();
  });
});
