import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
