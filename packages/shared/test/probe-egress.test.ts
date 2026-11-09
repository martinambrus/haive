import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createGuardedFetch,
  createGuardedPgSocket,
  guardedFetch,
  guardedPgSocket,
} from '../src/egress/probe-egress.js';
import { ConfigUnavailableError } from '../src/config/index.js';
import { parseAllowlist } from '../src/egress/allowlist.js';

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
    } else if (req.url === '/odd-status') {
      res.writeHead(600);
      res.end('x');
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
    } else if (req.url === '/gzip' || req.url === '/deflate' || req.url === '/br') {
      const encode =
        req.url === '/gzip'
          ? zlib.gzipSync
          : req.url === '/deflate'
            ? zlib.deflateSync
            : zlib.brotliCompressSync;
      const body = encode(Buffer.from('decoded body'));
      res.writeHead(200, {
        'content-encoding': req.url.slice(1),
        'content-length': String(body.length),
      });
      res.end(body);
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

  it('resolves an exempt host through the system lookup, so a hosts-file name reaches it', async () => {
    const lookup = vi
      .spyOn(dns.promises, 'lookup')
      .mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never);
    try {
      const f = createGuardedFetch({ allowHosts: new Set(['hosts-only.test']) });
      const res = await f(`http://hosts-only.test:${server.port}/`);
      expect(res.status).toBe(200);
      expect(lookup).toHaveBeenCalledWith('hosts-only.test', { all: true });
    } finally {
      lookup.mockRestore();
    }
  });

  it('rejects a status a Response cannot hold as a fetch failure', async () => {
    const f = createGuardedFetch({ isBlocked: () => false });
    const err = await failure(f(`http://127.0.0.1:${server.port}/odd-status`));
    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toBe('fetch failed');
    expect(err.cause).toBeInstanceOf(RangeError);
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
      setTimeout(() => reject(new Error('hang')), 1000);
      void guardedPgSocket(options).then((socket) => socket.on('error', resolve), reject);
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
      tcp.listen(0, '127.0.0.1', async () => {
        const socket = await createGuardedPgSocket({ isBlocked: () => false })({
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
      void make({ host: ['db.test'], port: [5432] }).then((socket) => socket.on('error', resolve));
    });
    expect(err.message).toBe('getaddrinfo ENOTFOUND db.test');
  });
});

describe('private endpoint allowlist', () => {
  const allow = (raw: string) => () => parseAllowlist(raw);
  const url = (host: string) => `http://${host}:${server.port}/`;
  const loopback = () => resolverOf(() => ['127.0.0.1']);

  it('reaches a listed CIDR literal and refuses an unlisted literal', async () => {
    const ok = await createGuardedFetch({ privateAllowlist: allow('127.0.0.0/8') })(
      url('127.0.0.1'),
    );
    expect(ok.status).toBe(200);
    const err = await failure(
      createGuardedFetch({ privateAllowlist: allow('10.0.0.0/8') })(url('127.0.0.1')),
    );
    expect(err.cause.code).toBe('ENOTFOUND');
  });

  it('reaches a listed hostname whatever it resolves to', async () => {
    const r = loopback();
    const fetchFn = createGuardedFetch({ resolve: r.resolve, privateAllowlist: allow('db.test.') });
    expect((await fetchFn(url('DB.test'))).status).toBe(200);
    expect((await fetchFn(url('db.test.'))).status).toBe(200);
  });

  it.each([
    ['169.254.169.254'],
    ['fe80::1'],
    ['0.0.0.0'],
    ['127.0.0.1', '169.254.169.254'],
    ['100.100.100.200'],
    ['192.0.0.192'],
    ['fd00:ec2::254'],
    ['::a9fe:a9fe'],
    ['10.1.2.3', '100.100.100.200'],
  ])(
    'a hostname entry never lifts a link-local, unspecified or cloud metadata answer %j',
    async (...answers) => {
      const r = resolverOf(() => answers);
      const err = await failure(
        createGuardedFetch({ resolve: r.resolve, privateAllowlist: allow('meta.test') })(
          url('meta.test'),
          { signal: AbortSignal.timeout(500) },
        ),
      );
      expect(err.cause.code).toBe('ENOTFOUND');
    },
  );

  it('an address entry or a CIDR entry still lifts a link-local answer', async () => {
    for (const entry of ['169.254.169.254', '169.254.0.0/16']) {
      const r = resolverOf(() => ['169.254.169.254']);
      const err = await failure(
        createGuardedFetch({ resolve: r.resolve, privateAllowlist: allow(entry) })(
          url('meta.test'),
          { signal: AbortSignal.timeout(500) },
        ),
      );
      expect(err.cause?.code).not.toBe('ENOTFOUND');
    }
  });

  it('a hostname entry still lifts an ordinary private answer', async () => {
    const r = resolverOf(() => ['10.1.2.3']);
    const err = await failure(
      createGuardedFetch({ resolve: r.resolve, privateAllowlist: allow('gitea.lan') })(
        url('gitea.lan'),
        { signal: AbortSignal.timeout(500) },
      ),
    );
    expect(err.cause?.code).not.toBe('ENOTFOUND');
  });

  it('a hostname entry still lifts a loopback answer that includes ::1', async () => {
    const r = resolverOf(() => ['::1', '127.0.0.1']);
    const res = await createGuardedFetch({
      resolve: r.resolve,
      privateAllowlist: allow('local.test'),
    })(url('local.test'));
    expect(res.status).toBe(200);
  });

  it('a pg socket under a hostname entry refuses a link-local answer', async () => {
    const r = resolverOf(() => ['169.254.169.254']);
    const socket = await createGuardedPgSocket({
      resolve: r.resolve,
      privateAllowlist: allow('meta.test'),
    })({ host: ['meta.test'], port: [5432] });
    const err = await new Promise<NodeJS.ErrnoException>((resolve) => socket.on('error', resolve));
    socket.destroy();
    expect(err.code).toBe('ENOTFOUND');
  });

  it('passes an unlisted name that resolves to a listed address, by policy', async () => {
    const r = loopback();
    const res = await createGuardedFetch({
      resolve: r.resolve,
      privateAllowlist: allow('127.0.0.1/32'),
    })(url('other.test'));
    expect(res.status).toBe(200);
  });

  it('refuses a name when one address in its answer is not covered', async () => {
    const r = resolverOf(() => ['127.0.0.1', '10.0.0.5']);
    const err = await failure(
      createGuardedFetch({ resolve: r.resolve, privateAllowlist: allow('127.0.0.1') })(
        url('mixed.test'),
      ),
    );
    expect(err.cause.code).toBe('ENOTFOUND');
  });

  it('a hostname entry does not allow an IP literal and an IP entry does not allow a name', async () => {
    const lit = await failure(
      createGuardedFetch({ privateAllowlist: allow('localhost') })(url('127.0.0.1')),
    );
    expect(lit.cause.code).toBe('ENOTFOUND');
    const r = loopback();
    const named = await failure(
      createGuardedFetch({ resolve: r.resolve, privateAllowlist: allow('10.0.0.0/8') })(
        url('db.test'),
      ),
    );
    expect(named.cause.code).toBe('ENOTFOUND');
  });

  it('resolves once per dial', async () => {
    const r = loopback();
    await createGuardedFetch({ resolve: r.resolve, privateAllowlist: allow('db.test') })(
      url('db.test'),
    );
    expect(r.calls).toEqual(['db.test']);
  });

  it('keeps a built-in host exempt with an empty allowlist', async () => {
    const r = loopback();
    const res = await createGuardedFetch({
      resolve: r.resolve,
      allowHosts: new Set(['ollama']),
      privateAllowlist: allow(''),
    })(url('ollama'));
    expect(res.status).toBe(200);
  });

  it('still refuses as ENOTFOUND, with the host in the message', async () => {
    const err = await failure(
      createGuardedFetch({ privateAllowlist: allow('') })(url('127.0.0.1')),
    );
    expect(err.cause.code).toBe('ENOTFOUND');
    expect(err.cause.message).toBe('getaddrinfo ENOTFOUND 127.0.0.1');
  });

  it('still refuses when the loader throws', async () => {
    const err = await failure(
      createGuardedFetch({
        privateAllowlist: () => {
          throw new Error('store down');
        },
      })(url('127.0.0.1')),
    );
    expect(err.cause.code).toBe('ENOTFOUND');
  });

  it('lets a config outage through un-normalised, with no dial', async () => {
    const outage = new ConfigUnavailableError('get');
    const privateAllowlist = () => {
      throw outage;
    };
    const tcp = net.createServer();
    let connections = 0;
    tcp.on('connection', (s) => {
      connections += 1;
      s.destroy();
    });
    await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', r));
    const port = (tcp.address() as AddressInfo).port;
    const fetched = await failure(
      createGuardedFetch({ privateAllowlist })(`http://127.0.0.1:${port}/`),
    );
    expect(fetched).toBe(outage);
    await expect(
      createGuardedPgSocket({ privateAllowlist })({ host: ['127.0.0.1'], port: [port] }),
    ).rejects.toBe(outage);
    expect(connections).toBe(0);
    await new Promise((r) => tcp.close(r));
  });

  it('treats any other loader failure as an empty list, keeping allowHosts working', async () => {
    const privateAllowlist = () => {
      throw new Error('boom');
    };
    const before = server.hits;
    const err = await failure(createGuardedFetch({ privateAllowlist })(url('127.0.0.1')));
    expect(err).toBeInstanceOf(TypeError);
    expect(err.cause.code).toBe('ENOTFOUND');
    expect(server.hits).toBe(before);
    const r = loopback();
    const res = await createGuardedFetch({
      resolve: r.resolve,
      privateAllowlist,
      allowHosts: new Set(['exempt.test']),
    })(url('exempt.test'));
    expect(res.status).toBe(200);
  });

  it('does not dial when the signal aborts while the list loads', async () => {
    const controller = new AbortController();
    const before = server.hits;
    const pending = createGuardedFetch({
      privateAllowlist: async () => {
        controller.abort(new Error('stop'));
        return parseAllowlist('127.0.0.1');
      },
    })(url('127.0.0.1'), { signal: controller.signal });
    await expect(pending).rejects.toThrow('stop');
    expect(server.hits).toBe(before);
  });

  it('the pg socket honours the allowlist', async () => {
    const tcp = net.createServer((s) => s.destroy());
    await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', r));
    const port = (tcp.address() as AddressInfo).port;
    const socket = await createGuardedPgSocket({ privateAllowlist: allow('127.0.0.1') })({
      host: ['127.0.0.1'],
      port: [port],
    });
    await new Promise<void>((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('error', reject);
    });
    socket.destroy();
    const refused = await createGuardedPgSocket({ privateAllowlist: allow('') })({
      host: ['127.0.0.1'],
      port: [port],
    });
    const err = await new Promise<NodeJS.ErrnoException>((resolve) => refused.on('error', resolve));
    expect(err.code).toBe('ENOTFOUND');
    await new Promise((r) => tcp.close(r));
  });
});

describe('guarded fetch bodies', () => {
  const fetchFn = createGuardedFetch({
    isBlocked: () => false,
    privateAllowlist: () => parseAllowlist(''),
  });
  const at = (p: string) => `http://127.0.0.1:${server.port}${p}`;

  it.each(['gzip', 'deflate', 'br'])('decodes %s and drops the encoding headers', async (name) => {
    const res = await fetchFn(at(`/${name}`));
    expect(await res.text()).toBe('decoded body');
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('content-length')).toBeNull();
  });

  it('sends a Uint8Array body intact', async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    const res = await fetchFn(at('/echo'), { method: 'POST', body: bytes });
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it('rejects any other body type with a TypeError', async () => {
    await expect(
      fetchFn(at('/echo'), { method: 'POST', body: { a: 1 } as never }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      fetchFn(at('/echo'), { method: 'POST', body: new URLSearchParams('a=1') }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
