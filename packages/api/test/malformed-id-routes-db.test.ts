import { randomBytes, randomUUID } from 'node:crypto';
import { inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';

const url = process.env.MALFORMED_ID_ROUTES_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/malformed_id_routes_test'))
  throw new Error('Use a dedicated malformed_id_routes_test database for the malformed id tests');

const h = vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'error';
  return { db: undefined as unknown };
});

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: {
    get: async () => null,
    getBoolean: async (_key: string, fallback: boolean) => fallback,
  },
}));

import { logger, secretsService } from '@haive/shared';
import { ACCESS_COOKIE } from '../src/auth/cookies.js';
import { signAccessToken } from '../src/auth/jwt.js';
import type { AppEnv } from '../src/context.js';
import { createApiApp } from '../src/index.js';
import { errorHandler } from '../src/middleware/error-handler.js';

const WEB_ORIGIN = 'http://localhost:3000';
const NOT_FOUND = { error: 'Not found', code: null };

describe.skipIf(!url)('a request whose path id is not a uuid, on Postgres', () => {
  const app = createApiApp(WEB_ORIGIN);
  const userIds: string[] = [];
  let db: Database;
  let cookie: string;
  let repositoryId: string;
  let logged: ReturnType<typeof vi.spyOn>;

  const get = (path: string) => app.request(path, { headers: { host: 'localhost:3001', cookie } });

  beforeAll(async () => {
    db = createDatabase(url as string);
    h.db = db;
    vi.spyOn(secretsService, 'getJwtSecret').mockResolvedValue('ef'.repeat(32));
    logged = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'malformed-id-routes-test@test.local',
        emailBlindIndex: randomBytes(16).toString('hex'),
        passwordHash: 'not-a-real-hash',
        role: 'user',
      })
      .returning({ id: schema.users.id });
    userIds.push(user!.id);
    cookie = `${ACCESS_COOKIE}=${await signAccessToken({ sub: user!.id, role: 'user', tv: 0 })}`;
    const [repository] = await db
      .insert(schema.repositories)
      .values({
        userId: user!.id,
        name: 'malformed id routes',
        source: 'git_https',
        remoteUrl: 'https://github.com/acme/widgets.git',
      })
      .returning({ id: schema.repositories.id });
    repositoryId = repository!.id;
  });

  beforeEach(() => {
    logged.mockClear();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await db.delete(schema.users).where(inArray(schema.users.id, userIds));
    await db.$client.end({ timeout: 5 });
  });

  it.each([
    '/tasks/abc',
    '/tasks/abc/steps',
    '/tasks/abc/integrations',
    '/repositories/abc/integrations',
    '/repos/abc',
    '/repositories/abc/plan',
  ])('answers GET %s with 404 and does not log an unhandled error', async (path) => {
    const res = await get(path);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
    expect(logged).not.toHaveBeenCalled();
  });

  it('answers a malformed second id under an owned repository with 404', async () => {
    const res = await get(`/repositories/${repositoryId}/plan/nodes/abc`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
    expect(logged).not.toHaveBeenCalled();
  });

  it('keeps the answer for a well-formed id nobody holds (passes before and after)', async () => {
    const task = await get(`/tasks/${randomUUID()}`);
    const repo = await get(`/repos/${randomUUID()}`);

    expect(task.status).toBe(404);
    expect(await task.json()).toEqual({ error: 'Task not found', code: null });
    expect(repo.status).toBe(404);
    expect(await repo.json()).toEqual({ error: 'Repository not found', code: null });
  });

  describe('the real errors Postgres raises, through the real handler', () => {
    const probe = new Hono<AppEnv>();
    probe.get('/drizzle/:id', async (c) =>
      c.json(await (h.db as Database).execute(sql`select ${c.req.param('id')}::uuid`)),
    );
    probe.get('/driver/:id', async (c) =>
      c.json(await (h.db as Database).$client`select ${c.req.param('id')}::uuid`),
    );
    probe.get('/value/:id', async (c) =>
      c.json(await (h.db as Database).execute(sql`select ${c.req.query('v')}::uuid`)),
    );
    probe.get('/other/:id', async (c) =>
      c.json(await (h.db as Database).execute(sql`select 1 / ${Number(c.req.query('d'))}`)),
    );
    probe.onError(errorHandler);

    it.each(['/drizzle/abc', '/driver/abc'])(
      'answers %s, a drizzle-wrapped or a bare driver error, with 404',
      async (path) => {
        const res = await probe.request(path);

        expect(res.status).toBe(404);
        expect(await res.json()).toEqual(NOT_FOUND);
        expect(logged).not.toHaveBeenCalled();
      },
    );

    it('keeps a malformed query value a 500 when the path id is a uuid (passes before and after)', async () => {
      const res = await probe.request(`/value/${randomUUID()}?v=abc`);

      expect(res.status).toBe(500);
      expect(logged).toHaveBeenCalledTimes(1);
    });

    it('keeps another SQLSTATE a 500 under a malformed path id (passes before and after)', async () => {
      const res = await probe.request('/other/abc?d=0');

      expect(res.status).toBe(500);
      expect(logged).toHaveBeenCalledTimes(1);
    });
  });
});
