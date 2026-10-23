import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ db: undefined as unknown, open: false }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/lib/egress-guard.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/egress-guard.js')>();
  return {
    ...real,
    isBlockedAddress: (address: string) =>
      h.open && address === '127.0.0.1' ? false : real.isBlockedAddress(address),
  };
});

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { secretsService } from '@haive/shared';
import { ACCESS_COOKIE } from '../src/auth/cookies.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { globalKbRoutes } from '../src/routes/global-kb.js';
import { toolingRoutes } from '../src/routes/tooling.js';
import type { AppEnv } from '../src/context.js';

const ADMIN = '00000000-0000-4000-8000-0000000000b1';
const USER = '00000000-0000-4000-8000-0000000000b2';
const NO_ANSWER = Symbol('no answer');
const DEADLINE_MS = 2000;

const app = new Hono<AppEnv>();
app.route('/tooling', toolingRoutes);
app.route('/global-kb', globalKbRoutes);
app.onError(errorHandler);

type Role = 'admin' | 'user';
type Reply = { status: number; body: any; text: string };
type Mode = 'normal' | 'redirect' | 'hold';

const ollama = {
  server: undefined as unknown as http.Server,
  port: 0,
  hits: 0,
  mode: 'normal' as Mode,
};
const target = { server: undefined as unknown as http.Server, port: 0, hits: 0 };
const pg = { server: undefined as unknown as net.Server, port: 0, conns: 0, first: [] as Buffer[] };
const held: http.ServerResponse[] = [];

function listen<T extends http.Server | net.Server>(server: T): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

beforeAll(async () => {
  ollama.server = http.createServer((req, res) => {
    ollama.hits += 1;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const json = (value: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (ollama.mode === 'redirect') {
        res.writeHead(302, { location: `http://127.0.0.1:${target.port}${req.url}` });
        res.end();
      } else if (req.url === '/api/tags') {
        json({ models: [{ name: 'm:latest' }] });
      } else if (req.url === '/api/show') {
        json({ capabilities: ['thinking'] });
      } else if (req.url === '/api/embed') {
        json({ embeddings: [[0.1, 0.2]] });
      } else if (req.url === '/api/pull' && ollama.mode === 'hold') {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(`${JSON.stringify({ status: 'pulling' })}\n`);
        held.push(res);
      } else if (req.url === '/api/pull') {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(`${JSON.stringify({ status: 'pulling' })}\n`);
        res.end(`${JSON.stringify({ status: 'success' })}\n`);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  target.server = http.createServer((_req, res) => {
    target.hits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: 'm:latest' }] }));
  });
  pg.server = net.createServer((socket) => {
    pg.conns += 1;
    socket.once('data', (chunk) => {
      pg.first.push(Buffer.from(chunk));
      socket.end();
    });
    socket.on('error', () => {});
  });
  ollama.port = await listen(ollama.server);
  target.port = await listen(target.server);
  pg.port = await listen(pg.server);
});

afterAll(async () => {
  for (const res of held.splice(0)) res.destroy();
  for (const server of [ollama.server, target.server, pg.server]) {
    (server as http.Server).closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

beforeEach(() => {
  const fake = createFakeDb({ users: schema.users });
  fake.insert(schema.users, { id: ADMIN, role: 'admin', status: 'active', tokenVersion: 0 });
  fake.insert(schema.users, { id: USER, role: 'user', status: 'active', tokenVersion: 0 });
  h.db = fake.db;
  h.open = false;
  ollama.hits = 0;
  ollama.mode = 'normal';
  target.hits = 0;
  pg.conns = 0;
  pg.first = [];
  vi.spyOn(secretsService, 'getJwtSecret').mockResolvedValue('cd'.repeat(32));
});

afterEach(() => {
  for (const res of held.splice(0)) res.destroy();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function post(role: Role, path: string, payload: unknown): Promise<Reply> {
  const token = await signAccessToken({ sub: role === 'admin' ? ADMIN : USER, role, tv: 0 });
  const res = await app.request(path, {
    method: 'POST',
    headers: { cookie: `${ACCESS_COOKIE}=${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, body, text };
}

function within<T>(promise: Promise<T>, ms = DEADLINE_MS): Promise<T | typeof NO_ANSWER> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<typeof NO_ANSWER>((resolve) => {
    timer = setTimeout(() => resolve(NO_ANSWER), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

function sseEvents(text: string): Array<{ event: string; data: any }> {
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block !== '')
    .map((block) => {
      const lines = block.split('\n');
      const event =
        lines
          .find((l) => l.startsWith('event:'))
          ?.slice(6)
          .trim() ?? '';
      const data =
        lines
          .find((l) => l.startsWith('data:'))
          ?.slice(5)
          .trim() ?? '';
      let parsed: any = data;
      try {
        parsed = JSON.parse(data);
      } catch {
        parsed = data;
      }
      return { event, data: parsed };
    });
}

type Probe = {
  name: string;
  path: string;
  body: (url: string) => unknown;
  refused: (reply: Reply) => boolean;
  failed?: (reply: Reply) => boolean;
  works: (reply: Reply) => boolean;
};

const pullEvents = (reply: Reply) => sseEvents(reply.text).map((e) => e.event);

const OLLAMA_PROBES: Probe[] = [
  {
    name: 'test-ollama',
    path: '/tooling/test-ollama',
    body: (ollamaUrl) => ({ ollamaUrl, model: 'm', dimensions: 2 }),
    refused: (r) => r.status < 500 && r.body?.ok === false,
    works: (r) =>
      r.body?.ok === true && r.body?.models?.includes('m:latest') && r.body?.dimsMatch === true,
  },
  {
    name: 'ollama-model-capabilities',
    path: '/tooling/ollama-model-capabilities',
    body: (ollamaUrl) => ({ ollamaUrl, model: 'm' }),
    refused: (r) =>
      r.status < 500 &&
      r.body?.reachable === false &&
      r.body?.found === false &&
      r.body?.supportsThinking === null,
    failed: (r) => r.status < 500 && r.body?.found === false && r.body?.supportsThinking === null,
    works: (r) => r.body?.reachable === true && r.body?.supportsThinking === true,
  },
  {
    name: 'pull-ollama-model',
    path: '/tooling/pull-ollama-model',
    body: (ollamaUrl) => ({ ollamaUrl, model: 'm' }),
    refused: (r) => pullEvents(r).includes('error') && !pullEvents(r).includes('done'),
    works: (r) => pullEvents(r).at(-1) === 'done',
  },
  {
    name: 'global-kb/test-ollama',
    path: '/global-kb/test-ollama',
    body: (ollamaUrl) => ({ ollamaUrl, model: 'm', dimensions: 2 }),
    refused: (r) => r.status < 500 && r.body?.ok === false,
    works: (r) => r.body?.ok === true,
  },
];

const PG_PATH = '/tooling/test-postgres';
const pgRefused = (r: Reply) => r.status < 500 && r.body?.ok === false;

describe('PR-8 the counters count', () => {
  it('a direct request to the ollama listener increments its counter', async () => {
    expect(ollama.hits).toBe(0);
    await new Promise<void>((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${ollama.port}/api/tags`, (res) => {
          res.resume();
          res.on('end', resolve);
        })
        .on('error', reject);
    });
    expect(ollama.hits).toBe(1);
  });

  it('a direct request to the redirect target increments its counter', async () => {
    expect(target.hits).toBe(0);
    await new Promise<void>((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${target.port}/x`, (res) => {
          res.resume();
          res.on('end', resolve);
        })
        .on('error', reject);
    });
    expect(target.hits).toBe(1);
  });

  it('a direct connection to the net listener increments its counter', async () => {
    expect(pg.conns).toBe(0);
    await new Promise<void>((resolve) => {
      const socket = net.connect(pg.port, '127.0.0.1', () => socket.write('x'));
      socket.on('close', () => resolve());
      socket.on('error', () => resolve());
    });
    expect(pg.conns).toBe(1);
  });
});

describe('PR-1 a user cannot aim a probe at loopback', () => {
  it.each(OLLAMA_PROBES)('$name refuses http://127.0.0.1 without connecting', async (probe) => {
    const reply = await within(
      post('user', probe.path, probe.body(`http://127.0.0.1:${ollama.port}`)),
    );
    await settle();
    expect(reply).not.toBe(NO_ANSWER);
    expect(probe.refused(reply as Reply)).toBe(true);
    expect(ollama.hits).toBe(0);
  });

  it('test-postgres refuses 127.0.0.1 without connecting', async () => {
    const reply = await within(
      post('user', PG_PATH, { connectionString: `postgres://u:p@127.0.0.1:${pg.port}/db` }),
    );
    await settle();
    expect(reply).not.toBe(NO_ANSWER);
    expect(pgRefused(reply as Reply)).toBe(true);
    expect(pg.conns).toBe(0);
  });
});

describe('PR-2 an admin keeps full reach', () => {
  it.each(OLLAMA_PROBES)('$name reaches http://127.0.0.1 and succeeds', async (probe) => {
    const reply = await post('admin', probe.path, probe.body(`http://127.0.0.1:${ollama.port}`));
    expect(ollama.hits).toBeGreaterThanOrEqual(1);
    expect(probe.works(reply)).toBe(true);
  });

  it('test-postgres reaches the net listener', async () => {
    await post('admin', PG_PATH, { connectionString: `postgres://u:p@127.0.0.1:${pg.port}/db` });
    expect(pg.conns).toBeGreaterThanOrEqual(1);
  }, 20_000);
});

const HTTP_TARGETS_AT_LISTENER = (port: number) => [
  `http://[::1]:${port}`,
  `http://[::ffff:7f00:1]:${port}`,
  `http://2130706433:${port}`,
  `http://0x7f.1:${port}`,
  `http://127.1:${port}`,
  `http://0:${port}`,
];

const HTTP_TARGETS_ELSEWHERE = [
  'http://169.254.169.254',
  'http://10.1.2.3:11434',
  'http://192.168.1.10:11434',
  'http://172.16.0.9',
  'http://[fd00::1]:11434',
];

describe('PR-3 a user is refused every blocked address', () => {
  describe.each(OLLAMA_PROBES)('$name', (probe) => {
    it.each(HTTP_TARGETS_AT_LISTENER(0).map((_, i) => i))(
      'a loopback spelling aimed at the listener, form %i, is refused without a connection',
      async (i) => {
        const url = HTTP_TARGETS_AT_LISTENER(ollama.port)[i]!;
        const reply = await within(post('user', probe.path, probe.body(url)));
        await settle();
        expect(reply).not.toBe(NO_ANSWER);
        expect(probe.refused(reply as Reply)).toBe(true);
        expect(ollama.hits).toBe(0);
      },
      4000,
    );

    it.each(HTTP_TARGETS_ELSEWHERE)(
      '%s is refused within 2 s',
      async (url) => {
        const reply = await within(post('user', probe.path, probe.body(url)));
        expect(reply).not.toBe(NO_ANSWER);
        expect(probe.refused(reply as Reply)).toBe(true);
      },
      4000,
    );
  });

  it.each([
    ['IPv4 loopback', (p: number) => `postgres://u:p@127.0.0.1:${p}/db`, true],
    ['IPv6 loopback', (p: number) => `postgres://u:p@[::1]:${p}/db`, false],
    ['link-local', () => 'postgres://u:p@169.254.169.254:5432/db', false],
    [
      'multi-host with a loopback member',
      (p: number) => `postgres://u:p@a.test:${p},127.0.0.1:${p}/db`,
      true,
    ],
    ['unix socket host', () => 'postgres://u:p@/db?host=%2Fvar%2Frun%2Fpostgresql', false],
    ['empty host', () => 'postgres:///db', true],
  ] as const)(
    'test-postgres, %s, is refused within 2 s',
    async (label, make, atListener) => {
      if (label === 'empty host') vi.stubEnv('PGPORT', String(pg.port));
      const reply = await within(post('user', PG_PATH, { connectionString: make(pg.port) }));
      await settle();
      expect(reply).not.toBe(NO_ANSWER);
      expect(pgRefused(reply as Reply)).toBe(true);
      if (atListener) expect(pg.conns).toBe(0);
    },
    4000,
  );
});

function stubNames(answers: Record<string, string[] | Error>) {
  const answer = (family: 4 | 6) => async (host: string) => {
    const result = answers[host];
    if (result instanceof Error || result === undefined) {
      throw Object.assign(new Error(`query ${host}`), { code: 'ENOTFOUND' });
    }
    return result.filter((a) => (family === 4) === net.isIPv4(a));
  };
  vi.spyOn(dns.promises.Resolver.prototype, 'resolve4').mockImplementation(answer(4) as never);
  vi.spyOn(dns.promises.Resolver.prototype, 'resolve6').mockImplementation(answer(6) as never);
}

describe('PR-4 a name that resolves to a blocked address', () => {
  it.each(OLLAMA_PROBES)('$name: localhost -> 127.0.0.1 is refused for a user', async (probe) => {
    stubNames({ localhost: ['127.0.0.1'] });
    const reply = await within(
      post('user', probe.path, probe.body(`http://localhost:${ollama.port}`)),
    );
    await settle();
    expect(reply).not.toBe(NO_ANSWER);
    expect(probe.refused(reply as Reply)).toBe(true);
    expect(ollama.hits).toBe(0);
  });

  it.each(OLLAMA_PROBES)('$name: a mixed answer is refused for a user', async (probe) => {
    stubNames({ localhost: ['127.0.0.1', '93.184.216.34'] });
    const reply = await within(
      post('user', probe.path, probe.body(`http://localhost:${ollama.port}`)),
    );
    await settle();
    expect(reply).not.toBe(NO_ANSWER);
    expect(probe.refused(reply as Reply)).toBe(true);
    expect(ollama.hits).toBe(0);
  });

  it.each(OLLAMA_PROBES)('$name: an admin reaches http://localhost', async (probe) => {
    stubNames({ localhost: ['127.0.0.1'] });
    const reply = await post('admin', probe.path, probe.body(`http://localhost:${ollama.port}`));
    expect(ollama.hits).toBeGreaterThanOrEqual(1);
    expect(probe.works(reply)).toBe(true);
  });

  it('test-postgres: localhost -> 127.0.0.1 is refused for a user', async () => {
    stubNames({ localhost: ['127.0.0.1'] });
    const reply = await within(
      post('user', PG_PATH, { connectionString: `postgres://u:p@localhost:${pg.port}/db` }),
    );
    await settle();
    expect(reply).not.toBe(NO_ANSWER);
    expect(pgRefused(reply as Reply)).toBe(true);
    expect(pg.conns).toBe(0);
  });

  it('test-postgres: a mixed answer is refused for a user', async () => {
    stubNames({ localhost: ['127.0.0.1', '93.184.216.34'] });
    const reply = await within(
      post('user', PG_PATH, { connectionString: `postgres://u:p@localhost:${pg.port}/db` }),
    );
    await settle();
    expect(reply).not.toBe(NO_ANSWER);
    expect(pgRefused(reply as Reply)).toBe(true);
    expect(pg.conns).toBe(0);
  });

  it('test-postgres: an admin reaches localhost', async () => {
    stubNames({ localhost: ['127.0.0.1'] });
    await post('admin', PG_PATH, { connectionString: `postgres://u:p@localhost:${pg.port}/db` });
    expect(pg.conns).toBeGreaterThanOrEqual(1);
  }, 20_000);
});

describe('PR-5 a blocked name answers like a name that does not resolve', () => {
  const normalize = (text: string, host: string) =>
    text
      .replace(/"pullId":"[^"]*"/g, '"pullId":"-"')
      .split(host)
      .join('<host>');
  const LEAK = /\b\d{1,3}(?:\.\d{1,3}){3}\b|::1|blocked|private|loopback|egress|reserved/i;

  it.each(OLLAMA_PROBES)(
    '$name: localhost and nonexistent.invalid give one body',
    async (probe) => {
      stubNames({ localhost: ['127.0.0.1'] });
      const blocked = await within(
        post('user', probe.path, probe.body(`http://localhost:${ollama.port}`)),
      );
      const missing = await within(
        post('user', probe.path, probe.body(`http://nonexistent.invalid:${ollama.port}`)),
      );
      expect(blocked).not.toBe(NO_ANSWER);
      expect(missing).not.toBe(NO_ANSWER);
      const a = blocked as Reply;
      const b = missing as Reply;
      expect(a.status).toBe(b.status);
      expect(normalize(a.text, 'localhost')).toBe(normalize(b.text, 'nonexistent.invalid'));
      expect(a.text).not.toMatch(LEAK);
      expect(b.text).not.toMatch(LEAK);
    },
  );

  it('test-postgres: localhost and nonexistent.invalid give one body', async () => {
    stubNames({ localhost: ['127.0.0.1'] });
    const blocked = await within(
      post('user', PG_PATH, { connectionString: `postgres://u:p@localhost:${pg.port}/db` }),
    );
    const missing = await within(
      post('user', PG_PATH, {
        connectionString: `postgres://u:p@nonexistent.invalid:${pg.port}/db`,
      }),
    );
    expect(blocked).not.toBe(NO_ANSWER);
    expect(missing).not.toBe(NO_ANSWER);
    const a = blocked as Reply;
    const b = missing as Reply;
    expect(a.status).toBe(b.status);
    expect(normalize(a.text, 'localhost')).toBe(normalize(b.text, 'nonexistent.invalid'));
    expect(a.text).not.toMatch(LEAK);
    expect(b.text).not.toMatch(LEAK);
  });
});

describe('PR-6 a redirect is not followed', () => {
  it.each(OLLAMA_PROBES)('$name reports a failure and the target sees nothing', async (probe) => {
    h.open = true;
    ollama.mode = 'redirect';
    const reply = await within(
      post('user', probe.path, probe.body(`http://127.0.0.1:${ollama.port}`)),
    );
    await settle();
    expect(reply).not.toBe(NO_ANSWER);
    expect((probe.failed ?? probe.refused)(reply as Reply)).toBe(true);
    expect(target.hits).toBe(0);
  });
});

describe('PR-7 the guarded path works end to end', () => {
  it.each(OLLAMA_PROBES)('$name works for a user when the address is allowed', async (probe) => {
    h.open = true;
    const reply = await post('user', probe.path, probe.body(`http://127.0.0.1:${ollama.port}`));
    expect(ollama.hits).toBeGreaterThanOrEqual(1);
    expect(probe.works(reply)).toBe(true);
  });

  it('the pull streams start, progress, done in order', async () => {
    h.open = true;
    const reply = await post('user', '/tooling/pull-ollama-model', {
      ollamaUrl: `http://127.0.0.1:${ollama.port}`,
      model: 'm',
    });
    const events = pullEvents(reply);
    expect(events[0]).toBe('start');
    expect(events.indexOf('progress')).toBeGreaterThan(events.indexOf('start'));
    expect(events.indexOf('done')).toBeGreaterThan(events.indexOf('progress'));
    expect(events.at(-1)).toBe('done');
  });

  it('cancel-pull still ends a running pull', async () => {
    h.open = true;
    ollama.mode = 'hold';
    const token = await signAccessToken({ sub: USER, role: 'user', tv: 0 });
    const headers = { cookie: `${ACCESS_COOKIE}=${token}`, 'content-type': 'application/json' };
    const res = await app.request('/tooling/pull-ollama-model', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ollamaUrl: `http://127.0.0.1:${ollama.port}`, model: 'm' }),
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    while (!seen.includes('\n\n')) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }
    const pullId = sseEvents(seen).find((e) => e.event === 'start')?.data?.pullId;
    expect(typeof pullId).toBe('string');
    const cancel = await app.request('/tooling/cancel-pull', {
      method: 'POST',
      headers,
      body: JSON.stringify({ pullId }),
    });
    expect(await cancel.json()).toEqual({ ok: true, cancelled: true });
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }
    expect(pullEvents({ text: seen } as Reply).at(-1)).toBe('cancelled');
  });

  it('test-postgres sends its first bytes to the listener', async () => {
    h.open = true;
    await post('user', PG_PATH, { connectionString: `postgres://u:p@127.0.0.1:${pg.port}/db` });
    expect(pg.conns).toBeGreaterThanOrEqual(1);
    expect(Buffer.concat(pg.first).length).toBeGreaterThan(0);
  }, 20_000);
});
