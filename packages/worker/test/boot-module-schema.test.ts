import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';

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
const { startModuleJobs } = await import('../src/modules/loader.js');

const db = {} as Database;

const reportedSchemas = (): Record<string, string> =>
  Object.fromEntries(
    (
      JSON.parse(h.reports.at(-1)!) as { modules: { id: string; ensureSchema: string }[] }
    ).modules.map((m) => [m.id, m.ensureSchema]),
  );

describe('the module schemas at worker boot', () => {
  beforeEach(() => {
    h.reports.length = 0;
    h.deactivated.mockReset();
    for (const m of [h.alpha, h.beta]) {
      m.ensure.mockClear();
      m.jobs.mockClear();
      m.stop.mockClear();
    }
  });

  it('ensures the schema of an active module and leaves a deactivated one alone, reporting each so', async () => {
    h.deactivated.mockResolvedValue(new Set(['alpha']));

    await bootStepEngine(db);

    expect(h.alpha.ensure).not.toHaveBeenCalled();
    expect(h.beta.ensure).toHaveBeenCalledOnce();
    expect(reportedSchemas()).toEqual({ alpha: 'deactivated', beta: 'ok' });
  });

  it('reads the deactivated set once, so a module reactivated after that read is ensured and then started by the first pass', async () => {
    h.deactivated.mockResolvedValueOnce(new Set(['alpha'])).mockResolvedValue(new Set());

    const boot = await bootStepEngine(db);
    const { reconcile, stopAll } = await startModuleJobs(
      boot.loaded,
      boot.entries,
      boot.deactivated,
    );
    expect(h.alpha.ensure).not.toHaveBeenCalled();
    expect(h.alpha.jobs).not.toHaveBeenCalled();
    expect(h.beta.jobs).toHaveBeenCalledOnce();

    await reconcile(await h.deactivated(db));
    expect(h.alpha.ensure).toHaveBeenCalledOnce();
    expect(h.alpha.jobs).toHaveBeenCalledOnce();
    expect(h.alpha.ensure.mock.invocationCallOrder[0]).toBeLessThan(
      h.alpha.jobs.mock.invocationCallOrder[0]!,
    );
    expect(h.beta.ensure).toHaveBeenCalledOnce();
    expect(h.beta.jobs).toHaveBeenCalledOnce();

    await stopAll();
  });

  it('asks for the deactivated set once at boot: only the reconcile pass of index.ts reads it again', () => {
    const boot = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

    expect(boot.match(/deactivatedModuleIds\(/g)).toHaveLength(1);
  });
});
