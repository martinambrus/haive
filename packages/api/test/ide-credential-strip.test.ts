import { createServer, type Server } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createAdaptorServer } from '@hono/node-server';
import { parse } from 'hono/utils/cookie';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { ideRunnerName } from '@haive/shared';
import type { AppEnv } from '../src/context.js';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const TASK = '00000000-0000-4000-8000-0000000000c1';
const h = vi.hoisted(() => ({ db: undefined as unknown, ensure: vi.fn(), enabled: true }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (
    c: { set: (key: string, value: string) => void },
    next: () => Promise<void>,
  ) => {
    c.set('userId', USER);
    await next();
  },
}));
vi.mock('../src/queues.js', () => ({
  getIdeEnsureQueue: () => ({
    add: h.ensure,
  }),
  getIdeEnsureQueueEvents: () => ({}),
}));
vi.mock('../src/redis.js', () => ({
  getRedis: () => ({
    hincrby: async () => 1,
    hset: async () => 1,
    scan: async () => ['0', []],
  }),
}));
vi.mock('../src/auth/jwt.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/auth/jwt.js')>()),
  verifyAccessToken: async () => ({ sub: USER, tv: 0 }),
}));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: { getBoolean: async () => h.enabled },
}));

import { ideRoutes, installIdeWebSocket } from '../src/routes/ide.js';
import { setAuthCookies } from '../src/auth/cookies.js';
import { errorHandler } from '../src/middleware/error-handler.js';

const app = new Hono<AppEnv>();
app.onError(errorHandler);
app.route('/ide', ideRoutes);

function seedDb(owned = true): void {
  const fake = createFakeDb({
    users: schema.users,
    tasks: schema.tasks,
    repositories: schema.repositories,
  });
  fake.insert(schema.users, { id: USER, status: 'active', tokenVersion: 0 });
  if (owned) {
    fake.insert(schema.tasks, { id: TASK, userId: USER });
    fake.insert(schema.repositories, { id: TASK, userId: USER });
  }
  h.db = fake.db;
}

const realConnect = net.connect.bind(net);
const realFetch = globalThis.fetch;
let fetchStub: ReturnType<typeof vi.fn>;
let servers: Array<{ close: (cb: () => void) => unknown }> = [];

beforeEach(() => {
  seedDb();
  h.enabled = true;
  h.ensure.mockReset().mockResolvedValue({ waitUntilFinished: async () => ({ ok: true }) });
  fetchStub = vi.fn().mockImplementation(async () => new Response('up'));
  vi.stubGlobal('fetch', fetchStub);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  servers = [];
});

type HeaderPairs = Array<[string, string]>;

async function httpForwarded(headers: HeaderPairs): Promise<Headers> {
  fetchStub.mockClear();
  const res = await app.request(`/ide/${TASK}/static/a.js`, { headers });
  expect(res.status).toBe(200);
  expect(fetchStub).toHaveBeenCalledTimes(1);
  return new Headers((fetchStub.mock.calls[0]![1] as RequestInit).headers);
}

async function httpCookie(cookie: string): Promise<string | null> {
  return (await httpForwarded([['cookie', cookie]])).get('cookie');
}

interface WsRig {
  port: number;
  upgrade: (lines: string[], path?: string) => Promise<{ head: string; reply: string }>;
}

async function wsRig(upstreamReply?: string): Promise<WsRig> {
  let captured: ((head: string) => void) | null = null;
  const fake = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (end >= 0 && captured) {
        const done = captured;
        captured = null;
        done(buf.slice(0, end));
        if (upstreamReply !== undefined) sock.write(upstreamReply);
        sock.end();
      }
    });
    sock.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  servers.push(fake);
  const fakePort = (fake.address() as AddressInfo).port;
  vi.spyOn(net, 'connect').mockImplementation(((opts: net.NetConnectOpts) => {
    const o = opts as net.TcpNetConnectOpts;
    if (o.host === ideRunnerName(TASK)) return realConnect({ host: '127.0.0.1', port: fakePort });
    return realConnect(opts as never);
  }) as typeof net.connect);

  const server: Server = createServer();
  installIdeWebSocket(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;

  const upgrade: WsRig['upgrade'] = (lines, path = `/ide/${TASK}/`) =>
    new Promise((resolve, reject) => {
      let reply = '';
      let head = '';
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        client.destroy();
        resolve({ head, reply });
      };
      const timer = setTimeout(() => reject(new Error('ws upgrade timed out')), 5000);
      captured = (value) => {
        head = value;
        if (upstreamReply !== undefined) return;
        clearTimeout(timer);
        finish();
      };
      const client = realConnect(port, '127.0.0.1', () => {
        client.write(
          [
            `GET ${path} HTTP/1.1`,
            `Host: 127.0.0.1:${port}`,
            `Origin: http://127.0.0.1:${port}`,
            'Connection: Upgrade',
            'Upgrade: websocket',
            'Sec-WebSocket-Version: 13',
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
            ...lines,
          ].join('\r\n') + '\r\n\r\n',
        );
      });
      client.on('data', (chunk) => (reply += chunk.toString()));
      client.on('close', () => {
        clearTimeout(timer);
        if (upstreamReply === undefined && !captured) return;
        captured = null;
        finish();
      });
      client.on('error', () => undefined);
    });
  return { port, upgrade };
}

const AUTH_PAIR = 'haive_access=session-token';
const AUTH_LINE = `Cookie: ${AUTH_PAIR}`;

function headLines(head: string): string[] {
  return head.split('\r\n').slice(1);
}

function headCookie(head: string): string | null {
  const cookies = headLines(head).filter((l) => l.toLowerCase().startsWith('cookie:'));
  expect(cookies.length).toBeLessThanOrEqual(1);
  if (cookies[0] === undefined) return null;
  const value = cookies[0].slice(cookies[0].indexOf(':') + 1).trim();
  const rest = value.startsWith(AUTH_PAIR)
    ? value.slice(AUTH_PAIR.length).replace(/^;\s*/, '')
    : value;
  return rest === '' ? null : rest;
}

async function wsCookie(rig: WsRig, cookieLines: string[]): Promise<string | null> {
  const { head } = await rig.upgrade([AUTH_LINE, ...cookieLines.map((l) => `Cookie: ${l}`)]);
  return headCookie(head);
}

const STRIPPED = ['haive_access', 'haive_refresh'];

describe('IDE-1 http proxy strips Haive credentials', () => {
  it('drops the session cookies and authorization headers, keeps the rest', async () => {
    const forwarded = await httpForwarded([
      ['cookie', 'haive_access=A; haive_refresh=R; other=1; theme=dark'],
      ['authorization', 'Bearer x'],
      ['proxy-authorization', 'Basic y'],
      ['x-forwarded-for', '1.2.3.4'],
      ['user-agent', 'ua'],
    ]);
    expect(forwarded.get('cookie')).toBe('other=1; theme=dark');
    expect(forwarded.has('authorization')).toBe(false);
    expect(forwarded.has('proxy-authorization')).toBe(false);
    expect(forwarded.has('x-forwarded-for')).toBe(false);
    expect(forwarded.get('user-agent')).toBe('ua');
    expect(forwarded.has('host')).toBe(false);
  });
});

describe('IDE-2 websocket proxy strips Haive credentials', () => {
  it('drops them from the replayed head and keeps the rewritten Host and Origin', async () => {
    const rig = await wsRig();
    const { head } = await rig.upgrade([
      AUTH_LINE,
      'Cookie: haive_access=A; haive_refresh=R; other=1; theme=dark',
      'Authorization: Bearer x',
      'Proxy-Authorization: Basic y',
      'X-Forwarded-For: 1.2.3.4',
    ]);
    const lower = head.toLowerCase();
    expect(lower).not.toContain('haive_');
    expect(lower).not.toContain('authorization:');
    expect(lower).not.toContain('proxy-authorization:');
    expect(lower).toContain('cookie: other=1; theme=dark');
    expect(head).toContain(`Host: ${ideRunnerName(TASK)}:8080`);
    expect(head).toContain(`origin: http://${ideRunnerName(TASK)}:8080`);
    expect(head).toContain('sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==');
    expect(head.toLowerCase()).not.toContain('x-forwarded-for:');
  });
});

interface Row {
  name: string;
  input: string;
  exact?: string | null;
  parsed?: Record<string, string>;
}

const NEAR = ['haive_access2', 'xhaive_access', 'Haive_Access', 'haive%5Faccess'];

const TABLE: Row[] = [
  { name: 'access only', input: 'haive_access=A', exact: null },
  { name: 'both haive cookies only', input: 'haive_access=A; haive_refresh=R', exact: null },
  { name: 'space after name', input: 'haive_access = X; other=1', exact: 'other=1' },
  { name: 'space before value', input: 'other=1; haive_access =X', exact: 'other=1' },
  {
    name: 'tab padded names',
    input: 'other=1;\thaive_refresh\t=R;\thaive_access\t=A',
    parsed: { other: '1' },
  },
  {
    name: 'space padded names and pairs',
    input: 'other=1;  haive_access  =A  ; k=v',
    parsed: { other: '1', k: 'v' },
  },
  { name: 'quoted value', input: 'haive_access="Q"; k=v', exact: 'k=v' },
  { name: 'equals inside a value', input: 'k=a=b; haive_access=A', exact: 'k=a=b' },
  {
    name: 'invalid first duplicate then valid',
    input: 'haive_access=a"b; x=1; haive_access=GOOD',
    exact: 'x=1',
  },
  { name: 'empty value', input: 'haive_refresh=; x=1', exact: 'x=1' },
  ...NEAR.map((n) => ({ name: `near miss ${n}`, input: `${n}=1`, exact: `${n}=1` })),
  {
    name: 'all near misses together',
    input: NEAR.map((n) => `${n}=1`).join('; '),
    exact: NEAR.map((n) => `${n}=1`).join('; '),
  },
  { name: 'bare name', input: 'flag; haive_refresh=R', exact: 'flag' },
  {
    name: 'JSON value',
    input: 'prefs={"theme":"dark"}; haive_access=A; a=1',
    exact: 'prefs={"theme":"dark"}; a=1',
  },
  { name: 'off-grammar pair', input: 'a b=1; p=a"b; haive_refresh=R', exact: 'a b=1; p=a"b' },
  { name: 'backslash value', input: 'p=a\\b; haive_access=A', exact: 'p=a\\b' },
  { name: 'empty pairs tolerated', input: 'a=1;;b=2;;', parsed: { a: '1', b: '2' } },
  { name: 'empty pairs around haive', input: ';;haive_access=A;;b=2', parsed: { b: '2' } },
  { name: 'haive first', input: 'haive_access=A; a=1; b=2', exact: 'a=1; b=2' },
  { name: 'haive middle', input: 'a=1; haive_refresh=R; b=2', exact: 'a=1; b=2' },
  { name: 'haive last', input: 'a=1; b=2; haive_access=A', exact: 'a=1; b=2' },
];

function check(row: Row, forwarded: string | null): void {
  if (row.exact !== undefined) {
    expect(forwarded).toBe(row.exact);
    return;
  }
  expect(forwarded).not.toBeNull();
  expect(parse(forwarded!)).toEqual(row.parsed);
  for (const n of STRIPPED) expect(forwarded).not.toContain(n);
}

describe('IDE-3 cookie table', () => {
  for (const row of TABLE) {
    it(`http: ${row.name}`, async () => {
      check(row, await httpCookie(row.input));
    });
  }

  for (const row of TABLE) {
    it(`ws: ${row.name}`, async () => {
      const rig = await wsRig();
      check(row, await wsCookie(rig, [row.input]));
    });
  }

  it('ws: a Cookie header sent as two lines is joined and stripped', async () => {
    const rig = await wsRig();
    expect(await wsCookie(rig, ['haive_access=A; a=1', 'haive_refresh=R; b=2'])).toBe('a=1; b=2');
  });

  it('ws: two lines holding only haive cookies leave no cookie header', async () => {
    const rig = await wsRig();
    expect(await wsCookie(rig, ['haive_access=A', 'haive_refresh=R'])).toBeNull();
  });
});

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = [
  'haive_access',
  'haive_refresh',
  'haive_access',
  'haive_refresh',
  ...NEAR,
  'sid',
  'theme',
  'a',
  'b',
];
const VALUES = ['v', '1', 'a=b', 'x y', '"q"', '', 'a"b', 'k=v=w'];
const SEPS = ['; ', ';', ' ; ', ';  ', ';\t'];
const PAD = ['', ' ', '\t'];

describe('IDE-4 property', () => {
  it('3000 random cookie headers lose only the Haive credentials', async () => {
    const seed = Number(process.env.IDE_STRIP_SEED ?? 20261023);
    const rnd = prng(seed);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    for (let i = 0; i < 3000; i++) {
      const pairs: string[] = [];
      const count = 1 + Math.floor(rnd() * 6);
      for (let j = 0; j < count; j++) {
        if (rnd() < 0.05) {
          pairs.push('');
          continue;
        }
        const name = pick(NAMES);
        pairs.push(
          rnd() < 0.1 ? name : `${pick(PAD)}${name}${pick(PAD)}=${pick(PAD)}${pick(VALUES)}`,
        );
      }
      let input = pairs[0]!;
      for (let j = 1; j < pairs.length; j++) input += pick(SEPS) + pairs[j];
      if (input.trim() === '') continue;
      try {
        const forwarded = await httpCookie(input);
        const before = parse(input);
        const after = forwarded === null ? {} : parse(forwarded);
        if (forwarded !== null) expect(forwarded.trim()).not.toBe('');
        for (const n of STRIPPED) expect(after).not.toHaveProperty(n);
        const expected = { ...before };
        for (const n of STRIPPED) delete expected[n];
        expect(after).toEqual(expected);
      } catch (err) {
        throw new Error(
          `property failed: seed=${seed} iteration=${i} input=${JSON.stringify(input)}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }, 120_000);
});

describe('IDE-5 cookie names come from setAuthCookies', () => {
  it('strips every cookie name the api sets at login', async () => {
    const login = new Hono();
    login.get('/', (c) => {
      setAuthCookies(c, 'access-token', 'refresh-token');
      return c.text('ok');
    });
    const res = await login.request('/');
    const names = res.headers.getSetCookie().map((line) => line.split('=')[0]!.trim());
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(await httpCookie(`${name}=tok; other=1`)).toBe('other=1');
    }
  });
});

describe('IDE-6 no regression', () => {
  it('a request with no cookie or authorization reaches fetch once, method intact', async () => {
    const forwarded = await httpForwarded([['user-agent', 'ua']]);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect((fetchStub.mock.calls[0]![1] as RequestInit).method).toBe('GET');
    expect(forwarded.has('cookie')).toBe(false);
    expect(forwarded.has('authorization')).toBe(false);
    expect(forwarded.get('user-agent')).toBe('ua');
  });

  it('forwards a POST body and passes the upstream response through', async () => {
    fetchStub.mockImplementation(
      async () =>
        new Response('created', { status: 201, headers: { 'x-upstream': 'yes', 'x-other': '2' } }),
    );
    const res = await app.request(`/ide/${TASK}/save`, {
      method: 'POST',
      body: 'payload',
      headers: { cookie: 'haive_access=A; k=v', 'content-type': 'text/plain' },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('x-upstream')).toBe('yes');
    expect(res.headers.get('x-other')).toBe('2');
    expect(await res.text()).toBe('created');
    const init = fetchStub.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(await new Response(init.body).text()).toBe('payload');
  });

  it('ws: an ownership miss answers 404 and a missing session 401', async () => {
    const rig = await wsRig();
    const missing = await rig.upgrade([]);
    expect(missing.reply.split('\r\n')[0]).toBe('HTTP/1.1 401 Unauthorized');
    seedDb(false);
    const foreign = await rig.upgrade([AUTH_LINE]);
    expect(foreign.reply.split('\r\n')[0]).toBe('HTTP/1.1 404 Not Found');
  });
});

describe('IDE-7 negative control', () => {
  it('an ordinary cookie arrives on both transports and the comparison can fail', async () => {
    const http = await httpCookie('other=1');
    const rig = await wsRig();
    const ws = await wsCookie(rig, ['other=1']);
    expect(http).toBe('other=1');
    expect(ws).toBe('other=1');
    expect(() => expect(http).toBe('other=2')).toThrow();
    expect(() => expect(ws).toBe('other=2')).toThrow();
  });
});

describe('IDE-8 upstream cannot set or clear the Haive session cookies', () => {
  const upstreamCookies = [
    'haive_access=x; Path=/; HttpOnly',
    'haive_refresh=; Max-Age=0; Path=/',
    'ide_pref=dark; Path=/',
    'Haive_Access=kept; Path=/',
  ];
  const expectedKept = ['ide_pref=dark; Path=/', 'Haive_Access=kept; Path=/'];

  it('http: drops haive_access and haive_refresh, keeps other Set-Cookie lines', async () => {
    fetchStub.mockImplementation(async () => {
      const headers = new Headers({ 'x-up': '1' });
      for (const line of upstreamCookies) headers.append('set-cookie', line);
      return new Response('up', { headers });
    });
    const res = await app.request(`/ide/${TASK}/x`);
    expect(res.headers.getSetCookie()).toEqual(expectedKept);
    expect(res.headers.get('x-up')).toBe('1');
  });

  it('ws: drops them from the upgrade response and relays the rest and the frames', async () => {
    const reply =
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        ...upstreamCookies.map((l) => `Set-Cookie: ${l}`),
        'Sec-WebSocket-Accept: abc',
      ].join('\r\n') + '\r\n\r\nFRAME-BYTES';
    const rig = await wsRig(reply);
    const { reply: got } = await rig.upgrade([AUTH_LINE]);
    const gotLines = got.split('\r\n');
    expect(gotLines[0]).toBe('HTTP/1.1 101 Switching Protocols');
    expect(gotLines.filter((l) => /^set-cookie:/i.test(l))).toEqual(
      expectedKept.map((l) => `Set-Cookie: ${l}`),
    );
    expect(got).toContain('Sec-WebSocket-Accept: abc');
    expect(got.endsWith('\r\n\r\nFRAME-BYTES')).toBe(true);
  });
});

describe('IDE request header controls', () => {
  it('streams a real chunked POST through HTTP to a stub upstream', async () => {
    let received: { body: string; headers: Record<string, unknown> } | undefined;
    const upstream = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      received = { body, headers: req.headers };
      res.end('saved');
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    servers.push(upstream);
    const upstreamPort = (upstream.address() as AddressInfo).port;
    fetchStub.mockImplementation((url: string, init: RequestInit) => {
      const path = new URL(url);
      return realFetch(`http://127.0.0.1:${upstreamPort}${path.pathname}${path.search}`, init);
    });
    const proxy = createAdaptorServer({ fetch: app.fetch });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    servers.push(proxy);
    const port = (proxy.address() as AddressInfo).port;
    const reply = await new Promise<string>((resolve, reject) => {
      let reply = '';
      const socket = realConnect(port, '127.0.0.1', () => {
        socket.write(
          [
            `POST /ide/${TASK}/save HTTP/1.1`,
            `Host: 127.0.0.1:${port}`,
            'Transfer-Encoding: chunked',
            'Connection: close',
            'Cookie: haive_access=A; app=ok',
            '',
            '4',
            'test',
            '3',
            '=ok',
            '0',
            '',
            '',
          ].join('\r\n'),
        );
      });
      socket.on('data', (chunk) => (reply += chunk.toString()));
      socket.on('end', () => resolve(reply));
      socket.on('error', reject);
    });
    expect(reply.split('\r\n')[0]).toBe('HTTP/1.1 200 OK');
    expect(received?.body).toBe('test=ok');
    expect(received?.headers.cookie).toBe('app=ok');
  });

  const tainted: HeaderPairs = [
    ['connection', 'keep-alive, x-private, X-Other'],
    ['keep-alive', 'timeout=10'],
    ['proxy-connection', 'keep-alive'],
    ['proxy-authenticate', 'Basic'],
    ['proxy-custom', 'secret'],
    ['te', 'trailers'],
    ['trailer', 'x-trailer'],
    ['x-private', 'secret'],
    ['x-other', 'secret2'],
    ['forwarded', 'host=evil;proto=https'],
    ['x-forwarded-for', '1.2.3.4'],
    ['x-forwarded-host', 'evil'],
    ['x-forwarded-proto', 'https'],
    ['x-forwarded-prefix', '/evil'],
  ];

  it('drops connection-scoped and client forwarding headers on HTTP', async () => {
    const forwarded = await httpForwarded([...tainted, ['upgrade', 'websocket']]);
    for (const [name] of tainted) expect(forwarded.has(name), name).toBe(false);
    expect(forwarded.has('upgrade')).toBe(false);
  });

  it('rebuilds only the WebSocket transport headers on a real upgrade', async () => {
    const rig = await wsRig();
    const { head } = await rig.upgrade([
      AUTH_LINE,
      ...tainted.map(([name, value]) => `${name}: ${value}`),
      'Transfer-Encoding: chunked',
      'Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits',
      'Sec-WebSocket-Protocol: editor, terminal',
    ]);
    const lines = headLines(head).map((line) => line.toLowerCase());
    expect(head.split('\r\n')[0]).toBe('GET / HTTP/1.1');
    for (const [name] of tainted.filter(([name]) => name !== 'connection')) {
      expect(
        lines.some((line) => line.startsWith(`${name}:`)),
        name,
      ).toBe(false);
    }
    expect(lines.filter((line) => line.startsWith('connection:'))).toEqual(['connection: upgrade']);
    expect(lines).toContain('upgrade: websocket');
    expect(lines.some((line) => line.startsWith('transfer-encoding:'))).toBe(false);
    expect(head).toContain('sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==');
    expect(lines).toContain('sec-websocket-version: 13');
    expect(lines).toContain('sec-websocket-extensions: permessage-deflate; client_max_window_bits');
    expect(lines).toContain('sec-websocket-protocol: editor, terminal');
  });
});

describe('IDE API port proxy refusal', () => {
  for (const prefix of [`/ide/${TASK}`, `/ide/repos/${TASK}`]) {
    it.each(['proxy', 'absproxy', 'PrOxY', 'AbSpRoXy'])(
      `HTTP refuses ${prefix}/%s before contacting an editor`,
      async (kind) => {
        const response = await app.request(`${prefix}/${kind}/4321/probe?x=1`);
        expect(response.status).toBe(403);
        expect(fetchStub).not.toHaveBeenCalled();
      },
    );

    it.each(['proxy', 'absproxy', 'PrOxY', 'AbSpRoXy'])(
      `WS refuses ${prefix}/%s before ensuring or contacting an editor`,
      async (kind) => {
        const rig = await wsRig();
        const { head, reply } = await rig.upgrade([AUTH_LINE], `${prefix}/${kind}/4321/probe?x=1`);
        expect(reply.split('\r\n')[0]).toBe('HTTP/1.1 403 Forbidden');
        expect(head).toBe('');
        expect(h.ensure).not.toHaveBeenCalled();
        expect(net.connect).not.toHaveBeenCalled();
      },
    );
  }

  it('keeps ordinary assets whose later segments contain proxy available', async () => {
    expect((await app.request(`/ide/${TASK}/static/proxy/asset.js`)).status).toBe(200);
  });
});

describe('IDE malformed Connection controls', () => {
  it.each(['Upgrade, a b', 'Upgrade, x/y', 'Upgrade, "q"'])(
    'WS replays the head despite invalid nominated header names: %s',
    async (connection) => {
      const rig = await wsRig();
      const { head } = await rig.upgrade([AUTH_LINE, `Connection: ${connection}`]);
      expect(head).toContain('GET / HTTP/1.1');
      expect(head).toContain('connection: Upgrade');
      expect(head).toContain('sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==');
      expect((await app.request(`/ide/${TASK}/healthz`)).status).toBe(200);
    },
  );
  it.each(['Upgrade, a b', 'Upgrade, x/y', 'Upgrade, "q"'])(
    'HTTP ignores invalid nominated header names: %s',
    async (connection) => {
      const forwarded = await httpForwarded([
        ['connection', connection],
        ['x-app', 'kept'],
      ]);
      expect(forwarded.has('connection')).toBe(false);
      expect(forwarded.get('x-app')).toBe('kept');
    },
  );
});

describe('IDE proxy boundary controls', () => {
  it('drops response hop-by-hop and Connection-nominated headers', async () => {
    const dropped: HeaderPairs = [
      ['connection', 'keep-alive, X-Private, a b, x/y, "q"'],
      ['keep-alive', 'timeout=5'],
      ['te', 'trailers'],
      ['trailer', 'x-trailer'],
      ['proxy-authenticate', 'Basic'],
      ['proxy-authorization', 'Basic secret'],
      ['proxy-connection', 'keep-alive'],
      ['proxy-custom', 'secret'],
      ['x-private', 'secret'],
      ['transfer-encoding', 'chunked'],
      ['upgrade', 'websocket'],
      ['content-encoding', 'identity'],
      ['content-length', '2'],
    ];
    fetchStub.mockResolvedValue(
      new Response('up', {
        headers: [...dropped, ['x-app', 'kept'], ['set-cookie', 'app=ok']],
      }),
    );
    const response = await app.request(`/ide/${TASK}/`);
    expect(response.status).toBe(200);
    for (const [name] of dropped) expect(response.headers.has(name), name).toBe(false);
    expect(response.headers.get('x-app')).toBe('kept');
    expect(response.headers.getSetCookie()).toEqual(['app=ok']);
    expect(await response.text()).toBe('up');
  });

  it('removes Expect before a real undici request', async () => {
    let gotExpect: string | undefined = 'not reached';
    const upstream = createServer((req, res) => {
      gotExpect = req.headers.expect;
      res.end('saved');
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    servers.push(upstream);
    const port = (upstream.address() as AddressInfo).port;
    fetchStub.mockImplementation((_url: string, init: RequestInit) =>
      realFetch(`http://127.0.0.1:${port}/save`, init),
    );
    const response = await app.request(`/ide/${TASK}/save`, {
      method: 'POST',
      body: 'payload',
      headers: { expect: '100-continue' },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('saved');
    expect(gotExpect).toBeUndefined();
  });

  it.each([`/ide/${TASK}`, `/ide/repos/${TASK}`])(
    'refuses HTTP to a running editor when disabled: %s',
    async (prefix) => {
      h.enabled = false;
      expect((await app.request(`${prefix}/static/a.js`)).status).toBe(403);
      expect(fetchStub).not.toHaveBeenCalled();
    },
  );

  it('replays non-ASCII cookie and other header bytes without UTF-8 re-encoding', async () => {
    const rig = await wsRig();
    // net.write encodes these as UTF-8 c3 a9; Node exposes those octets as latin1.
    const { head } = await rig.upgrade([AUTH_LINE, 'Cookie: name=café', 'X-App: café']);
    expect(head).toContain('cookie: name=cafÃ©\r\n');
    expect(head).toContain('x-app: cafÃ©');
    expect(head).not.toContain('haive_access');
    expect(await httpCookie('name=cafÃ©; haive_access=A')).toBe('name=cafÃ©');
  });
});
