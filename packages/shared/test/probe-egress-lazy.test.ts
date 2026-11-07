import dns from 'node:dns';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ConfigUnavailableError } from '../src/config/index.js';
import { EMPTY, parseAllowlist, type ParsedAllowlist } from '../src/egress/allowlist.js';
import { createGuardedFetch, createGuardedPgSocket } from '../src/egress/probe-egress.js';

const outage = new ConfigUnavailableError('get');
const toLoopback = async () => [{ address: '127.0.0.1', family: 4 as const }];
const isLoopback = (a: string) => a === '127.0.0.1';
const notFoundError = () => Object.assign(new Error('queryA ENOTFOUND'), { code: 'ENOTFOUND' });

let spy: Mock<() => ParsedAllowlist>;
let server: http.Server;
let hits: number;
let port: number;

beforeEach(async () => {
  hits = 0;
  spy = vi.fn((): ParsedAllowlist => {
    throw outage;
  });
  server = http.createServer((_req, res) => {
    hits += 1;
    res.end('ok');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const url = (host: string) => `http://${host}:${port}/`;

async function failure(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

async function listening(): Promise<{
  tcp: net.Server;
  tcpPort: number;
  connections: () => number;
}> {
  let n = 0;
  const tcp = net.createServer((s) => {
    n += 1;
    s.destroy();
  });
  await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', r));
  return { tcp, tcpPort: (tcp.address() as AddressInfo).port, connections: () => n };
}

async function connects(socket: net.Socket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.destroy();
}

describe('the allowlist is read only when it can change the answer', () => {
  it('A: a name answering a public address never reads the list', async () => {
    const f = createGuardedFetch({
      resolve: toLoopback,
      isBlocked: () => false,
      privateAllowlist: spy,
    });
    const res = await f(url('public.test'));
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(0);
  });

  it('B: a public IP literal never reads the list', async () => {
    const f = createGuardedFetch({ isBlocked: () => false, privateAllowlist: spy });
    const res = await f(url('127.0.0.1'));
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(0);
  });

  it('C: a pg socket to a public name and to a public literal never reads the list', async () => {
    const { tcp, tcpPort } = await listening();
    const seams = { resolve: toLoopback, isBlocked: () => false, privateAllowlist: spy };
    await connects(await createGuardedPgSocket(seams)({ host: ['public.test'], port: [tcpPort] }));
    await connects(await createGuardedPgSocket(seams)({ host: ['127.0.0.1'], port: [tcpPort] }));
    await new Promise((r) => tcp.close(r));
    expect(spy).toHaveBeenCalledTimes(0);
  });

  it('D: a blocked answer and a blocked literal each read the list exactly once', async () => {
    const answers = vi.fn(async () => [
      { address: '127.0.0.1', family: 4 as const },
      { address: '127.0.0.2', family: 4 as const },
    ]);
    const counted = vi.fn((): ParsedAllowlist => EMPTY);
    const blocked = (a: string) => a.startsWith('127.');
    await failure(
      createGuardedFetch({ resolve: answers, isBlocked: blocked, privateAllowlist: counted })(
        url('two.test'),
      ),
    );
    expect(counted).toHaveBeenCalledTimes(1);
    const literal = vi.fn((): ParsedAllowlist => EMPTY);
    await failure(
      createGuardedFetch({ isBlocked: blocked, privateAllowlist: literal })(url('127.0.0.1')),
    );
    expect(literal).toHaveBeenCalledTimes(1);
  });

  it('E: an outage raised for a blocked answer reaches the caller as that very error', async () => {
    const { tcp, tcpPort, connections } = await listening();
    const seams = { resolve: toLoopback, isBlocked: isLoopback, privateAllowlist: spy };
    expect(await failure(createGuardedFetch(seams)(url('blocked.test')))).toBe(outage);
    expect(hits).toBe(0);
    const socket = await createGuardedPgSocket(seams)({ host: ['blocked.test'], port: [tcpPort] });
    const err = await new Promise<unknown>((resolve) => socket.once('error', resolve));
    expect(err).toBe(outage);
    await expect(
      createGuardedPgSocket(seams)({ host: ['127.0.0.1'], port: [tcpPort] }),
    ).rejects.toBe(outage);
    expect(connections()).toBe(0);
    await new Promise((r) => tcp.close(r));
  });

  describe('F: a hostname entry falls back to the system lookup only when resolution fails', () => {
    const resolve = async () => {
      throw notFoundError();
    };
    const listed = () => parseAllowlist('hosts-only.test');

    it('reaches a hosts-file name once, reading the list once', async () => {
      const lookup = vi
        .spyOn(dns.promises, 'lookup')
        .mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never);
      try {
        const counted = vi.fn(listed);
        const f = createGuardedFetch({ resolve, isBlocked: isLoopback, privateAllowlist: counted });
        const res = await f(url('hosts-only.test'));
        expect(res.status).toBe(200);
        expect(lookup).toHaveBeenCalledWith('hosts-only.test', { all: true });
        expect(counted).toHaveBeenCalledTimes(1);
      } finally {
        lookup.mockRestore();
      }
    });

    it('refuses as ENOTFOUND, with no system lookup, when the list is empty', async () => {
      const lookup = vi.spyOn(dns.promises, 'lookup');
      try {
        const f = createGuardedFetch({
          resolve,
          isBlocked: isLoopback,
          privateAllowlist: () => EMPTY,
        });
        const err = await failure(f(url('hosts-only.test')));
        expect(err.cause.code).toBe('ENOTFOUND');
        expect(lookup).not.toHaveBeenCalled();
      } finally {
        lookup.mockRestore();
      }
    });

    it('rejects with the outage when the list is unreadable', async () => {
      const f = createGuardedFetch({ resolve, isBlocked: isLoopback, privateAllowlist: spy });
      expect(await failure(f(url('hosts-only.test')))).toBe(outage);
    });
  });
});
