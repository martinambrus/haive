import { eq, inArray, like, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { createRedisConnection } from '@haive/shared';
import { MODULES_LOADED_WORKER_KEY } from '@haive/shared/modularity';
import {
  moduleDatabaseName,
  openModuleDatabase,
  type ModuleDatabase,
} from '@haive/shared/module-db';

const url = process.env.MODULE_PURGE_API_TEST_URL;
const redisUrl = process.env.MODULE_PURGE_API_TEST_REDIS_URL;
if (url && !new URL(url).pathname.startsWith('/module_purge_api_test'))
  throw new Error('Use a dedicated module_purge_api_test database for the module purge tests');
if (redisUrl && !/^\/([1-9]|1[0-5])$/.test(new URL(redisUrl).pathname))
  throw new Error(
    'Use Redis database 1 to 15 for the module purge tests, never the app database 0',
  );

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  redis: undefined as unknown,
  role: 'admin',
  drops: 0,
  beforeTransaction: undefined as (() => Promise<void>) | undefined,
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/redis.js', () => ({ getRedis: () => h.redis }));
vi.mock('../src/queues.js', () => ({
  getModuleControlQueue: () => ({ add: async () => undefined }),
  getModuleControlQueueEvents: () => undefined,
}));
vi.mock('../src/middleware/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/middleware/auth.js')>();
  return {
    ...original,
    requireAuth: async (
      c: { set: (key: string, value: string) => void },
      next: () => Promise<void>,
    ) => {
      c.set('userId', ACTOR);
      c.set('userRole', h.role);
      await next();
    },
  };
});

import { Hono } from 'hono';
import { moduleRoutes, type LoadedApiModule } from '../src/modules/loader.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const ACTOR = '00000000-0000-4000-8000-0000000000a1';
const USER_EMAIL_INDEX = 'module-purge-api-test-user';
const ID = 'fixture';
const OTHER = 'fixture-two';
const GONE = new Date('2026-10-14T08:00:00.000Z');
const KEYS = {
  global: `config:module:${ID}:global:a`,
  admin: `config:module:${ID}:admin:b`,
  other: `config:module:${OTHER}:global:a`,
};
const FREE = `${ID}__free`;
const USED = `${ID}__used`;
const OTHER_TYPE = `${OTHER}__free`;

const apiModule = (id: string): LoadedApiModule => ({
  packageName: `@haive/module-${id}`,
  manifest: { id, name: id, version: '1.0.0', schemaVersion: 1 } as LoadedApiModule['manifest'],
  hasRoutes: false,
});
const report = (...ids: string[]) =>
  JSON.stringify({
    at: '2026-10-14T08:30:00.000Z',
    modules: ids.map((id) => ({ id, version: '1.0.0' })),
  });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isDrop = (query: unknown) =>
  new PgDialect().sqlToQuery(query as Parameters<PgDialect['sqlToQuery']>[0]).sql.includes('DROP');

describe.skipIf(!url || !redisUrl)('POST /modules/:id/purge on Postgres and Redis', () => {
  let db: Database;
  let redis: Redis;
  let before: Awaited<ReturnType<typeof snapshot>>;
  let held: ModuleDatabase | undefined;

  const send = (id: string, body?: unknown, loaded: string[] = [OTHER]) => {
    const app = new Hono<AppEnv>();
    app.route('/modules', moduleRoutes(loaded.map(apiModule)));
    app.onError(errorHandler);
    return app.request(`/modules/${id}/purge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };
  const purge = (loaded?: string[]) => send(ID, { confirm: ID }, loaded);
  const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

  const sessionsOn = async (name: string) =>
    (
      (await db.execute(
        sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = ${name}`,
      )) as unknown as { n: number }[]
    )[0]!.n;
  const idle = async (name: string) => {
    for (let i = 0; i < 100 && (await sessionsOn(name)) > 0; i += 1) await sleep(50);
  };
  const dropDatabase = async (name: string) => {
    await db.execute(sql.raw(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
  };
  const provisionDatabase = async (moduleId: string) => {
    const module = await openModuleDatabase(db, moduleId);
    await module.sql`CREATE TABLE IF NOT EXISTS fixture_things (id int)`;
    await module.sql`INSERT INTO fixture_things VALUES (1)`;
    await module.close();
    await idle(moduleDatabaseName(moduleId));
  };

  async function snapshot() {
    const names = [moduleDatabaseName(ID), moduleDatabaseName(OTHER)];
    const databases = (await db.execute(
      sql`SELECT datname FROM pg_database WHERE datname IN (${sql.join(
        names.map((n) => sql`${n}`),
        sql`, `,
      )}) ORDER BY datname`,
    )) as unknown as { datname: string }[];
    return {
      databases: databases.map((d) => d.datname),
      keys: (await redis.keys('config:module:fixture*')).sort(),
      modules: (await db.select({ id: schema.modules.moduleId }).from(schema.modules))
        .map((r) => r.id)
        .sort(),
      types: (
        await db
          .select({ slug: schema.taskTypeDefinitions.slug })
          .from(schema.taskTypeDefinitions)
          .where(like(schema.taskTypeDefinitions.source, 'module:%'))
      )
        .map((r) => r.slug)
        .sort(),
      tasks: (await db.select({ id: schema.tasks.id }).from(schema.tasks)).length,
      purges: await purgeAudits(),
    };
  }
  const purgeAudits = () =>
    db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'module.purge'));

  const task = async (over: Partial<typeof schema.tasks.$inferInsert> = {}) => {
    const [row] = await db
      .insert(schema.tasks)
      .values({ userId: ACTOR, type: USED, title: 'Task', status: 'completed', ...over })
      .returning();
    return row!;
  };
  const typeRow = (slug: string, source: string) => ({
    slug,
    displayName: slug,
    runListStrategy: 'static' as const,
    stepIds: ['01-worktree-setup'],
    source,
    requiresRepository: false,
  });
  const moduleRow = (moduleId: string, missingAt: Date | null) => ({
    moduleId,
    packageName: `@haive/module-${moduleId}`,
    name: moduleId,
    installedVersion: '1.0.0',
    missingAt,
  });

  const refused = async (res: Response, status: number, code: string | null) => {
    expect([res.status, (await json(res)).code ?? null]).toEqual([status, code]);
    expect(await snapshot()).toEqual(before);
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    db = createDatabase(url as string);
    redis = createRedisConnection(redisUrl as string);
    h.redis = redis;
    h.db = new Proxy(db, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof value !== 'function') return value;
        if (prop === 'execute') {
          return (query: unknown) => {
            if (isDrop(query)) h.drops += 1;
            return (value as (q: unknown) => unknown).call(target, query);
          };
        }
        if (prop === 'transaction') {
          return async (...args: unknown[]) => {
            await h.beforeTransaction?.();
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return value.bind(target);
      },
    });
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, USER_EMAIL_INDEX));
    await db.insert(schema.users).values({
      id: ACTOR,
      emailEncrypted: 'module-purge-api-test@test.local',
      emailBlindIndex: USER_EMAIL_INDEX,
      passwordHash: 'not-real',
      role: 'admin',
      status: 'active',
      tokenVersion: 0,
    });
  });

  const clean = async () => {
    await held?.close();
    held = undefined;
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, ACTOR));
    await db.delete(schema.modules);
    await db
      .delete(schema.taskTypeDefinitions)
      .where(inArray(schema.taskTypeDefinitions.source, [`module:${ID}`, `module:${OTHER}`]));
    await db.delete(schema.auditEvents).where(eq(schema.auditEvents.targetType, 'module'));
    const stale = await redis.keys('config:module:fixture*');
    if (stale.length > 0) await redis.del(...stale);
    await redis.del(MODULES_LOADED_WORKER_KEY);
    await dropDatabase(moduleDatabaseName(ID));
  };

  beforeEach(async () => {
    h.role = 'admin';
    h.drops = 0;
    h.beforeTransaction = undefined;
    await clean();
    await provisionDatabase(ID);
    await provisionDatabase(OTHER);
    await redis.mset(KEYS.global, '"1"', KEYS.admin, '"2"', KEYS.other, '"3"');
    await redis.set(MODULES_LOADED_WORKER_KEY, report(OTHER));
    await db.insert(schema.modules).values([moduleRow(ID, GONE), moduleRow(OTHER, null)]);
    await db
      .insert(schema.taskTypeDefinitions)
      .values([
        typeRow(FREE, `module:${ID}`),
        typeRow(USED, `module:${ID}`),
        typeRow(OTHER_TYPE, `module:${OTHER}`),
      ]);
    await task();
    before = await snapshot();
  }, 30_000);

  afterAll(async () => {
    await clean();
    await dropDatabase(moduleDatabaseName(OTHER));
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, USER_EMAIL_INDEX));
    await db.$client.end({ timeout: 5 });
    await redis.quit();
  });

  describe('a missing module', () => {
    it('loses its database, its settings and the task types no task uses, and its neighbour loses nothing', async () => {
      const res = await purge();
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({
        moduleId: ID,
        database: moduleDatabaseName(ID),
        configKeysDeleted: 2,
        taskTypesDeleted: [FREE],
        taskTypesKept: [USED],
      });

      const after = await snapshot();
      expect(after.databases).toEqual([moduleDatabaseName(OTHER)]);
      expect(after.keys).toEqual([KEYS.other]);
      expect(after.modules).toEqual([OTHER]);
      expect(after.types).toEqual([OTHER_TYPE, USED].sort());
      expect(after.tasks).toBe(before.tasks);
    });

    it('records one module.purge audit event naming what it took and what it kept', async () => {
      await purge();
      const [event, ...rest] = await purgeAudits();
      expect(rest).toEqual([]);
      expect(event).toMatchObject({
        actorUserId: ACTOR,
        action: 'module.purge',
        targetType: 'module',
        metadata: {
          moduleId: ID,
          database: moduleDatabaseName(ID),
          configKeysDeleted: 2,
          taskTypesDeleted: [FREE],
          taskTypesKept: [USED],
        },
      });
    });

    it('purges a module that has no database, no settings and no task types', async () => {
      await dropDatabase(moduleDatabaseName(ID));
      await redis.del(KEYS.global, KEYS.admin);
      await db.delete(schema.tasks).where(eq(schema.tasks.type, USED));
      await db
        .delete(schema.taskTypeDefinitions)
        .where(eq(schema.taskTypeDefinitions.source, `module:${ID}`));
      const res = await purge();
      expect(res.status).toBe(200);
      expect(await json(res)).toMatchObject({
        configKeysDeleted: 0,
        taskTypesDeleted: [],
        taskTypesKept: [],
      });
      expect((await snapshot()).modules).toEqual([OTHER]);
    });

    it('finishes a purge that stopped after the database went', async () => {
      await dropDatabase(moduleDatabaseName(ID));
      expect((await snapshot()).databases).toEqual([moduleDatabaseName(OTHER)]);
      const res = await purge();
      expect(res.status).toBe(200);
      const after = await snapshot();
      expect(after.keys).toEqual([KEYS.other]);
      expect(after.modules).toEqual([OTHER]);
      expect(after.types).toEqual([OTHER_TYPE, USED].sort());
    });

    it('finishes a purge that stopped after the settings went too', async () => {
      await dropDatabase(moduleDatabaseName(ID));
      await redis.del(KEYS.global, KEYS.admin);
      const res = await purge();
      expect(res.status).toBe(200);
      expect((await json(res)).configKeysDeleted).toBe(0);
      expect((await snapshot()).modules).toEqual([OTHER]);
    });

    it('answers 404 to a second purge and takes nothing more', async () => {
      expect((await purge()).status).toBe(200);
      const once = await snapshot();
      expect((await purge()).status).toBe(404);
      expect(await snapshot()).toEqual(once);
    });

    it('is not held up by a task of its types that has ended', async () => {
      await task({ status: 'failed' });
      await task({ status: 'cancelled', type: FREE });
      const res = await purge();
      expect(res.status).toBe(200);
      expect((await json(res)).taskTypesKept).toEqual([FREE, USED]);
    });
  });

  describe('a task create in flight', () => {
    it('makes the purge wait for the type row it holds, and then the type stays', async () => {
      let pending = Promise.resolve<Response | undefined>(undefined);
      let raced = '';
      await db.transaction(async (tx) => {
        await tx
          .select()
          .from(schema.taskTypeDefinitions)
          .where(eq(schema.taskTypeDefinitions.slug, FREE))
          .for('share');
        const started = Promise.resolve(purge());
        pending = started;
        raced = await Promise.race([started.then(() => 'done'), sleep(600).then(() => 'waiting')]);
        await tx
          .insert(schema.tasks)
          .values({ userId: ACTOR, type: FREE, title: 'Created meanwhile', status: 'created' });
      });
      expect(raced).toBe('waiting');
      const res = (await pending)!;
      expect(res.status).toBe(200);
      expect(await json(res)).toMatchObject({ taskTypesDeleted: [], taskTypesKept: [FREE, USED] });
    });
  });

  describe('refuses, and leaves the database, the settings and the rows as they were', () => {
    it('a user', async () => {
      h.role = 'user';
      await refused(await purge(), 403, null);
    });

    it.each<[string, unknown]>([
      ['no body', undefined],
      ['an empty body', {}],
      ['a confirmation that is not a string', { confirm: 7 }],
      ['the wrong id', { confirm: OTHER }],
      ['the id in another case', { confirm: 'Fixture' }],
      ['the id with a space', { confirm: 'fixture ' }],
      ['an empty confirmation', { confirm: '' }],
    ])('%s: 400', async (_label, body) => {
      await refused(await send(ID, body), 400, 'confirm_mismatch');
    });

    it('a module with no recorded row: 404', async () => {
      await refused(await send('ghost', { confirm: 'ghost' }), 404, null);
    });

    it('a module whose missing_at is not set: 409', async () => {
      await db
        .update(schema.modules)
        .set({ missingAt: null })
        .where(eq(schema.modules.moduleId, ID));
      before = await snapshot();
      await refused(await purge(), 409, 'module_not_missing');
    });

    it('a module the api still loads: 409', async () => {
      await refused(await purge([OTHER, ID]), 409, 'module_loaded');
    });

    it('a module the worker report still lists: 409', async () => {
      await redis.set(MODULES_LOADED_WORKER_KEY, report(OTHER, ID));
      await refused(await purge(), 409, 'module_loaded');
    });

    it('a worker that has not reported: 409', async () => {
      await redis.del(MODULES_LOADED_WORKER_KEY);
      await refused(await purge(), 409, 'worker_unreported');
    });

    it('a worker report it cannot read: 409', async () => {
      await redis.set(MODULES_LOADED_WORKER_KEY, 'not json');
      await refused(await purge(), 409, 'worker_unreported');
    });

    it('a live task of a type the module seeded, listing it: 409', async () => {
      const live = await task({ status: 'running', title: 'Still going' });
      before = await snapshot();
      const res = await purge();
      const body = await json(res);
      expect([res.status, body.code]).toEqual([409, 'module_tasks_open']);
      expect((body.tasks as { id: string }[]).map((t) => t.id)).toEqual([live.id]);
      expect(await snapshot()).toEqual(before);
    });

    it('a live task that runs one of its steps: 409', async () => {
      await task({
        status: 'waiting_user',
        type: 'workflow',
        runListSnapshot: ['01-worktree-setup', `module.${ID}.x`],
      });
      before = await snapshot();
      await refused(await purge(), 409, 'module_tasks_open');
    });

    it('a dead task that is still in a live state, which a deactivation lets through: 409', async () => {
      await task({ status: 'running', deadAt: new Date(), deadReason: 'gone' });
      before = await snapshot();
      await refused(await purge(), 409, 'module_tasks_open');
    });

    // Postgres waits about five seconds for the other backends before it refuses a drop, and this drops twice.
    it('a module database a session still holds, after one retry, and then purges once it lets go', async () => {
      held = await openModuleDatabase(db, ID);
      await held.sql`SELECT 1`;
      const res = await purge();
      expect([res.status, (await json(res)).code]).toEqual([409, 'module_database_in_use']);
      expect(h.drops).toBe(2);
      expect(await snapshot()).toEqual(before);

      await held.close();
      held = undefined;
      await idle(moduleDatabaseName(ID));
      h.drops = 0;
      expect((await purge()).status).toBe(200);
      expect(h.drops).toBe(1);
      expect((await snapshot()).databases).toEqual([moduleDatabaseName(OTHER)]);
    }, 30_000);
  });

  describe('when a step after the drop fails', () => {
    it('answers 502 module_purge_incomplete, and running the purge again finishes it', async () => {
      h.beforeTransaction = async () => {
        throw new Error('connection lost');
      };
      const res = await purge();
      expect([res.status, (await json(res)).code]).toEqual([502, 'module_purge_incomplete']);
      const mid = await snapshot();
      expect(mid.databases).toEqual([moduleDatabaseName(OTHER)]);
      expect(mid.modules).toEqual(before.modules);
      expect(mid.types).toEqual(before.types);

      h.beforeTransaction = undefined;
      const again = await purge();
      expect(again.status).toBe(200);
      const after = await snapshot();
      expect(after.modules).toEqual([OTHER]);
      expect(after.types).toEqual([OTHER_TYPE, USED].sort());
    });
  });

  describe('when the module loads again between the checks and the delete', () => {
    it('answers 409 and keeps the row and every task type, though the database and settings are gone', async () => {
      h.beforeTransaction = async () => {
        await db
          .update(schema.modules)
          .set({ missingAt: null })
          .where(eq(schema.modules.moduleId, ID));
      };
      const res = await purge();
      expect([res.status, (await json(res)).code]).toEqual([409, 'module_came_back']);

      const after = await snapshot();
      expect(after.modules).toEqual(before.modules);
      expect(after.types).toEqual(before.types);
      expect(after.databases).toEqual([moduleDatabaseName(OTHER)]);
      expect(after.keys).toEqual([KEYS.other]);
      expect(after.purges).toHaveLength(1);
      expect(after.purges[0]!.metadata).toMatchObject({
        moduleId: ID,
        database: moduleDatabaseName(ID),
        configKeysDeleted: 2,
        taskTypesDeleted: [],
        taskTypesKept: [],
      });
    });
  });
});
