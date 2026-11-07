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

  it('pg socket rejects with the outage error', async () => {
    await expect(createGuardedPgSocket(seams())({ host: ['other'], port: [port] })).rejects.toBe(
      outage,
    );
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
