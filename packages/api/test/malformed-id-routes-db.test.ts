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
    getEncryptionKey: async () => Buffer.alloc(32),
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

  describe('a repositoryId query that is not a uuid', () => {
    const ROUTES = [
      '/tasks?',
      '/tasks/feature-suggestions?q=ab&',
      '/tasks/last-cli?',
      '/tasks/estimation-accuracy?',
    ];

    it.each(ROUTES)('answers GET %srepositoryId=abc with 400 and does not log', async (route) => {
      const res = await get(`${route}repositoryId=abc`);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'repositoryId must be a UUID', code: null });
      expect(logged).not.toHaveBeenCalled();
    });

    it.each(ROUTES)(
      'keeps answering GET %srepositoryId=<uuid> with 200, held or not (passes before and after)',
      async (route) => {
        for (const id of [repositoryId, repositoryId.toUpperCase(), randomUUID()]) {
          expect((await get(`${route}repositoryId=${id}`)).status).toBe(200);
        }
      },
    );

    it.each(['', '%20'])(
      'keeps reading GET /tasks?repositoryId=%s as no filter (passes before and after)',
      async (value) => {
        expect((await get(`/tasks?repositoryId=${value}`)).status).toBe(200);
      },
    );
  });

  describe('a bundle or credential query that is not a uuid', () => {
    it.each([
      ['/bundles?repositoryId=abc', 'repositoryId must be a UUID'],
      ['/github-oauth/repos?credentialId=abc', 'credentialId must be a UUID'],
    ])('answers GET %s with 400 and does not log', async (path, error) => {
      const res = await get(path);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error, code: null });
      expect(logged).not.toHaveBeenCalled();
    });

    it('keeps answering GET /bundles?repositoryId=<uuid> with 200, held or not (passes before and after)', async () => {
      for (const id of [repositoryId, repositoryId.toUpperCase(), randomUUID()]) {
        const res = await get(`/bundles?repositoryId=${id}`);

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ bundles: [] });
      }
    });

    it('keeps reading GET /bundles?repositoryId= as no filter (passes before and after)', async () => {
      const res = await get('/bundles?repositoryId=');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ bundles: [] });
    });

    it('keeps answering a credentialId that is a uuid nobody holds with 404 (passes before and after)', async () => {
      for (const id of [randomUUID(), randomUUID().toUpperCase()]) {
        const res = await get(`/github-oauth/repos?credentialId=${id}`);

        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Credential not found', code: null });
      }
    });

    it('keeps asking for a credentialId that is missing or empty (passes before and after)', async () => {
      for (const query of ['', '?credentialId=']) {
        const res = await get(`/github-oauth/repos${query}`);

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'credentialId is required', code: null });
      }
    });
  });

  describe('an audit or price-history query value an administrator sends malformed', () => {
    let adminCookie: string;
    const asAdmin = (path: string) =>
      app.request(path, { headers: { host: 'localhost:3001', cookie: adminCookie } });

    beforeAll(async () => {
      const [admin] = await db
        .insert(schema.users)
        .values({
          emailEncrypted: 'malformed-id-routes-admin@test.local',
          emailBlindIndex: randomBytes(16).toString('hex'),
          passwordHash: 'not-a-real-hash',
          role: 'admin',
        })
        .returning({ id: schema.users.id });
      userIds.push(admin!.id);
      adminCookie = `${ACCESS_COOKIE}=${await signAccessToken({ sub: admin!.id, role: 'admin', tv: 0 })}`;
    });

    it.each([
      ['/admin/audit?actorUserId=abc', 'actorUserId must be a UUID'],
      [
        '/cli-pricing/history?modelKey=some-model&provider=nope',
        'provider must be a CLI provider name',
      ],
    ])('answers GET %s with 400 and does not log', async (path, error) => {
      const res = await asAdmin(path);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error, code: null });
      expect(logged).not.toHaveBeenCalled();
    });

    it.each([
      `/admin/audit?actorUserId=${randomUUID()}`,
      '/admin/audit?actorUserId=',
      '/cli-pricing/history?modelKey=some-model&provider=codex',
      '/cli-pricing/history?modelKey=some-model',
    ])('keeps answering GET %s with 200 (passes before and after)', async (path) => {
      const res = await asAdmin(path);

      expect(res.status).toBe(200);
      expect(logged).not.toHaveBeenCalled();
    });
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
