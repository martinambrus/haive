import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { secretsService } from '@haive/shared';
import { requireAuth } from '../src/middleware/auth.js';
import { verifyAccessToken, signAccessToken } from '../src/auth/jwt.js';
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
import {
  editorCookieName,
  verifyEditorSession,
  signEditorSession,
  type EditorSessionPayload,
} from '../src/auth/editor-session.js';
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
app.get('/app', requireAuth, (c) => c.text('app'));

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
      await fake.db.update(schema.users).set({ tokenVersion: 1 }).where(eq(schema.users.id, USER));
      return { ok: true };
    },
  });
  expect((await grant()).status).toBe(403);
  expect(h.set).not.toHaveBeenCalled();
});

describe('editor bootstrap', () => {
  it('is public, static, non-cacheable, and hashes exactly its script', async () => {
    const res = await app.request('/ide/_handshake');
    expect(res.status).toBe(200);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    const script = html.split('<script>')[1]!.split('</script>')[0]!;
    const hash = createHash('sha256').update(script).digest('base64');
    expect(res.headers.get('content-security-policy')).toBe(
      `default-src 'none'; script-src 'sha256-${hash}'; connect-src 'self'; frame-ancestors https://app.example.com`,
    );
    expect(script.indexOf('history.replaceState')).toBeLessThan(script.indexOf('await fetch'));
    expect(h.ensure).not.toHaveBeenCalled();
    expect(h.set).not.toHaveBeenCalled();
  });
});

async function mint(kind = 'tasks'): Promise<string> {
  const res = await grant(kind);
  expect(res.status).toBe(200);
  return new URL((await res.json()).url).hash.slice(1);
}
function redeem(secret: string, origin = 'https://ide.example.com') {
  return app.request('/ide/_handshake', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, host: 'api:3001' },
    body: JSON.stringify({ secret }),
  });
}
function rewriteGrant(change: (g: Record<string, any>) => void) {
  const row = [...h.store.values()][0]!;
  const g = JSON.parse(row.value);
  change(g);
  row.value = JSON.stringify(g);
}
async function issued(kind = 'tasks') {
  const res = await redeem(await mint(kind));
  expect(res.status).toBe(200);
  return { res, cookie: res.headers.getSetCookie()[0]!.split(';')[0]! };
}

describe('editor grant redemption', () => {
  it('takes a grant exactly once under concurrent redemption', async () => {
    const secret = await mint();
    const responses = await Promise.all([redeem(secret), redeem(secret)]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 403]);
    expect(responses.flatMap((r) => r.headers.getSetCookie())).toHaveLength(1);
    for (const res of responses) expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await redeem(secret)).status).toBe(403);
  });
  it('refuses missing, unknown and expired grants without a 401 or cookie', async () => {
    for (const body of [{}, { secret: 'A'.repeat(43) }]) {
      const res = await app.request('/ide/_handshake', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(403);
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    vi.useFakeTimers();
    const secret = await mint();
    vi.advanceTimersByTime(60000);
    expect((await redeem(secret)).status).toBe(403);
  });
  it.each([
    'version',
    'deactivated',
    'flagged',
    'missing-user',
    'ownership',
    'runtime',
    'target',
    'origin',
    'user',
    'request-origin',
  ])('refuses a changed %s', async (change) => {
    const secret = await mint();
    if (change === 'version') fake.patch(schema.users, USER, { tokenVersion: 1 });
    if (change === 'deactivated') fake.patch(schema.users, USER, { status: 'deactivated' });
    if (change === 'flagged') fake.patch(schema.users, USER, { mustChangePassword: true });
    if (change === 'missing-user')
      await fake.db.delete(schema.users).where(eq(schema.users.id, USER));
    if (change === 'ownership') fake.patch(schema.tasks, ID, { userId: OTHER });
    if (change === 'runtime')
      rewriteGrant((g) => {
        g.runtimeSessionId = MISSING;
      });
    if (change === 'target')
      rewriteGrant((g) => {
        g.target.kind = 'repo';
      });
    if (change === 'origin')
      rewriteGrant((g) => {
        g.editorOrigin = 'https://other.example.com';
      });
    if (change === 'user')
      rewriteGrant((g) => {
        g.userId = OTHER;
      });
    const res = await redeem(
      secret,
      change === 'request-origin' ? 'https://evil.example.com' : undefined,
    );
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toEqual([]);
  });
  it.each(['tasks', 'repos'])(
    'issues the exact scoped HTTPS cookie and next path (%s)',
    async (kind) => {
      const { res, cookie } = await issued(kind);
      const path = kind === 'repos' ? `/ide/repos/${ID}/` : `/ide/${ID}/`;
      expect(await res.json()).toEqual({ next: path });
      const header = res.headers.getSetCookie()[0]!;
      for (const attr of [
        `Path=${path}`,
        'HttpOnly',
        'Secure',
        'SameSite=None',
        'Partitioned',
        'Max-Age=28800',
      ])
        expect(header).toContain(attr);
      expect(header).not.toContain('Domain=');
      const payload = await verifyEditorSession(cookie.slice(cookie.indexOf('=') + 1));
      expect(payload).toMatchObject({
        sub: USER,
        tv: 0,
        target: { kind: kind === 'repos' ? 'repo' : 'task', id: ID },
      });
    },
  );
  it('uses a host-only Lax cookie on HTTP', async () => {
    vi.stubEnv('HAIVE_EDITOR_ORIGIN', 'http://localhost:3001');
    const res = await redeem(await mint(), 'http://localhost:3001');
    expect(res.status).toBe(200);
    const header = res.headers.getSetCookie()[0]!;
    expect(header).toContain('SameSite=Lax');
    for (const attr of ['Secure', 'Partitioned', 'Domain=']) expect(header).not.toContain(attr);
  });
  it('cryptographically separates editor tokens from app access tokens in both directions', async () => {
    const { cookie: editor } = await issued();
    const editorToken = editor.slice(editor.indexOf('=') + 1);
    await expect(verifyAccessToken(editorToken)).rejects.toThrow();
    await expect(verifyEditorSession(cookie.slice('haive_access='.length))).rejects.toThrow();
    expect(
      (await app.request('/app', { headers: { cookie: `haive_access=${editorToken}` } })).status,
    ).toBe(401);
  });
});
