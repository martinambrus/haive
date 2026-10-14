import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'sandbox-token-routes-test-secret';

const h = vi.hoisted(() => ({ jobs: [] as unknown[], logged: [] as unknown[] }));

vi.mock('../src/db.js', () => ({
  getDb: () => ({
    insert: () => ({
      values: async (row: unknown) => {
        h.logged.push(row);
      },
    }),
  }),
}));
vi.mock('../src/queues.js', () => ({
  getDdevControlQueue: () => ({
    add: async (_name: string, payload: unknown) => {
      h.jobs.push(payload);
      return { waitUntilFinished: async () => ({ ok: true, output: 'ran' }) };
    },
  }),
  getDdevControlQueueEvents: () => ({}),
}));
vi.mock('@haive/shared/global-kb', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/global-kb')>()),
  resolveTaskStackContext: async () => ({
    repositoryId: null,
    tooling: { ragMode: 'none' },
    envDetectData: null,
    confirmed: null,
  }),
  resolveGlobalKbEnabled: async () => false,
}));

import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { configService } from '@haive/shared';
import { signRagToken } from '@haive/shared/rag';
import { signTaskToken, type TaskTokenAudience } from '@haive/shared/task-token';
import { ragRoutes } from '../src/routes/rag.js';
import { ddevControlRoutes } from '../src/routes/ddev-control.js';
import { SANDBOX_BODY_LIMIT_BYTES } from '../src/middleware/sandbox-body-limit.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const app = new Hono<AppEnv>();
app.route('/rag', ragRoutes);
app.route('/ddev', ddevControlRoutes);
app.onError(errorHandler);

const DDEV_ACTIONS = ['status', 'logs', 'restart'] as const;

const taskToken = (aud: TaskTokenAudience, taskId = 'task-1', ttlSeconds?: number): string =>
  signTaskToken({ aud, taskId, ttlSeconds }, SECRET);

async function post(
  path: string,
  token: string | null,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body,
  });
}

/** `<payload>.<mac>`: a task token with its version part dropped. */
const withoutVersion = (token: string): string => token.split('.').slice(1).join('.');

/** The same token with its payload swapped for another task's and its MAC kept. */
function tamperedPayload(token: string, taskId: string): string {
  const [version, , mac] = token.split('.');
  const payload = Buffer.from(
    JSON.stringify({ aud: 'ddev', taskId, exp: 99_999_999_999 }),
  ).toString('base64url');
  return `${version}.${payload}.${mac}`;
}

/** A body of exactly `bytes` bytes that every route reads as JSON and ignores the padding of. */
function bodyOf(bytes: number): string {
  const frame = JSON.stringify({ query: 'q', service: 'web', pad: '' });
  return JSON.stringify({ query: 'q', service: 'web', pad: 'x'.repeat(bytes - frame.length) });
}

beforeEach(() => {
  vi.stubEnv('CONFIG_ENCRYPTION_KEY', SECRET);
  h.jobs = [];
  h.logged = [];
  vi.spyOn(configService, 'getBoolean').mockImplementation(
    async (_key, fallback = false) => fallback,
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('harness: the routes answer a plain request', () => {
  it.each(DDEV_ACTIONS)('POST /ddev/%s without a token answers 401', async (action) => {
    const res = await post(`/ddev/${action}`, null, '{}');

    expect(res.status).toBe(401);
    expect(h.jobs).toEqual([]);
  });

  it('POST /rag/search with a RAG task token and a small body answers 200', async () => {
    const res = await post('/rag/search', signRagToken('task-1', SECRET), '{"query":"q"}');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hits: [] });
  });
});

describe('controls: a RAG task token does not open /ddev', () => {
  it.each(DDEV_ACTIONS)('POST /ddev/%s answers 401 and enqueues nothing', async (action) => {
    const res = await post(`/ddev/${action}`, signRagToken('task-1', SECRET), '{}');

    expect(res.status).toBe(401);
    expect(h.jobs).toEqual([]);
  });
});

describe('controls: an oversize body is refused', () => {
  const oversize = (field: string) => JSON.stringify({ [field]: 'x'.repeat(70 * 1024) });

  it('POST /rag/search answers 413', async () => {
    const res = await post('/rag/search', signRagToken('task-1', SECRET), oversize('query'));

    expect(res.status).toBe(413);
  });

  it.each(DDEV_ACTIONS)('POST /ddev/%s answers 413 and enqueues nothing', async (action) => {
    const res = await post(`/ddev/${action}`, signRagToken('task-1', SECRET), oversize('service'));

    expect(res.status).toBe(413);
    expect(h.jobs).toEqual([]);
  });
});

describe('/rag/search', () => {
  it('serves a rag task token, and acts for the task it names', async () => {
    const res = await post('/rag/search', taskToken('rag', 'task-xyz'), '{"query":"q"}');

    expect(res.status).toBe(200);
    expect(h.logged).toEqual([expect.objectContaining({ taskId: 'task-xyz', query: 'q' })]);
  });

  it('serves the legacy 2-part RAG token, and acts for the task it names', async () => {
    const res = await post('/rag/search', signRagToken('task-xyz', SECRET), '{"query":"q"}');

    expect(res.status).toBe(200);
    expect(h.logged).toEqual([expect.objectContaining({ taskId: 'task-xyz' })]);
  });

  it('refuses a ddev task token', async () => {
    const res = await post('/rag/search', taskToken('ddev'), '{"query":"q"}');

    expect(res.status).toBe(401);
    expect(h.logged).toEqual([]);
  });

  it.each([
    ['an expired rag token', () => taskToken('rag', 'task-1', -1)],
    ['an expired legacy token', () => signRagToken('task-1', SECRET, -1)],
    [
      'a rag token signed with another secret',
      () => signTaskToken({ aud: 'rag', taskId: 't' }, 'x'),
    ],
    ['a legacy token signed with another secret', () => signRagToken('task-1', 'other-secret')],
    ['a rag token with another task swapped in', () => tamperedPayload(taskToken('rag'), 'task-2')],
    ['a rag token with its version dropped', () => withoutVersion(taskToken('rag'))],
    ['a ddev token with its version dropped', () => withoutVersion(taskToken('ddev'))],
    ['a rag token with a fourth part', () => `${taskToken('rag')}.extra`],
    ['a malformed token', () => 'v1.not.a-token'],
  ])('refuses %s', async (_name, mint) => {
    const res = await post('/rag/search', mint(), '{"query":"q"}');

    expect(res.status).toBe(401);
    expect(h.logged).toEqual([]);
  });

  it.each([
    ['no Authorization header', {}],
    ['an empty Bearer token', { authorization: 'Bearer ' }],
    ['another scheme', { authorization: `Basic ${taskToken('rag')}` }],
    ['no scheme', { authorization: taskToken('rag') }],
  ])('refuses %s', async (_name, headers) => {
    const res = await post('/rag/search', null, '{"query":"q"}', headers);

    expect(res.status).toBe(401);
  });
});

describe('/ddev', () => {
  it.each(DDEV_ACTIONS)(
    'POST /ddev/%s serves a ddev task token for the task it names',
    async (action) => {
      const res = await post(`/ddev/${action}`, taskToken('ddev', 'task-xyz'), '{}');

      expect(res.status).toBe(200);
      expect(h.jobs).toEqual([expect.objectContaining({ taskId: 'task-xyz', action })]);
    },
  );

  it.each(DDEV_ACTIONS)('POST /ddev/%s refuses a rag task token', async (action) => {
    const res = await post(`/ddev/${action}`, taskToken('rag'), '{}');

    expect(res.status).toBe(401);
    expect(h.jobs).toEqual([]);
  });

  it.each(DDEV_ACTIONS)('POST /ddev/%s refuses the legacy 2-part RAG token', async (action) => {
    const res = await post(`/ddev/${action}`, signRagToken('task-1', SECRET), '{}');

    expect(res.status).toBe(401);
    expect(h.jobs).toEqual([]);
  });

  it.each([
    ['an expired ddev token', () => taskToken('ddev', 'task-1', -1)],
    [
      'a ddev token signed with another secret',
      () => signTaskToken({ aud: 'ddev', taskId: 't' }, 'x'),
    ],
    [
      'a ddev token with another task swapped in',
      () => tamperedPayload(taskToken('ddev'), 'task-2'),
    ],
    ['a ddev token with its version dropped', () => withoutVersion(taskToken('ddev'))],
    ['a rag token with its version dropped', () => withoutVersion(taskToken('rag'))],
    ['a ddev token with a fourth part', () => `${taskToken('ddev')}.extra`],
    ['a malformed token', () => 'v1.not.a-token'],
  ])('refuses %s', async (_name, mint) => {
    for (const action of DDEV_ACTIONS) {
      const res = await post(`/ddev/${action}`, mint(), '{}');

      expect(res.status, action).toBe(401);
    }
    expect(h.jobs).toEqual([]);
  });

  it.each([
    ['no Authorization header', {}],
    ['an empty Bearer token', { authorization: 'Bearer ' }],
    ['another scheme', { authorization: `Basic ${taskToken('ddev')}` }],
    ['no scheme', { authorization: taskToken('ddev') }],
  ])('refuses %s', async (_name, headers) => {
    const res = await post('/ddev/status', null, '{}', headers);

    expect(res.status).toBe(401);
    expect(h.jobs).toEqual([]);
  });

  it('passes the logs arguments through', async () => {
    const res = await post('/ddev/logs', taskToken('ddev'), '{"service":"db","tail":50}');

    expect(res.status).toBe(200);
    expect(h.jobs).toEqual([{ taskId: 'task-1', action: 'logs', service: 'db', tail: 50 }]);
  });
});

describe('the body limit', () => {
  const LIMIT = SANDBOX_BODY_LIMIT_BYTES;
  const ROUTES: Array<[string, TaskTokenAudience]> = [
    ['/rag/search', 'rag'],
    ['/ddev/status', 'ddev'],
    ['/ddev/logs', 'ddev'],
    ['/ddev/restart', 'ddev'],
  ];
  const framings: Array<[string, (body: string) => Record<string, string>]> = [
    ['streamed', () => ({})],
    ['with a Content-Length', (body) => ({ 'content-length': String(Buffer.byteLength(body)) })],
  ];

  it('is 64 KiB', () => {
    expect(LIMIT).toBe(65_536);
  });

  describe.each(ROUTES)('%s', (path, aud) => {
    describe.each(framings)('%s', (_framing, headers) => {
      it('serves a body at the limit', async () => {
        const body = bodyOf(LIMIT);

        const res = await post(path, taskToken(aud), body, headers(body));

        expect(Buffer.byteLength(body)).toBe(LIMIT);
        expect(res.status).toBe(200);
      });

      it('answers 413 one byte past it, with a JSON error that names the limit', async () => {
        const body = bodyOf(LIMIT + 1);

        const res = await post(path, taskToken(aud), body, headers(body));

        expect(res.status).toBe(413);
        expect(await res.json()).toEqual({ error: expect.stringContaining('65536'), code: null });
        expect(h.jobs).toEqual([]);
        expect(h.logged).toEqual([]);
      });
    });
  });

  it('answers 413 to a request that never declares a length and then sends too much', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(1024));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 70; i += 1) controller.enqueue(chunk);
        controller.close();
      },
    });

    const res = await app.request('/ddev/logs', {
      method: 'POST',
      headers: { authorization: `Bearer ${taskToken('ddev')}` },
      body: stream,
      duplex: 'half',
    } as RequestInit);

    expect(res.status).toBe(413);
    expect(h.jobs).toEqual([]);
  });

  it('leaves the user-facing rag playground mount alone', async () => {
    const playground = new Hono<AppEnv>();
    playground.post('/query', async (c) => c.json({ bytes: (await c.req.text()).length }));
    const mounted = new Hono<AppEnv>();
    mounted.route('/rag', ragRoutes);
    mounted.route('/rag/playground', playground);
    mounted.onError(errorHandler);

    const res = await mounted.request('/rag/playground/query', {
      method: 'POST',
      body: 'x'.repeat(LIMIT + 1024),
    });

    expect(await res.json()).toEqual({ bytes: LIMIT + 1024 });
  });
});

describe('over a real socket', () => {
  it('answers 413 to an oversize body and still serves a small one', async () => {
    let port = 0;
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      port = (info as AddressInfo).port;
    });
    await new Promise((resolve) => server.once('listening', resolve));
    const call = (path: string, aud: TaskTokenAudience, body: string) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${taskToken(aud)}`, 'content-type': 'application/json' },
        body,
      });

    try {
      const small = await call('/ddev/logs', 'ddev', '{"tail":5}');
      const big = await call('/ddev/logs', 'ddev', bodyOf(SANDBOX_BODY_LIMIT_BYTES + 1));
      const bigRag = await call('/rag/search', 'rag', bodyOf(SANDBOX_BODY_LIMIT_BYTES + 1));

      expect(small.status).toBe(200);
      expect(big.status).toBe(413);
      expect(bigRag.status).toBe(413);
      expect(h.jobs).toEqual([expect.objectContaining({ action: 'logs', tail: 5 })]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
