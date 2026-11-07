import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/logger/index.js', () => ({ logger: { child: () => h.log } }));

import { createGuardedFetch } from '../src/egress/probe-egress.js';
import { parseAllowlist } from '../src/egress/allowlist.js';

const privateAllowlist = () => parseAllowlist('');
const toPrivate = async () => [{ address: '10.0.0.5', family: 4 as const }];

beforeEach(() => vi.clearAllMocks());

describe('refused dial log', () => {
  it('logs one warn with only the typed host for a blocked literal', async () => {
    const f = createGuardedFetch({ privateAllowlist });
    await expect(
      f('http://127.0.0.1:9/secret/path?token=abc', {
        headers: { authorization: 'Bearer hunter2' },
      }),
    ).rejects.toThrow('fetch failed');
    expect(h.log.warn).toHaveBeenCalledTimes(1);
    const [first] = h.log.warn.mock.calls[0]!;
    expect(first.host).toBe('127.0.0.1');
    expect(JSON.stringify(first)).not.toMatch(/secret|token|abc|hunter2|authorization/);
  });

  it('logs one warn with the typed name for a name that resolves privately', async () => {
    const f = createGuardedFetch({ privateAllowlist, resolve: toPrivate });
    await expect(f('http://internal.test:9/secret/path?token=abc')).rejects.toThrow('fetch failed');
    expect(h.log.warn).toHaveBeenCalledTimes(1);
    const [first] = h.log.warn.mock.calls[0]!;
    expect(first.host).toBe('internal.test');
    expect(JSON.stringify(first)).not.toMatch(/secret|token|abc/);
  });

  it('logs no refusal for a permitted dial', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const f = createGuardedFetch({
      privateAllowlist: () => parseAllowlist('internal.test'),
      resolve: async () => [{ address: '127.0.0.1', family: 4 as const }],
    });
    const res = await f(`http://internal.test:${port}/`);
    expect(res.status).toBe(200);
    expect(h.log.warn).not.toHaveBeenCalled();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
});

describe('refusal warn throttle', () => {
  const T0 = Date.parse('2030-01-01T00:00:00Z');
  const refuse = (f: ReturnType<typeof createGuardedFetch>, url: string) =>
    expect(f(url)).rejects.toThrow('fetch failed');

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('warns once per host per 60 seconds', async () => {
    vi.setSystemTime(T0);
    const f = createGuardedFetch({ privateAllowlist });
    for (let i = 0; i < 3; i++) await refuse(f, 'http://127.0.0.1:9/');
    expect(h.log.warn).toHaveBeenCalledTimes(1);
    vi.setSystemTime(T0 + 61_000);
    await refuse(f, 'http://127.0.0.1:9/');
    expect(h.log.warn).toHaveBeenCalledTimes(2);
    vi.setSystemTime(T0 + 91_000);
    await refuse(f, 'http://127.0.0.1:9/');
    expect(h.log.warn).toHaveBeenCalledTimes(2);
  });

  it('warns once for each of two different hosts in one window', async () => {
    vi.setSystemTime(T0 + 10_000_000);
    const f = createGuardedFetch({ privateAllowlist });
    await refuse(f, 'http://127.0.0.2:9/');
    await refuse(f, 'http://127.0.0.3:9/');
    expect(h.log.warn).toHaveBeenCalledTimes(2);
  });

  it('keeps its memory bounded by evicting the oldest host', async () => {
    vi.setSystemTime(T0 + 20_000_000);
    const f = createGuardedFetch({ privateAllowlist, resolve: toPrivate });
    for (let i = 0; i < 300; i++) await refuse(f, `http://n${i}.test:9/`);
    expect(h.log.warn).toHaveBeenCalledTimes(300);
    await refuse(f, 'http://n0.test:9/');
    expect(h.log.warn).toHaveBeenCalledTimes(301);
    await refuse(f, 'http://n299.test:9/');
    expect(h.log.warn).toHaveBeenCalledTimes(301);
  });

  it('warns again when the clock moved backwards', async () => {
    vi.setSystemTime(T0 + 30_000_000);
    const f = createGuardedFetch({ privateAllowlist });
    await refuse(f, 'http://127.0.0.4:9/');
    vi.setSystemTime(T0 + 30_000_000 - 600_000);
    await refuse(f, 'http://127.0.0.4:9/');
    expect(h.log.warn).toHaveBeenCalledTimes(2);
  });
});
