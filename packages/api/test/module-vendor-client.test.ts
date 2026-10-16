import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VendorError, createVendorClient, tokenForms } from '../src/lib/module-vendor-client.js';

const TOKEN = 'tok-0123456789abcdef';
const HOST = 'docs.example.test';
const urlOf = (path = '/v1/docs') => `https://${HOST}${path}`;

type Body = ConstructorParameters<typeof Response>[0];

const reply = (status: number, body: Body, contentType = 'application/json') =>
  new Response(body, { status, headers: { 'content-type': contentType } });

function clientFor(answer: Response | Error, apiHosts: string[] = [HOST]) {
  const sent = vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  });
  vi.stubGlobal('fetch', sent);
  return {
    sent,
    vendor: createVendorClient({ token: TOKEN, apiHosts, signal: new AbortController().signal }),
  };
}

const failure = async (call: Promise<unknown>): Promise<VendorError> => {
  const error = await call.then(
    () => null,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(VendorError);
  return error as VendorError;
};

describe('the vendor client of the module executors', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('refuses every host, and sends nothing, while the provider declares none', async () => {
    const { sent, vendor } = clientFor(reply(200, '{}'), []);

    const error = await failure(vendor.request({ method: 'GET', url: urlOf() }));

    expect(error.reason).toBe('vendor-host-refused');
    expect(sent).not.toHaveBeenCalled();
  });

  it.each([
    ['application/json', '{"a":1}', { a: 1 }],
    ['application/problem+json; charset=utf-8', '{"a":2}', { a: 2 }],
    ['application/json', '', ''],
    ['text/plain', '{"a":3}', '{"a":3}'],
    ['application/jsonl', '{"a":4}', '{"a":4}'],
  ])('answers a %s body as %j', async (type, text, body) => {
    const { vendor } = clientFor(reply(200, text, type));

    await expect(vendor.request({ method: 'GET', url: urlOf() })).resolves.toEqual({
      status: 200,
      body,
    });
  });

  it('fails a JSON content type whose body is not JSON as a vendor error', async () => {
    const { vendor } = clientFor(reply(200, '<html>', 'application/json'));

    const error = await failure(vendor.request({ method: 'GET', url: urlOf() }));

    expect(error.reason).toBe('vendor-error');
  });

  it('refuses a 3xx answer that fetch hands back, one with no Location, as a refused redirect', async () => {
    const { vendor } = clientFor(reply(304, null));

    const error = await failure(vendor.request({ method: 'GET', url: urlOf() }));

    expect(error.reason).toBe('vendor-redirect-refused');
  });

  it('keeps the token out of the error of a header the platform refuses, a newline inside it among them', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const vendor = createVendorClient({
      token: 'tok-0123456789\nabcdef',
      apiHosts: [HOST],
      signal: new AbortController().signal,
    });

    const error = await failure(vendor.request({ method: 'GET', url: urlOf() }));

    expect(error.message).not.toContain('tok-0123456789');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reads at most 4096 bytes of an error body and removes the start of the token a cut left at its end', async () => {
    const body = `${'y'.repeat(4096 - 8)}${TOKEN}${'z'.repeat(100)}`;
    const { vendor } = clientFor(reply(401, body, 'text/plain'));

    const error = await failure(vendor.request({ method: 'GET', url: urlOf() }));

    expect(error.reason).toBe('vendor-auth');
    expect(error.message).not.toContain(TOKEN.slice(0, 5));
    expect(error.message.endsWith('[redacted]')).toBe(true);
    expect(error.message.length).toBeLessThan(4096 + 100);
  });

  it('removes the token from an error body whole, as it is, JSON-escaped and URL-encoded', async () => {
    const odd = 'a"b/c d';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        reply(
          500,
          `${odd} ${JSON.stringify(odd).slice(1, -1)} ${encodeURIComponent(odd)}`,
          'text/plain',
        ),
      ),
    );
    const vendor = createVendorClient({
      token: odd,
      apiHosts: [HOST],
      signal: new AbortController().signal,
    });

    const error = await failure(vendor.request({ method: 'GET', url: urlOf() }));

    expect(error.message).toBe('the vendor answered 500: [redacted] [redacted] [redacted]');
  });

  it('fails an answer larger than 8 MiB without reading all of it', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x61);
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
        if (pulled >= 100) controller.close();
      },
    });
    const { vendor } = clientFor(reply(200, stream, 'text/plain'));

    const error = await failure(vendor.request({ method: 'GET', url: urlOf() }));

    expect(error.reason).toBe('vendor-error');
    expect(pulled).toBeLessThan(20);
  });

  it('tells what Node fetch really does with a redirect from a refused connection', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(302, { location: 'http://127.0.0.1:9/elsewhere' });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const realFetch = fetch;
    vi.stubGlobal('fetch', (_target: URL, init: RequestInit) =>
      realFetch(`http://127.0.0.1:${port}/`, init),
    );
    const vendor = createVendorClient({
      token: TOKEN,
      apiHosts: [HOST],
      signal: new AbortController().signal,
    });

    const redirected = await failure(vendor.request({ method: 'GET', url: urlOf() }));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    const refused = await failure(vendor.request({ method: 'GET', url: urlOf() }));

    expect(redirected.reason).toBe('vendor-redirect-refused');
    expect(refused.reason).toBe('vendor-error');
  });

  it('lists the forms of a token a vendor may echo, longest first, each once', () => {
    expect(tokenForms('abc')).toEqual(['abc']);
    expect(tokenForms('a b"c')).toEqual(['a%20b%22c', 'a b\\"c', 'a b"c']);
    expect(tokenForms('')).toEqual([]);
  });
});
