import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { secretsService } from '@haive/shared';
import { signAccessToken } from '../src/auth/jwt.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  enabled: true,
  ensure: vi.fn(),
  set: vi.fn(),
  getdel: vi.fn(),
  store: new Map<string, { value: string; expires: number }>(),
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({
  getIdeEnsureQueue: () => ({ add: h.ensure }),
  getIdeEnsureQueueEvents: () => ({}),
}));
vi.mock('../src/redis.js', () => ({
  getRedis: () => ({ set: h.set, getdel: h.getdel }),
}));
vi.mock('@haive/shared', async (original) => ({
  ...(await original<typeof import('@haive/shared')>()),
  configService: { getBoolean: async () => h.enabled },
}));
import { ideRoutes, taskIdeAccessRoutes, repoIdeAccessRoutes } from '../src/routes/ide.js';

const USER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const ID = '00000000-0000-4000-8000-000000000003';
const MISSING = '00000000-0000-4000-8000-000000000004';
const tables = { users: schema.users, tasks: schema.tasks, repositories: schema.repositories };
let fake: ReturnType<typeof createFakeDb<typeof tables>>;
let cookie: string;
const app = new Hono<AppEnv>();
app.onError(errorHandler);
app.route('/tasks', taskIdeAccessRoutes);
app.route('/repos', repoIdeAccessRoutes);
app.route('/ide', ideRoutes);

beforeEach(async () => {
  vi.stubEnv('HAIVE_EDITOR_ORIGIN', 'https://ide.example.com');
  vi.stubEnv('WEB_ORIGIN', 'https://app.example.com');
  vi.spyOn(secretsService, 'getJwtSecret').mockResolvedValue('synthetic-editor-test-key');
  fake = createFakeDb(tables);
  h.db = fake.db;
  fake.insert(schema.users, {
    id: USER,
    role: 'user',
    status: 'active',
    tokenVersion: 0,
    mustChangePassword: false,
  });
  fake.insert(schema.users, { id: OTHER, role: 'user', status: 'active', tokenVersion: 0 });
  fake.insert(schema.tasks, { id: ID, userId: USER });
  fake.insert(schema.repositories, { id: ID, userId: USER, status: 'ready', writable: true });
  cookie = `haive_access=${await signAccessToken({ sub: USER, role: 'user', tv: 0 })}`;
  h.enabled = true;
  h.store.clear();
  h.ensure.mockReset().mockResolvedValue({ waitUntilFinished: async () => ({ ok: true }) });
  h.set
    .mockReset()
    .mockImplementation(async (key: string, value: string, _px: string, ttl: number) => {
      h.store.set(key, { value, expires: Date.now() + ttl });
      return 'OK';
    });
  // A synchronous map take models Redis GETDEL's single atomic operation.
  h.getdel.mockReset().mockImplementation(async (key: string) => {
    const row = h.store.get(key);
    h.store.delete(key);
    return row && row.expires > Date.now() ? row.value : null;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function grant(kind = 'tasks', id = ID, auth = cookie) {
  return app.request(`/${kind}/${id}/editor-handshake`, {
    method: 'POST',
    headers: { cookie: auth, host: 'attacker.example', 'x-forwarded-host': 'attacker.example' },
  });
}

describe('editor grants', () => {
  it.each(['tasks', 'repos'])('requires authentication and ownership (%s)', async (kind) => {
    expect((await grant(kind, ID, '')).status).toBe(401);
    const other = await signAccessToken({ sub: OTHER, role: 'user', tv: 0 });
    expect((await grant(kind, ID, `haive_access=${other}`)).status).toBe(404);
    expect((await grant(kind, MISSING)).status).toBe(404);
    expect(h.ensure).not.toHaveBeenCalled();
    expect(h.set).not.toHaveBeenCalled();
  });
  it.each(['tasks', 'repos'])(
    'mints a hashed 60-second grant after worker readiness (%s)',
    async (kind) => {
      const res = await grant(kind);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const { url } = await res.json();
      const secret = new URL(url).hash.slice(1);
      expect(Buffer.from(secret, 'base64url')).toHaveLength(32);
      expect(url).toBe(`https://ide.example.com/ide/_handshake#${secret}`);
      const key = `editor-grant:${createHash('sha256').update(secret).digest('hex')}`;
      expect(h.set).toHaveBeenCalledWith(key, expect.any(String), 'PX', 60000);
      expect(JSON.parse(h.store.get(key)!.value)).toEqual({
        userId: USER,
        tokenVersion: 0,
        target: { kind: kind === 'repos' ? 'repo' : 'task', id: ID },
        runtimeSessionId: kind === 'repos' ? `repo-${ID}` : ID,
        editorOrigin: 'https://ide.example.com',
      });
      expect(h.ensure.mock.calls[0]![1]).toEqual(
        kind === 'repos' ? { repositoryId: ID, userId: USER } : { taskId: ID, userId: USER },
      );
    },
  );
  it.each(['tasks', 'repos'])('refuses before the runtime is ready (%s)', async (kind) => {
    h.ensure.mockResolvedValue({ waitUntilFinished: async () => ({ ok: false }) });
    expect((await grant(kind)).status).toBe(409);
    h.ensure.mockRejectedValue(new Error('not ready'));
    expect((await grant(kind)).status).toBe(409);
    expect(h.set).not.toHaveBeenCalled();
  });
  it('refuses disabled editors', async () => {
    h.enabled = false;
    expect((await grant()).status).toBe(403);
    expect(h.ensure).not.toHaveBeenCalled();
  });
});

it('refuses a grant when the app session is revoked during runtime resolution', async () => {
  h.ensure.mockResolvedValue({
    waitUntilFinished: async () => {
      fake.rows(schema.users).find((u) => u.id === USER)!.tokenVersion = 1;
      return { ok: true };
    },
  });
  expect((await grant()).status).toBe(403);
  expect(h.set).not.toHaveBeenCalled();
});
