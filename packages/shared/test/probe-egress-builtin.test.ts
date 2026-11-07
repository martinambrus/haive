import dns from 'node:dns';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { EMPTY, type ParsedAllowlist } from '../src/egress/allowlist.js';
import { ConfigUnavailableError } from '../src/config/index.js';
import { createGuardedFetch, createGuardedPgSocket } from '../src/egress/probe-egress.js';

const outage = new ConfigUnavailableError('get');
const toLoopback = async () => [{ address: '127.0.0.1', family: 4 as const }];

let spy: Mock<() => ParsedAllowlist>;
let server: http.Server;
let port: number;

beforeEach(async () => {
  spy = vi.fn((): ParsedAllowlist => {
    throw outage;
  });
  server = http.createServer((_req, res) => res.end('ok'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const seams = () => ({
  allowHosts: new Set(['ollama']),
  resolve: toLoopback,
  privateAllowlist: spy,
});

describe('built-in host never reads the allowlist', () => {
  it('fetch reaches a built-in name during a store outage', async () => {
    const res = await createGuardedFetch(seams())(`http://ollama:${port}/`);
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(0);
  });

  it('fetch matches an upper-case built-in host', async () => {
    const res = await createGuardedFetch(seams())(`http://OLLAMA:${port}/`);
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(0);
  });

  it('pg socket connects to a built-in name during a store outage', async () => {
    const tcp = net.createServer((s) => s.end());
    await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', r));
    const tcpPort = (tcp.address() as AddressInfo).port;
    const socket = await createGuardedPgSocket(seams())({ host: ['ollama'], port: [tcpPort] });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.destroy();
    await new Promise((r) => tcp.close(r));
    expect(spy).toHaveBeenCalledTimes(0);
  });

  it('a built-in host still bypasses a blocking classifier', async () => {
    const res = await createGuardedFetch({ ...seams(), isBlocked: () => true })(
      `http://ollama:${port}/`,
    );
    expect(res.status).toBe(200);
  });
});

describe('a host that is not built in keeps the outage behaviour', () => {
  it('fetch rejects with the outage error', async () => {
    await expect(createGuardedFetch(seams())(`http://other:${port}/`)).rejects.toBe(outage);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('pg socket emits the outage error', async () => {
    const socket = await createGuardedPgSocket(seams())({ host: ['other'], port: [port] });
    const err = await new Promise<unknown>((resolve) => socket.once('error', resolve));
    expect(err).toBe(outage);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('an invalid URL still rejects with fetch failed', async () => {
    const f = createGuardedFetch({
      privateAllowlist: () => EMPTY,
    });
    await expect(f('not a url')).rejects.toThrow(TypeError);
    await expect(f('not a url')).rejects.toThrow('fetch failed');
  });
});

describe('a built-in origin', () => {
  const origins = () => new Set([`http://host.docker.internal:${port}`]);
  const refusal = async (promise: Promise<unknown>) => {
    const err = (await promise.then(
      () => undefined,
      (e: unknown) => e,
    )) as { cause?: { code?: string } } | undefined;
    expect(err?.cause?.code).toBe('ENOTFOUND');
  };
  const base = () => ({
    allowOrigins: origins(),
    resolve: toLoopback,
    privateAllowlist: () => EMPTY,
  });

  it('fetch reaches the exact origin without reading the allowlist', async () => {
    const f = createGuardedFetch({
      allowOrigins: origins(),
      resolve: toLoopback,
      privateAllowlist: spy,
    } as never);
    expect((await f(`http://host.docker.internal:${port}/`)).status).toBe(200);
    expect((await f(`http://HOST.Docker.Internal:${port}/`)).status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(0);
  });

  it('fetch resolves the exact origin through the system resolver', async () => {
    const lookup = vi
      .spyOn(dns.promises, 'lookup')
      .mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never);
    try {
      const f = createGuardedFetch({ allowOrigins: origins(), privateAllowlist: spy } as never);
      const res = await f(`http://host.docker.internal:${port}/`);
      expect(res.status).toBe(200);
      expect(lookup).toHaveBeenCalledWith('host.docker.internal', { all: true });
      expect(spy).toHaveBeenCalledTimes(0);
    } finally {
      lookup.mockRestore();
    }
  });

  it('the same name on another port stays guarded', async () => {
    const hits = vi.fn();
    server.on('request', hits);
    await refusal(createGuardedFetch(base() as never)(`http://host.docker.internal:${port + 1}/`));
    expect(hits).not.toHaveBeenCalled();
  });

  it('the other scheme stays guarded', async () => {
    await refusal(createGuardedFetch(base() as never)(`https://host.docker.internal:${port}/`));
  });

  it.each([
    (p: number) => `http://host.docker.internal.evil.test:${p}/`,
    (p: number) => `http://xhost.docker.internal:${p}/`,
    (p: number) => `http://host.docker.internal.:${p}/`,
    (p: number) => `http://host.docker.internal:${p}@evil.test:${p}/`,
  ])('a look-alike stays guarded (%#)', async (build) => {
    await refusal(createGuardedFetch(base() as never)(build(port)));
  });

  it('a pg socket ignores origins', async () => {
    const socket = await createGuardedPgSocket({
      allowOrigins: origins(),
      resolve: toLoopback,
      privateAllowlist: spy,
    } as never)({ host: ['host.docker.internal'], port: [port] });
    const err = await new Promise<unknown>((resolve) => socket.once('error', resolve));
    expect(err).toBe(outage);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
