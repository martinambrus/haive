import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moduleManifestSchema } from '@haive/shared/modularity';
import * as fx from './support/module-executors-fixture.js';
import { createVendorStub, redirect } from './support/vendor-fetch-stub.js';

const shapeOf = (err: unknown) => ({
  isTypeError: err instanceof TypeError,
  message: (err as Error).message,
  cause: (err as { cause?: Error }).cause?.message,
});

describe('the fixture and the vendor stub of the module executor controls', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(302, { location: 'http://127.0.0.1:9/elsewhere' });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('[X0] rejects a 3xx with redirect error the way Node fetch does, measured against a loopback server (PIN)', async () => {
    const real = await fetch(base, { redirect: 'error' }).then(
      () => null,
      (err: unknown) => shapeOf(err),
    );
    const { stub } = createVendorStub();
    stub.respond = () => redirect(302, 'https://evil.example.test/landing');
    const emulated = await stub.fetch(`${fx.FX_BASE}/redirect`, { redirect: 'error' }).then(
      () => null,
      (err: unknown) => shapeOf(err),
    );

    expect(real, 'Node fetch no longer rejects a redirect the way the stub assumes').not.toBeNull();
    expect(emulated).toEqual(real);
  });

  it('[X0] returns a 3xx for redirect manual, and follows it, dropping Authorization across origins, otherwise (PIN)', async () => {
    const { stub } = createVendorStub();
    stub.respond = (call) =>
      call.url.startsWith(fx.FX_BASE)
        ? redirect(302, 'https://evil.example.test/landing')
        : new Response('{"landed":true}', { headers: { 'content-type': 'application/json' } });
    const headers = { authorization: 'Bearer secret' };

    const manual = await stub.fetch(`${fx.FX_BASE}/redirect`, { redirect: 'manual', headers });
    const followed = await stub.fetch(`${fx.FX_BASE}/redirect`, { headers });

    expect(manual.status).toBe(302);
    expect(followed.status).toBe(200);
    expect(stub.calls.map((call) => [call.url, call.hop, call.headers.authorization])).toEqual([
      [`${fx.FX_BASE}/redirect`, false, 'Bearer secret'],
      [`${fx.FX_BASE}/redirect`, false, 'Bearer secret'],
      ['https://evil.example.test/landing', true, undefined],
    ]);
  });

  it('[X0] finds a token in every kind of place an executor could hide one, and nothing in a clean value (PIN)', () => {
    const token = 'stubtok-planted-1234';
    class Holder {
      get later() {
        return token;
      }
    }
    const sym = Symbol(`kept ${token}`);
    const places: Array<[string, unknown]> = [
      ['a nested property', { a: { b: [{ c: `Bearer ${token}` }] } }],
      ['a map value', new Map([['k', { token }]])],
      ['a set member', new Set([token])],
      ['a buffer', { raw: Buffer.from(token) }],
      ['a typed array of UTF-16', { raw: new Uint16Array(Buffer.from(token, 'utf16le').buffer) }],
      [
        'an accessor',
        {
          get lazy() {
            return token;
          },
        },
      ],
      ['a class getter', new Holder()],
      ['a non-enumerable property', Object.defineProperty({}, 'hidden', { value: token })],
      ['a symbol description', { [sym]: 1 }],
      ['a property name', { [token]: true }],
      ['a function property', Object.assign(() => 1, { note: token })],
      [
        'an abort reason',
        (() => {
          const c = new AbortController();
          c.abort(token);
          return c.signal;
        })(),
      ],
      ['headers', new Headers({ authorization: token })],
    ];

    for (const [name, place] of places) {
      expect(fx.findInValue(place, [token]), name).not.toEqual([]);
    }
    const cyclic: Record<string, unknown> = { fine: 'nothing here' };
    cyclic.self = cyclic;
    expect(fx.findInValue(cyclic, [token])).toEqual([]);
    expect(fx.findInValue({ n: 1, s: 'plain', f: () => 2 }, [token])).toEqual([]);
  });

  it('[X0] makes results of the exact JSON size asked for (PIN)', () => {
    for (const bytes of [10, 65_536, 65_537, 200_000]) {
      expect(Buffer.byteLength(JSON.stringify(fx.sizedResult(bytes)))).toBe(bytes);
    }
    expect(Buffer.byteLength(JSON.stringify(fx.sizedResult(300_010, true)))).toBe(300_010);
  });

  it('[X0] gives a manifest the schema accepts, and an executor for each operation it declares (PIN)', () => {
    const parsed = moduleManifestSchema.safeParse(fx.fxManifest());

    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    const declared = fx.FX_OPERATIONS.map((op) => op.opId).sort();
    expect(Object.keys(fx.fxExecutors()[fx.FX_PROVIDER]!).sort()).toEqual(declared);
    expect(declared).toEqual(fx.ALL_OPS);
  });
});
