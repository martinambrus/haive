import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { moduleDatabaseName } from '@haive/shared/module-db';
import {
  MODULE_JOBS_RECONCILE_MS,
  moduleTeardownRunning,
  startModuleJobs,
  type LoadedWorkerModule,
  type WorkerModuleEntry,
} from '../src/modules/loader.js';
import {
  ModuleTeardownRefusedError,
  processModuleControlJob,
  runModuleTeardown,
} from '../src/queues/module-control-queue.js';

vi.mock('../src/redis.js', () => ({ getBullRedis: () => ({}) }));

const url = process.env.MODULE_TEARDOWN_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/module_teardown_test'))
  throw new Error('Use a dedicated module_teardown_test database for module teardown tests');

const OFF = new Date('2026-10-14T08:00:00.000Z');
const GONE = new Date('2026-10-14T07:00:00.000Z');
const DB_MODULE = 'teardown-test-db';

type Hook = NonNullable<WorkerModuleEntry['teardown']>;

const loadedOf = (id: string) =>
  ({
    packageName: `@haive/module-${id}`,
    manifest: { id, name: `Module ${id}`, version: '1.0.0', schemaVersion: 1 },
    stepIds: [],
    composable: [],
  }) as unknown as LoadedWorkerModule;

const entryOf = (id: string, teardown?: Hook): WorkerModuleEntry => ({
  packageName: `@haive/module-${id}`,
  manifest: {},
  ...(teardown ? { teardown } : {}),
});

describe.skipIf(!url)('module teardown on Postgres', () => {
  let db: Database;
  const previousUrl = process.env.DATABASE_URL;

  const deps = (ids: string[], hooks: Record<string, Hook> = {}, jobsRunning: string[] = []) => ({
    db,
    loaded: ids.map(loadedOf),
    entries: ids.map((id) => entryOf(id, hooks[id])),
    jobsStarted: (id: string) => jobsRunning.includes(id),
    teardownRunning: moduleTeardownRunning,
  });
  const setModule = (moduleId: string, over: Partial<typeof schema.modules.$inferInsert> = {}) =>
    db.insert(schema.modules).values({
      moduleId,
      packageName: `@haive/module-${moduleId}`,
      name: moduleId,
      installedVersion: '1.0.0',
      ...over,
    });
  const row = async (id: string) => {
    const [r] = await db.select().from(schema.modules).where(eq(schema.modules.moduleId, id));
    return r;
  };
  const dropModuleDatabase = () =>
    db.execute(sql.raw(`DROP DATABASE IF EXISTS "${moduleDatabaseName(DB_MODULE)}" WITH (FORCE)`));

  beforeAll(() => {
    db = createDatabase(url as string);
    process.env.DATABASE_URL = url;
  });

  beforeEach(async () => {
    await db.delete(schema.modules);
    await dropModuleDatabase();
  });

  afterAll(async () => {
    await db.delete(schema.modules);
    await dropModuleDatabase();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    await db.$client.end({ timeout: 5 });
  });

  it('runs the hook, then stamps the module and answers with the stamp', async () => {
    await setModule('alpha', { deactivatedAt: OFF });
    const seen: (Date | null | undefined)[] = [];
    const hook = vi.fn<Hook>(async () => {
      seen.push((await row('alpha'))?.tornDownAt);
    });

    const result = await runModuleTeardown(deps(['alpha'], { alpha: hook }), 'alpha');

    expect(hook).toHaveBeenCalledOnce();
    expect(seen).toEqual([null]);
    const stored = await row('alpha');
    expect(stored?.tornDownAt).toBeInstanceOf(Date);
    expect(Math.abs(Date.now() - stored!.tornDownAt!.getTime())).toBeLessThan(60_000);
    expect(result).toEqual({ moduleId: 'alpha', tornDownAt: stored!.tornDownAt!.toISOString() });
    expect(stored).toMatchObject({
      deactivatedAt: OFF,
      missingAt: null,
      installedVersion: '1.0.0',
    });
  });

  it('hands the hook the module id, a logger and a way to open the module database', async () => {
    await setModule('alpha', { deactivatedAt: OFF });
    const hook = vi.fn<Hook>(async () => {});
    await runModuleTeardown(deps(['alpha'], { alpha: hook }), 'alpha');
    const ctx = hook.mock.calls[0]![0];
    expect(ctx.moduleId).toBe('alpha');
    expect(typeof ctx.logger.info).toBe('function');
    expect(typeof ctx.openDatabase).toBe('function');
  });

  it('stamps a module that declares no hook', async () => {
    await setModule('alpha', { deactivatedAt: OFF });
    const result = await runModuleTeardown(deps(['alpha']), 'alpha');
    expect(result.tornDownAt).toEqual(expect.any(String));
    expect((await row('alpha'))?.tornDownAt?.toISOString()).toBe(result.tornDownAt);
  });

  it('stamps only the module it was asked for', async () => {
    await setModule('alpha', { deactivatedAt: OFF });
    await setModule('beta', { deactivatedAt: OFF });
    const beta = await row('beta');
    await runModuleTeardown(deps(['alpha', 'beta']), 'alpha');
    expect((await row('alpha'))?.tornDownAt).toBeInstanceOf(Date);
    expect(await row('beta')).toEqual(beta);
  });

  it('runs the hook again, and moves the stamp, when asked a second time', async () => {
    await setModule('alpha', { deactivatedAt: OFF });
    const hook = vi.fn<Hook>(async () => {});
    const d = deps(['alpha'], { alpha: hook });
    const first = await runModuleTeardown(d, 'alpha');
    await new Promise((r) => setTimeout(r, 15));
    const second = await runModuleTeardown(d, 'alpha');
    expect(hook).toHaveBeenCalledTimes(2);
    expect(Date.parse(second.tornDownAt!)).toBeGreaterThan(Date.parse(first.tornDownAt!));
  });

  it("fails with the hook's own message and records nothing when the hook throws", async () => {
    await setModule('alpha', { deactivatedAt: OFF });
    const hook: Hook = async () => {
      throw new Error('drop failed: boom');
    };
    const failure = await runModuleTeardown(deps(['alpha'], { alpha: hook }), 'alpha').catch(
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('drop failed: boom');
    expect((await row('alpha'))?.tornDownAt).toBeNull();
  });

  it('fails a hook that does not finish in time and records nothing', async () => {
    await setModule('alpha', { deactivatedAt: OFF });
    let endHook!: () => void;
    const hook: Hook = () => new Promise<void>((resolve) => (endHook = resolve));
    const failure = await runModuleTeardown(
      { ...deps(['alpha'], { alpha: hook }), hookTimeoutMs: 50 },
      'alpha',
    ).catch((err: unknown) => err);
    expect((failure as Error).message).toBe("Module alpha's teardown did not finish within 0 s");
    expect((await row('alpha'))?.tornDownAt).toBeNull();
    endHook();
  });

  it('turns a hook that throws a bare value into an error carrying that value', async () => {
    await setModule('alpha', { deactivatedAt: OFF });
    const hook: Hook = async () => {
      throw 'plain text failure';
    };
    const failure = await runModuleTeardown(deps(['alpha'], { alpha: hook }), 'alpha').catch(
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('plain text failure');
    expect((await row('alpha'))?.tornDownAt).toBeNull();
  });

  it('records nothing, and says so, when the module is activated again while the hook runs', async () => {
    await setModule('alpha', { deactivatedAt: OFF });
    const hook: Hook = async () => {
      await db
        .update(schema.modules)
        .set({ deactivatedAt: null })
        .where(eq(schema.modules.moduleId, 'alpha'));
    };
    const result = await runModuleTeardown(deps(['alpha'], { alpha: hook }), 'alpha');
    expect(result).toEqual({ moduleId: 'alpha', tornDownAt: null });
    expect(await row('alpha')).toMatchObject({ deactivatedAt: null, tornDownAt: null });
  });

  it('records nothing when the module is marked missing while the hook runs', async () => {
    await setModule('alpha', { deactivatedAt: OFF });
    const hook: Hook = async () => {
      await db
        .update(schema.modules)
        .set({ missingAt: GONE })
        .where(eq(schema.modules.moduleId, 'alpha'));
    };
    const result = await runModuleTeardown(deps(['alpha'], { alpha: hook }), 'alpha');
    expect(result).toEqual({ moduleId: 'alpha', tornDownAt: null });
    expect((await row('alpha'))?.tornDownAt).toBeNull();
  });

  it.each<[string, () => Promise<void>]>([
    ['finishes', async () => {}],
    [
      'fails',
      async () => {
        throw new Error('drop failed');
      },
    ],
  ])(
    'keeps the jobs of a module activated again while its hook runs from starting until the hook %s',
    async (_how, finish) => {
      await setModule('alpha', { deactivatedAt: OFF });
      const jobs = vi.fn(async () => async () => {});
      const { reconcile, stopAll } = await startModuleJobs(
        [loadedOf('alpha')],
        [{ ...entryOf('alpha'), jobs }],
        new Set(['alpha']),
      );
      let startedDuringHook = -1;
      const hook: Hook = async () => {
        await db
          .update(schema.modules)
          .set({ deactivatedAt: null })
          .where(eq(schema.modules.moduleId, 'alpha'));
        await reconcile(new Set());
        startedDuringHook = jobs.mock.calls.length;
        await finish();
      };

      await runModuleTeardown(deps(['alpha'], { alpha: hook }), 'alpha').catch(() => undefined);
      expect(startedDuringHook).toBe(0);

      await reconcile(new Set());
      expect(jobs).toHaveBeenCalledOnce();
      await stopAll();
    },
  );

  it.each<[string, () => Promise<unknown>, string[], string[], RegExp]>([
    [
      'is not in this worker registry',
      () => setModule('alpha', { deactivatedAt: OFF }),
      [],
      [],
      /alpha.*not loaded by this worker/,
    ],
    ['has no recorded row', async () => {}, ['alpha'], [], /alpha.*no recorded row/],
    ['is active', () => setModule('alpha'), ['alpha'], [], /alpha.*active/],
    [
      'is missing',
      () => setModule('alpha', { deactivatedAt: OFF, missingAt: GONE }),
      ['alpha'],
      [],
      /alpha.*missing/,
    ],
    [
      'had its jobs started by this worker',
      () => setModule('alpha', { deactivatedAt: OFF }),
      ['alpha'],
      ['alpha'],
      new RegExp(
        `alpha.*jobs.*still running on this worker.*about ${MODULE_JOBS_RECONCILE_MS / 1000} seconds.*try again shortly`,
      ),
    ],
  ])(
    'refuses, by name, a module that %s, and never calls the hook',
    async (_label, seed, ids, running, message) => {
      await seed();
      const hook = vi.fn<Hook>(async () => {});
      const before = await row('alpha');
      const failure = await runModuleTeardown(deps(ids, { alpha: hook }, running), 'alpha').catch(
        (err: unknown) => err,
      );
      expect(failure).toBeInstanceOf(ModuleTeardownRefusedError);
      expect((failure as Error).message).toMatch(message);
      expect(hook).not.toHaveBeenCalled();
      expect(await row('alpha')).toEqual(before);
    },
  );

  it('closes every database the hook opened, whether or not the hook closes it', async () => {
    await setModule(DB_MODULE, { deactivatedAt: OFF });
    const hook: Hook = async (ctx) => {
      const first = await ctx.openDatabase();
      await first.sql`select 1`;
      const second = await ctx.openDatabase();
      await second.sql`select 1`;
      await second.close();
    };
    await runModuleTeardown(deps([DB_MODULE], { [DB_MODULE]: hook }), DB_MODULE);
    await expect(
      db.execute(sql.raw(`DROP DATABASE "${moduleDatabaseName(DB_MODULE)}"`)),
    ).resolves.toBeDefined();
  });

  it('closes the databases a failing hook opened', async () => {
    await setModule(DB_MODULE, { deactivatedAt: OFF });
    const hook: Hook = async (ctx) => {
      const opened = await ctx.openDatabase();
      await opened.sql`select 1`;
      throw new Error('after opening');
    };
    await expect(
      runModuleTeardown(deps([DB_MODULE], { [DB_MODULE]: hook }), DB_MODULE),
    ).rejects.toThrow('after opening');
    await expect(
      db.execute(sql.raw(`DROP DATABASE "${moduleDatabaseName(DB_MODULE)}"`)),
    ).resolves.toBeDefined();
  });

  describe('processModuleControlJob', () => {
    it('runs a teardown job and returns its result', async () => {
      await setModule('alpha', { deactivatedAt: OFF });
      const result = await processModuleControlJob(deps(['alpha']), {
        name: 'teardown',
        data: { moduleId: 'alpha' },
      });
      expect(result).toEqual({
        moduleId: 'alpha',
        tornDownAt: (await row('alpha'))!.tornDownAt!.toISOString(),
      });
    });

    it('rejects a job it does not know and touches nothing', async () => {
      await setModule('alpha', { deactivatedAt: OFF });
      await expect(
        processModuleControlJob(deps(['alpha']), { name: 'purge', data: { moduleId: 'alpha' } }),
      ).rejects.toThrow('Unknown module-control job: purge');
      expect((await row('alpha'))?.tornDownAt).toBeNull();
    });
  });
});
