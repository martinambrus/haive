import { eq } from 'drizzle-orm';
import { createServer, type Server } from 'node:http';
import net, { type AddressInfo, type Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { logger, secretsService } from '@haive/shared';
import type { EditorGrant } from '../src/lib/editor-grants.js';
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
  upstreamHeaders: vi.fn(),
  store: new Map<string, { value: string; expires: number }>(),
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({
  getIdeEnsureQueue: () => ({ add: h.ensure }),
  getIdeEnsureQueueEvents: () => ({}),
}));
vi.mock('../src/redis.js', () => ({
  getRedis: () => ({ set: h.set, getdel: h.getdel }),
  getPatientRedis: () => ({
    scan: async () => ['0', []],
    hset: async () => 1,
    hincrby: async () => 1,
  }),
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
import {
  ideRoutes,
  taskIdeAccessRoutes,
  repoIdeAccessRoutes,
  installIdeWebSocket,
} from '../src/routes/ide.js';

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
  h.upstreamHeaders.mockReset();
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
      const { url } = (await res.json()) as { url: string };
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
    expect((await grant(kind)).status).toBe(503);
    expect(h.set).not.toHaveBeenCalled();
  });
  it('answers 503 when the ensure queue add never returns', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      h.ensure.mockReturnValue(new Promise(() => {}));
      const pending = grant();
      await vi.advanceTimersByTimeAsync(2_000);
      expect((await pending).status).toBe(503);
      expect(h.set).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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
  return new URL(((await res.json()) as { url: string }).url).hash.slice(1);
}
function redeem(secret: string, origin = 'https://ide.example.com') {
  return app.request('/ide/_handshake', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, host: 'api:3001' },
    body: JSON.stringify({ secret }),
  });
}
function rewriteGrant(change: (g: EditorGrant) => void) {
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

function editorRequest(sessionCookie: string, kind = 'tasks', id = ID) {
  const prefix = kind === 'repos' ? `/ide/repos/${id}/` : `/ide/${id}/`;
  return app.request(prefix, { headers: { cookie: sessionCookie, host: 'rewritten-api:3001' } });
}
describe('editor HTTP sessions', () => {
  it.each(['tasks', 'repos'])(
    'accepts only the owned scope and tolerates a rewritten Host (%s)',
    async (kind) => {
      const { cookie } = await issued(kind);
      const upstream = vi.fn().mockResolvedValue(new Response('editor'));
      vi.stubGlobal('fetch', upstream);
      try {
        expect((await editorRequest(cookie, kind)).status).toBe(200);
        expect(upstream).toHaveBeenCalledOnce();
        expect(new Headers(upstream.mock.calls[0]![1].headers).get('cookie')).toBeNull();
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
  it.each(['version', 'deactivated', 'flagged', 'missing-user', 'ownership'])(
    'refuses HTTP after %s changes',
    async (change) => {
      const { cookie } = await issued();
      if (change === 'version') fake.patch(schema.users, USER, { tokenVersion: 1 });
      if (change === 'deactivated') fake.patch(schema.users, USER, { status: 'deactivated' });
      if (change === 'flagged') fake.patch(schema.users, USER, { mustChangePassword: true });
      if (change === 'missing-user')
        await fake.db.delete(schema.users).where(eq(schema.users.id, USER));
      if (change === 'ownership') fake.patch(schema.tasks, ID, { userId: OTHER });
      expect([403, 404]).toContain((await editorRequest(cookie)).status);
    },
  );
  it.each(['target-id', 'target-kind', 'runtime', 'origin', 'user', 'access-jwt', 'expired'])(
    'refuses an editor cookie with wrong %s',
    async (change) => {
      const { cookie: issuedCookie } = await issued();
      const goodToken = issuedCookie.slice(issuedCookie.indexOf('=') + 1);
      const p = await verifyEditorSession(goodToken);
      const payload: EditorSessionPayload = {
        sub: p.sub,
        tv: p.tv,
        target: { ...p.target },
        runtimeSessionId: p.runtimeSessionId,
        editorOrigin: p.editorOrigin,
      };
      if (change === 'target-id') payload.target.id = MISSING;
      if (change === 'target-kind') payload.target.kind = 'repo';
      if (change === 'runtime') payload.runtimeSessionId = MISSING;
      if (change === 'origin') payload.editorOrigin = 'https://other.example.com';
      if (change === 'user') payload.sub = OTHER;
      let token =
        change === 'access-jwt'
          ? cookie.slice('haive_access='.length)
          : await signEditorSession(payload);
      if (change === 'expired') {
        token = goodToken;
        vi.useFakeTimers();
        vi.advanceTimersByTime(8 * 3600 * 1000);
      }
      expect(
        (await editorRequest(`${editorCookieName({ kind: 'task', id: ID })}=${token}`)).status,
      ).toBe(change === 'user' ? 404 : 403);
    },
  );
});

const realConnect = net.connect.bind(net);
const wsServers: Server[] = [];
const wsPeers = new Set<Socket>();
const wsClients = new Set<WebSocket>();
afterEach(async () => {
  for (const client of wsClients) client.terminate();
  wsClients.clear();
  for (const peer of wsPeers) peer.destroy();
  wsPeers.clear();
  await Promise.all(wsServers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});
async function listenWs(s: Server): Promise<number> {
  wsServers.push(s);
  s.on('connection', (peer) => {
    wsPeers.add(peer);
    peer.on('close', () => wsPeers.delete(peer));
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return (s.address() as AddressInfo).port;
}
async function editorWsRig() {
  const upstream = createServer();
  new WebSocketServer({ server: upstream });
  upstream.on('upgrade', (req) => h.upstreamHeaders(req.headers));
  const upstreamPort = await listenWs(upstream);
  vi.spyOn(net, 'connect').mockImplementation(((opts: net.TcpNetConnectOpts) => {
    if (opts.host?.startsWith('haive-ide-'))
      return realConnect({ host: '127.0.0.1', port: upstreamPort });
    return realConnect(opts);
  }) as typeof net.connect);
  const proxy = createServer();
  installIdeWebSocket(proxy);
  return listenWs(proxy);
}
function wsHandshake(port: number, cookie: string, path = `/ide/${ID}/`) {
  const client = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
    headers: { cookie, origin: 'https://ide.example.com', host: 'rewritten-api:3001' },
  });
  wsClients.add(client);
  const result = new Promise<number>((resolve, reject) => {
    client.on('open', () => resolve(101));
    client.on('unexpected-response', (_req, res) => {
      res.resume();
      client.terminate();
      resolve(res.statusCode!);
    });
    client.on('error', () => {});
    client.on('close', (code) => {
      if (code !== 1006) return;
    });
    setTimeout(() => reject(new Error('editor upgrade timeout')), 3000).unref();
  });
  return { client, result };
}
describe('editor WebSocket sessions', () => {
  it.each(['tasks', 'repos'])(
    'accepts scoped editor credentials with a rewritten Host (%s)',
    async (kind) => {
      const { cookie } = await issued(kind);
      const port = await editorWsRig();
      const path = kind === 'repos' ? `/ide/repos/${ID}/` : `/ide/${ID}/`;
      expect(
        await wsHandshake(port, `${cookie}; haive_access=app; haive_refresh=refresh`, path).result,
      ).toBe(101);
      expect(h.upstreamHeaders.mock.calls[0]![0].cookie).toBeUndefined();
    },
  );
  it.each([
    'access-jwt',
    'runtime',
    'target',
    'origin',
    'version',
    'deactivated',
    'flagged',
    'ownership',
  ])('refuses editor WS for wrong %s', async (change) => {
    const { cookie: c } = await issued();
    const p = await verifyEditorSession(c.slice(c.indexOf('=') + 1));
    const payload: EditorSessionPayload = {
      sub: p.sub,
      tv: p.tv,
      target: { ...p.target },
      runtimeSessionId: p.runtimeSessionId,
      editorOrigin: p.editorOrigin,
    };
    if (change === 'runtime') payload.runtimeSessionId = MISSING;
    if (change === 'target') payload.target.kind = 'repo';
    if (change === 'origin') payload.editorOrigin = 'https://other.example.com';
    if (change === 'version') fake.patch(schema.users, USER, { tokenVersion: 1 });
    if (change === 'deactivated') fake.patch(schema.users, USER, { status: 'deactivated' });
    if (change === 'flagged') fake.patch(schema.users, USER, { mustChangePassword: true });
    if (change === 'ownership') fake.patch(schema.tasks, ID, { userId: OTHER });
    const token =
      change === 'access-jwt'
        ? cookie.slice('haive_access='.length)
        : await signEditorSession(payload);
    const port = await editorWsRig();
    expect(
      await wsHandshake(port, `${editorCookieName({ kind: 'task', id: ID })}=${token}`).result,
    ).toBe(change === 'ownership' ? 404 : 403);
  });
});

it.each(['authentication', 'ownership'])(
  'fences an editor upgrade suspended during %s',
  async (stage) => {
    const { cookie } = await issued();
    const port = await editorWsRig();
    let arrived!: () => void;
    const captured = new Promise<void>((r) => {
      arrived = r;
    });
    let resume!: () => void;
    const pendingRead = new Promise<void>((r) => {
      resume = r;
    });
    const table = stage === 'authentication' ? fake.db.query.users : fake.db.query.tasks;
    const original = table.findFirst.bind(table);
    vi.spyOn(table, 'findFirst').mockImplementationOnce(async (opts) => {
      const row = await original(opts);
      arrived();
      await pendingRead;
      return row;
    });
    const pending = wsHandshake(port, cookie);
    await captured;
    const { closeUserSockets } = await import('../src/lib/user-sockets.js');
    fake.patch(schema.users, USER, { tokenVersion: 1 });
    expect(closeUserSockets(USER)).toBe(1);
    // The existing fence ends a pending raw handshake with 401; no editor is accepted.
    expect(await pending.result).toBe(401);
    resume();
    await new Promise<void>((r) => setImmediate(r));
  },
);

it('fails closed when bounded grant storage is unavailable', async () => {
  const { RedisUnavailableError } = await import('../src/lib/redis-unavailable.js');
  h.set.mockRejectedValue(new RedisUnavailableError(new Error('synthetic outage')));
  expect((await grant()).status).toBe(503);
  h.set.mockImplementation(async (key: string, value: string) => {
    h.store.set(key, { value, expires: Date.now() + 60000 });
    return 'OK';
  });
  const secret = await mint();
  h.getdel.mockRejectedValue(new RedisUnavailableError(new Error('synthetic outage')));
  const res = await redeem(secret);
  expect(res.status).toBe(503);
  expect(res.headers.getSetCookie()).toEqual([]);
});

it('logs only the IDE pathname when an upgrade fails', async () => {
  const { cookie } = await issued();
  const port = await editorWsRig();
  const error = vi.spyOn(logger, 'error');
  vi.spyOn(fake.db.query.tasks, 'findFirst').mockRejectedValueOnce(new Error('synthetic failure'));
  expect(
    await wsHandshake(port, cookie, `/ide/${ID}/socket?secret=must-not-be-logged`).result,
  ).toBe(500);
  expect(error).toHaveBeenCalledWith(
    expect.objectContaining({ path: `/ide/${ID}/socket` }),
    'ide upgrade handler failed',
  );
  expect(JSON.stringify(error.mock.calls)).not.toContain('must-not-be-logged');
});

it.each(['HTTP', 'WS'])(
  'refuses an app session beside a stale editor cookie on %s',
  async (transport) => {
    const stale = `${editorCookieName({ kind: 'task', id: ID })}=expired`;
    if (transport === 'HTTP') {
      expect((await editorRequest(`${stale}; ${cookie}`)).status).toBe(403);
    } else {
      const port = await editorWsRig();
      expect(await wsHandshake(port, `${stale}; ${cookie}`).result).toBe(403);
    }
  },
);

it('refuses a grant without an editor origin before waking the runtime', async () => {
  vi.stubEnv('HAIVE_EDITOR_ORIGIN', '');
  vi.stubEnv('HAIVE_PUBLIC_API_URL', '');
  vi.stubEnv('HAIVE_API_PORT', '');
  expect((await grant()).status).toBe(503);
  expect(h.ensure).not.toHaveBeenCalled();
});

it.each([
  ['tasks', 'HTTP'],
  ['repos', 'HTTP'],
  ['tasks', 'WS'],
  ['repos', 'WS'],
])('refuses an app session alone (%s, %s)', async (kind, transport) => {
  if (transport === 'HTTP') {
    expect((await editorRequest(cookie, kind)).status).toBe(401);
  } else {
    const port = await editorWsRig();
    const path = kind === 'repos' ? `/ide/repos/${ID}/` : `/ide/${ID}/`;
    expect(await wsHandshake(port, cookie, path).result).toBe(401);
  }
  expect(h.ensure).not.toHaveBeenCalled();
  expect(h.upstreamHeaders).not.toHaveBeenCalled();
});

it.each(['tasks', 'repos'])(
  'refuses target A credentials on target B on HTTP and WS (%s)',
  async (kind) => {
    const { cookie: editor } = await issued(kind);
    const target = { kind: kind === 'repos' ? ('repo' as const) : ('task' as const), id: MISSING };
    const renamed = `${editorCookieName(target)}=${editor.slice(editor.indexOf('=') + 1)}`;
    expect((await editorRequest(renamed, kind, MISSING)).status).toBe(403);
    const port = await editorWsRig();
    const path = kind === 'repos' ? `/ide/repos/${MISSING}/` : `/ide/${MISSING}/`;
    expect(await wsHandshake(port, renamed, path).result).toBe(403);
  },
);

it.each([
  '//evil.test',
  '/%2F%2Fevil.test',
  '/\\evil.test',
  `/${ID.toUpperCase()}`,
  `/repos/${ID.toUpperCase()}`,
  `/${ID}%2F`,
])('never redirects a hostile bare form off the editor path (%s)', async (suffix) => {
  const res = await app.request(`/ide${suffix}`);
  if (res.status === 308) expect(res.headers.get('location')).toMatch(/^\/ide\/[^/\\]/);
  else expect(res.headers.get('location')).toBeNull();
});

it.each(['tasks', 'repos'])(
  'redirects the bare target before reading authentication (%s)',
  async (kind) => {
    const prefix = kind === 'repos' ? `/ide/repos/${ID}` : `/ide/${ID}`;
    const read = vi.spyOn(fake.db.query.users, 'findFirst');
    const query = '?folder=%2Fworkspace&value=a%2Bb&value=two';
    for (const method of ['GET', 'POST']) {
      const responses = await Promise.all(
        [
          '',
          cookie,
          `${editorCookieName({ kind: kind === 'repos' ? 'repo' : 'task', id: ID })}=stale`,
        ].map((auth) => app.request(prefix + query, { method, headers: { cookie: auth } })),
      );
      const bodies = [];
      for (const res of responses) {
        expect(res.status).toBe(308);
        expect(res.headers.get('location')).toBe(prefix + '/' + query);
        expect(res.headers.getSetCookie()).toEqual([]);
        bodies.push(await res.text());
      }
      expect(new Set(bodies).size).toBe(1);
    }
    expect(read).not.toHaveBeenCalled();
    expect(h.ensure).not.toHaveBeenCalled();
  },
);
