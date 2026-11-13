import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// @ts-expect-error - plain .mjs sidecar source, no types
import { createGateServer, isAllowed } from '../../../docker/ollama-gate/server.mjs';

const inference = [
  '/v1/messages',
  '/v1/messages/count_tokens',
  '/v1/chat/completions',
  '/v1/completions',
  '/v1/embeddings',
  '/api/chat',
  '/api/generate',
  '/api/embed',
  '/api/embeddings',
  '/api/show',
];
const reads = [
  '/',
  '/api/version',
  '/api/tags',
  '/api/ps',
  '/api/hello',
  '/v1/models',
  '/v1/models/qwen3:1.7b',
];
const allowed = [
  ...inference.map((path) => ['POST', path]),
  ...reads.flatMap((path) => ['GET', 'HEAD'].map((method) => [method, path])),
];
const refused = [
  ...['pull', 'push', 'create', 'delete', 'copy'].map((name) => ['POST', `/api/${name}`]),
  ['DELETE', '/api/delete'],
  ['POST', '/api/blobs/sha256:x'],
  ['HEAD', '/api/blobs/sha256:x'],
  ['GET', '/api/delete'],
  ['POST', '/v1/messages/../api/delete'],
  ['POST', '/v1/messages/%2e%2e/api/delete'],
  ['POST', '/api/%64elete'],
  ['GET', '/api/tags/'],
  ['GET', '/API/TAGS'],
  ['GET', '/v1/messages'],
  ['POST', '/api/foo'],
  ['POST', 'http://x/api/delete'],
  ['GET', 'http://x/api/tags'],
  ['GET', '/v1/models/.'],
  ['GET', '/v1/models/..'],
  ['GET', '/v1/models/%2E'],
  ['GET', '/v1/models/a%2Fb'],
  ['GET', '/v1/models/a/b'],
  ['GET', '/v1/models/a/'],
  ['GET', '/v1/models/'],
  ['GET', '/v1/models/a\\b'],
  ['PUT', '/api/show'],
  ['OPTIONS', '/api/tags'],
];

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as { port: number }).port;
}
async function close(server: Server) {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}
function request(port: number, method: string, path: string, headers = {}, body = '') {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers, agent: false },
      (res) => {
        let result = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          result += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode!, body: result }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('Ollama gate', () => {
  let upstream: Server;
  let gate: Server;
  let port: number;
  const hits: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] =
    [];
  let handler: ((req: IncomingMessage, res: ServerResponse) => void) | undefined;

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      if (handler) {
        handler(req, res);
        return;
      }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        hits.push({ method: req.method!, url: req.url!, headers: req.headers, body });
        res.end(req.url);
      });
    });
    const upstreamPort = await listen(upstream);
    gate = createGateServer({ upstreamHost: '127.0.0.1', upstreamPort });
    port = await listen(gate);
  });
  afterAll(async () => {
    await close(gate);
    await close(upstream);
  });

  it('forwards an allowed request with its original query and body', async () => {
    const url = '/v1/messages?beta=true&raw=%2f%2E';
    const before = hits.length;
    const result = await request(port, 'POST', url, { 'x-test': 'kept' }, 'payload');
    expect(result).toEqual({ status: 200, body: url });
    expect(hits.slice(before)).toMatchObject([
      { method: 'POST', url, headers: { 'x-test': 'kept' }, body: 'payload' },
    ]);
  });

  // Over HTTP only the targets whose raw form must survive Node's parser unchanged:
  // the decision itself is covered for every variant by the pure tests below.
  it.each([
    ['POST', '/api/delete'],
    ['POST', '/v1/messages/../api/delete'],
    ['POST', 'http://x/api/delete'],
  ])('refuses %s %s without contacting upstream', async (method, path) => {
    const before = hits.length;
    const result = await request(port, method!, path!);
    expect(result.status).toBe(403);
    expect(JSON.parse(result.body)).toEqual({
      error: { type: 'forbidden', message: expect.any(String) },
    });
    expect(hits).toHaveLength(before);
  });

  it('refuses an empty raw path rather than defaulting it to root', () => {
    // HTTP itself rejects an empty request target; test the policy without client normalization.
    expect(isAllowed('GET', '')).toBe(false);
    expect(isAllowed('HEAD', '?beta=true')).toBe(false);
    const before = hits.length;
    const res = { destroyed: false, headersSent: false, writeHead: vi.fn(), end: vi.fn() };
    // A real HTTP client replaces an empty target with '/', and the HTTP parser
    // rejects an actually empty target. Exercise the request listener directly.
    gate.emit('request', { method: 'GET', url: '', resume: vi.fn() }, res);
    expect(res.writeHead).toHaveBeenCalledWith(403, { 'content-type': 'application/json' });
    expect(JSON.parse(res.end.mock.calls[0]![0])).toEqual({
      error: { type: 'forbidden', message: expect.any(String) },
    });
    expect(hits).toHaveLength(before);
  });

  it('drops all method-override headers and resets Host', async () => {
    await request(port, 'POST', '/api/show', {
      'X-HTTP-Method-Override': 'DELETE',
      'X-HTTP-Method': 'DELETE',
      'X-Method-Override': 'DELETE',
      host: 'attacker',
      authorization: 'Bearer keep',
    });
    const headers = hits.at(-1)!.headers;
    for (const name of ['x-http-method-override', 'x-http-method', 'x-method-override'])
      expect(headers[name]).toBeUndefined();
    expect(headers.host).toMatch(/^127\.0\.0\.1:/);
    expect(headers.authorization).toBe('Bearer keep');
  });

  it('streams SSE before the upstream finishes', async () => {
    let finish!: () => void;
    let first = '';
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-upstream': 'kept' });
      res.write('data: first\n\n');
      finish = () => res.end('data: last\n\n');
    };
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(
          { host: '127.0.0.1', port, path: '/api/tags', agent: false },
          (res) => {
            expect(res.headers['content-type']).toBe('text/event-stream');
            expect(res.headers['x-upstream']).toBe('kept');
            res.setEncoding('utf8');
            let result = '';
            res.once('data', (chunk) => {
              first = chunk;
              finish();
            });
            res.on('data', (chunk) => {
              result += chunk;
            });
            res.on('end', () => {
              expect(first).toBe('data: first\n\n');
              expect(result).toBe('data: first\n\ndata: last\n\n');
              resolve();
            });
            res.on('error', reject);
          },
        );
        req.on('error', reject);
      });
    } finally {
      handler = undefined;
      finish?.();
    }
  });

  it('streams a request before the client finishes', async () => {
    handler = (req, res) => {
      req.once('data', (chunk) => res.write(chunk));
      req.on('end', () => res.end('done'));
    };
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port, method: 'POST', path: '/api/chat', agent: false },
          (res) => {
            let result = '';
            res.setEncoding('utf8');
            res.once('data', () => req.end());
            res.on('data', (chunk) => {
              result += chunk;
            });
            res.on('end', () => {
              expect(result).toBe('firstdone');
              resolve();
            });
            res.on('error', reject);
          },
        );
        req.on('error', reject);
        req.write('first');
      });
    } finally {
      handler = undefined;
    }
  });

  it('answers 502 JSON when upstream is down', async () => {
    const down = http.createServer();
    const upstreamPort = await listen(down);
    await close(down);
    const broken = createGateServer({ upstreamHost: '127.0.0.1', upstreamPort });
    const brokenPort = await listen(broken);
    try {
      const result = await request(brokenPort, 'POST', '/v1/messages');
      expect(result.status).toBe(502);
      expect(JSON.parse(result.body)).toEqual({
        error: { type: 'proxy_error', message: expect.any(String) },
      });
      expect(result.body).not.toContain('127.0.0.1');
    } finally {
      await close(broken);
    }
  });
});

describe('Ollama gate policy', () => {
  it.each(allowed)('allows %s %s, with or without a query', (method, path) => {
    expect(isAllowed(method, path)).toBe(true);
    expect(isAllowed(method, `${path}?beta=true&raw=%2f%2E`)).toBe(true);
  });

  it.each(refused)('refuses %s %s', (method, path) => {
    expect(isAllowed(method, path)).toBe(false);
  });
});
