import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createGuardedFetch,
  createGuardedPgSocket,
  egressFor,
  guardedFetch,
  guardedPgSocket,
} from '../src/lib/probe-egress.js';

const server = { http: undefined as unknown as http.Server, port: 0, hits: 0, other: 0 };
const other = { http: undefined as unknown as http.Server, port: 0 };
const held: http.ServerResponse[] = [];

const listen = (s: http.Server): Promise<number> =>
  new Promise((resolve) =>
    s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)),
  );

beforeAll(async () => {
  server.http = http.createServer((req, res) => {
    server.hits += 1;
    if (req.url === '/redirect') {
      res.writeHead(302, { location: `http://127.0.0.1:${other.port}/x` });
      res.end();
    } else if (req.url === '/empty') {
      res.writeHead(204);
      res.end();
    } else if (req.url === '/hold') {
      res.writeHead(200);
      res.write('x');
      held.push(res);
    } else if (req.url === '/echo') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'x-accept-encoding': String(req.headers['accept-encoding']) });
        res.end(Buffer.concat(chunks));
      });
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    }
  });
  other.http = http.createServer((_req, res) => {
    server.other += 1;
    res.end();
  });
  server.port = await listen(server.http);
  other.port = await listen(other.http);
});

afterAll(async () => {
  for (const res of held) res.destroy();
  for (const s of [server.http, other.http]) {
    s.closeAllConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

const PUBLIC = '93.184.216.34';
const resolverOf = (answers: () => string[]) => {
  const calls: string[] = [];
  const resolve = async (host: string) => {
    calls.push(host);
    return answers().map((address) => ({ address, family: net.isIPv4(address) ? 4 : 6 }));
  };
  return { calls, resolve };
};

async function failure(promise: Promise<unknown>): Promise<TypeError & { cause: any }> {
  try {
    await promise;
  } catch (err) {
    return err as never;
  }
  throw new Error('expected a rejection');
}

describe('guarded fetch', () => {
  it('refuses a blocked literal as a fetch failure that reads like a missing name', async () => {
    const before = server.hits;
    const err = await failure(guardedFetch(`http://127.0.0.1:${server.port}/`));
    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toBe('fetch failed');
    expect(err.cause.code).toBe('ENOTFOUND');
    expect(err.cause.message).toBe('getaddrinfo ENOTFOUND 127.0.0.1');
    expect(server.hits).toBe(before);
  });

  it('allows a public literal without any lookup', async () => {
    const names = resolverOf(() => []);
    const f = createGuardedFetch({ resolve: names.resolve, isBlocked: () => false });
    const res = await f(`http://127.0.0.1:${server.port}/`);
    expect(await res.json()).toEqual({ ok: true });
    expect(names.calls).toEqual([]);
  });

  it('connects to the address it checked: one lookup serves one connect', async () => {
    let n = 0;
    const names = resolverOf(() => (n++ === 0 ? ['127.0.0.1'] : ['10.0.0.1']));
    const f = createGuardedFetch({ resolve: names.resolve, isBlocked: (a) => a === '10.0.0.1' });
    const res = await f(`http://rebind.test:${server.port}/`);
    expect(res.status).toBe(200);
    expect(names.calls).toEqual(['rebind.test']);
  });

  it('refuses a mixed answer and a name that resolves to nothing the same way', async () => {
    const before = server.hits;
    const mixed = createGuardedFetch({
      resolve: resolverOf(() => ['127.0.0.1', PUBLIC]).resolve,
      isBlocked: (a) => a === '127.0.0.1',
    });
    const missing = createGuardedFetch({ resolve: resolverOf(() => []).resolve });
    const a = await failure(mixed(`http://m.test:${server.port}/`));
    const b = await failure(missing(`http://m.test:${server.port}/`));
    expect(a.message).toBe('fetch failed');
    expect(a.cause.message).toBe(b.cause.message);
    expect(a.cause.code).toBe(b.cause.code);
    expect(server.hits).toBe(before);
  });

  it('returns a redirect as is and never follows it', async () => {
    const f = createGuardedFetch({ isBlocked: () => false });
    const res = await f(`http://127.0.0.1:${server.port}/redirect`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain(`:${other.port}/x`);
    await new Promise((r) => setTimeout(r, 50));
    expect(server.other).toBe(0);
  });

  it('sends identity encoding, a string body and the given method', async () => {
    const f = createGuardedFetch({ isBlocked: () => false });
    const res = await f(`http://127.0.0.1:${server.port}/echo`, { method: 'POST', body: 'héllo' });
    expect(res.headers.get('x-accept-encoding')).toBe('identity');
    expect(await res.text()).toBe('héllo');
  });

  it('gives a 204 a null body', async () => {
    const f = createGuardedFetch({ isBlocked: () => false });
    const res = await f(`http://127.0.0.1:${server.port}/empty`);
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
  });

  it('rejects with the signal reason when aborted mid-response, and when already aborted', async () => {
    const f = createGuardedFetch({ isBlocked: () => false });
    const controller = new AbortController();
    const pending = f(`http://127.0.0.1:${server.port}/hold`, { signal: controller.signal });
    const res = await pending;
    const reading = res.text();
    controller.abort(new Error('stop'));
    await expect(reading).rejects.toBeDefined();

    const early = new AbortController();
    early.abort(new Error('already'));
    await expect(f(`http://127.0.0.1:${server.port}/`, { signal: early.signal })).rejects.toThrow(
      'already',
    );
  });

  it('rejects an abort that lands before the response head', async () => {
    const slow = http.createServer(() => {});
    const port = await listen(slow);
    const f = createGuardedFetch({ isBlocked: () => false });
    const controller = new AbortController();
    const pending = f(`http://127.0.0.1:${port}/`, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('late')), 30);
    await expect(pending).rejects.toThrow('late');
    slow.closeAllConnections();
    await new Promise<void>((resolve) => slow.close(() => resolve()));
  });

  it('refuses a non-http scheme as a fetch failure', async () => {
    const err = await failure(guardedFetch('ftp://example.test/'));
    expect(err.message).toBe('fetch failed');
  });
});

describe('guarded postgres socket', () => {
  const refused = (options: Parameters<typeof guardedPgSocket>[0]) =>
    new Promise<NodeJS.ErrnoException>((resolve, reject) => {
      const socket = guardedPgSocket(options);
      socket.on('error', resolve);
      setTimeout(() => reject(new Error('hang')), 1000);
    });

  it.each([
    ['a unix path', { host: ['db.test'], port: [5432], path: '/var/run/pg' }],
    ['a slash in the host', { host: ['/var/run/pg'], port: [5432] }],
    ['several hosts', { host: ['a.test', 'b.test'], port: [5432, 5432] }],
    ['no host', { host: [], port: [] }],
    ['a blocked literal', { host: ['127.0.0.1'], port: [5432] }],
  ])('refuses %s with an ENOTFOUND error and no hang', async (_label, options) => {
    const err = await refused(options as never);
    expect(err.code).toBe('ENOTFOUND');
  });

  it('connects a public literal and sets the TLS server name host', async () => {
    const accepted = new Promise<void>((resolve) => {
      const tcp = net.createServer((s) => {
        s.destroy();
        tcp.close();
        resolve();
      });
      tcp.listen(0, '127.0.0.1', () => {
        const socket = createGuardedPgSocket({ isBlocked: () => false })({
          host: ['127.0.0.1'],
          port: [(tcp.address() as AddressInfo).port],
        });
        socket.on('error', () => {});
        expect((socket as net.Socket & { host?: string }).host).toBe('127.0.0.1');
      });
    });
    await accepted;
  });

  it('refuses a name whose answer is blocked', async () => {
    const make = createGuardedPgSocket({
      resolve: resolverOf(() => ['127.0.0.1']).resolve,
      isBlocked: (a) => a === '127.0.0.1',
    });
    const err = await new Promise<NodeJS.ErrnoException>((resolve) => {
      make({ host: ['db.test'], port: [5432] }).on('error', resolve);
    });
    expect(err.message).toBe('getaddrinfo ENOTFOUND db.test');
  });
});

describe('egressFor', () => {
  it('gives an admin the global fetch and no socket', () => {
    expect(egressFor('admin')).toEqual({ fetchFn: fetch, pgSocket: undefined });
  });

  it.each(['user', undefined])('guards role %s', (role) => {
    const { fetchFn, pgSocket } = egressFor(role);
    expect(fetchFn).not.toBe(fetch);
    expect(typeof pgSocket).toBe('function');
  });
});
