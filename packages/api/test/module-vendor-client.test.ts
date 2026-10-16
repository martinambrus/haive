import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VendorError, createVendorClient, redactSecrets } from '../src/lib/module-vendor-client.js';

const TOKEN = 'tok-0123456789abcdef';
const ODD_TOKEN = 'ab+cd/ef==';
const HOST = 'docs.example.test';
const urlOf = (path = '/v1/docs') => `https://${HOST}${path}`;

type Body = ConstructorParameters<typeof Response>[0];
type Access = 'read' | 'write';

const reply = (status: number, body: Body, contentType = 'application/json') =>
  new Response(body, { status, headers: { 'content-type': contentType } });

const lowerEscapes = (text: string) =>
  text.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());

// How a vendor's encoder may write a token that holds + / =.
const spellingsOf = (token: string): Array<[string, string]> => [
  ['as it is', token],
  ['PHP-escaped', token.replaceAll('/', '\\/')],
  ['.NET-escaped', token.replaceAll('+', '\\u002B')],
  ['upper-case percent-encoded', encodeURIComponent(token)],
  ['lower-case percent-encoded', lowerEscapes(encodeURIComponent(token))],
];

function clientFor(answer: Response | Error, apiHosts: string[] = [HOST], access: Access = 'read') {
  const sent = vi.fn(async (_target: URL, _init: RequestInit) => {
    if (answer instanceof Error) throw answer;
    return answer;
  });
  vi.stubGlobal('fetch', sent);
  return {
    sent,
    vendor: createVendorClient({
      token: TOKEN,
      apiHosts,
      access,
      signal: new AbortController().signal,
    }),
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

  it.each([8443, 444, 80, 65535])(
    'refuses port %i of a declared host as vendor-host-refused, and sends nothing',
    async (port) => {
      const { sent, vendor } = clientFor(reply(200, '{}'));

      const error = await failure(
        vendor.request({ method: 'GET', url: `https://${HOST}:${port}/v1/docs` }),
      );

      expect(error.reason).toBe('vendor-host-refused');
      expect(sent).not.toHaveBeenCalled();
    },
  );

  it('serves port 443 written out, which is the https default', async () => {
    const { sent, vendor } = clientFor(reply(200, '{}'));

    await vendor.request({ method: 'GET', url: `https://${HOST}:443/v1/docs` });

    expect(String(sent.mock.calls[0]![0])).toBe(`https://${HOST}/v1/docs`);
  });

  it.each(['host', 'Host', 'HOST'])(
    'never passes a caller %s header on, and sends the other headers',
    async (name) => {
      const { sent, vendor } = clientFor(reply(200, '{}'));

      await vendor.request({
        method: 'GET',
        url: urlOf(),
        headers: { [name]: 'evil.example.test', accept: 'application/json' },
      });

      const headers = sent.mock.calls[0]![1].headers as Headers;
      expect([...headers.keys()].sort()).toEqual(['accept', 'authorization']);
      expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    },
  );

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'post', 'Delete'])(
    'refuses %s of a read operation as vendor-method-refused, and sends nothing',
    async (method) => {
      const { sent, vendor } = clientFor(reply(200, '{}'), [HOST], 'read');

      const error = await failure(vendor.request({ method, url: urlOf(), json: { a: 1 } }));

      expect(error.reason).toBe('vendor-method-refused');
      expect(sent).not.toHaveBeenCalled();
    },
  );

  it.each(['GET', 'HEAD', 'get', 'head'])('sends %s of a read operation', async (method) => {
    const { sent, vendor } = clientFor(reply(200, '{}'), [HOST], 'read');

    await vendor.request({ method, url: urlOf() });

    expect(sent).toHaveBeenCalledTimes(1);
  });

  it.each(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])(
    'sends %s of a write operation',
    async (method) => {
      const { sent, vendor } = clientFor(reply(200, '{}'), [HOST], 'write');

      await vendor.request({ method, url: urlOf() });

      expect(sent).toHaveBeenCalledTimes(1);
    },
  );

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
      access: 'read',
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
      access: 'read',
      signal: new AbortController().signal,
    });

    const error = await failure(vendor.request({ method: 'GET', url: urlOf() }));

    expect(error.message).toBe('the vendor answered 500: [redacted] [redacted] [redacted]');
  });

  it.each(spellingsOf(ODD_TOKEN))(
    'removes the token from an error body that echoes it %s',
    async (_name, echo) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => reply(400, `{"error":"bad credential ${echo}"}`)),
      );
      const vendor = createVendorClient({
        token: ODD_TOKEN,
        apiHosts: [HOST],
        access: 'read',
        signal: new AbortController().signal,
      });

      const error = await failure(vendor.request({ method: 'GET', url: urlOf() }));

      expect(error.message).toBe('the vendor answered 400: {"error":"bad credential [redacted]"}');
    },
  );

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
      access: 'read',
      signal: new AbortController().signal,
    });

    const redirected = await failure(vendor.request({ method: 'GET', url: urlOf() }));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    const refused = await failure(vendor.request({ method: 'GET', url: urlOf() }));

    expect(redirected.reason).toBe('vendor-redirect-refused');
    expect(refused.reason).toBe('vendor-error');
  });
});

describe('redactSecrets', () => {
  it.each(spellingsOf(ODD_TOKEN))(
    'removes a token written %s, in the text and inside a JSON string of it',
    (_name, echo) => {
      const text = `note ${echo} end`;

      expect(redactSecrets(text, [ODD_TOKEN])).toBe('note [redacted] end');
      expect(redactSecrets(JSON.stringify({ body: text }), [ODD_TOKEN])).toBe(
        JSON.stringify({ body: 'note [redacted] end' }),
      );
    },
  );

  it('reads each character of the token its own way, a percent escape of either case among them', () => {
    expect(redactSecrets('ab\\u002bcd\\/ef%3D%3d', [ODD_TOKEN])).toBe('[redacted]');
    expect(redactSecrets('ab%2Bcd/ef\\u003d=', [ODD_TOKEN])).toBe('[redacted]');
  });

  it('removes a token with a quote, a backslash and non-ASCII characters in every way it can be written', () => {
    const odd = `a"b\\c\u00e9\u20ac${String.fromCodePoint(0x1f600)} z`;
    const written = [
      odd,
      JSON.stringify(odd).slice(1, -1),
      encodeURIComponent(odd),
      lowerEscapes(encodeURIComponent(odd)),
    ];

    expect(redactSecrets(written.join(' | '), [odd])).toBe(
      '[redacted] | [redacted] | [redacted] | [redacted]',
    );
  });

  it('leaves every other escape, in text or in JSON, and a near miss as they are', () => {
    const text = '{"a":"\\u0041 %41 \\/ \\n","b":"ab+cd/ef=","c":"ab+cd/e"}';

    expect(redactSecrets(text, [ODD_TOKEN])).toBe(text);
  });

  it('removes the longer secret whole when a shorter one starts it, and every secret there is', () => {
    expect(redactSecrets('1 abcdef 2 abc 3 xyz', ['abc', 'xyz', 'abcdef'])).toBe(
      '1 [redacted] 2 [redacted] 3 [redacted]',
    );
  });

  it('has nothing to remove for no secret or an empty one', () => {
    expect(redactSecrets('plain text', [])).toBe('plain text');
    expect(redactSecrets('plain text', [''])).toBe('plain text');
  });

  it.each([
    ['a start of the token', 'ab+c'],
    ['a start of the token that ends in a slash', 'ab+cd/'],
    ['a start of the lower-case percent-encoded form', 'ab%2bcd%2fef%3'],
    ['half a percent escape', 'ab%2bcd%'],
    ['half an escape of the .NET form', 'ab\\u002Bcd/ef\\u00'],
    ['a start of the PHP form with its backslash', 'ab+cd\\'],
    ['half an escape of the last character', 'ab+cd/ef=%3'],
  ])('removes %s that a cut left at the end', (_name, tail) => {
    expect(redactSecrets(`read ${tail}`, [ODD_TOKEN], true)).toBe('read [redacted]');
  });

  it('removes the start of a token of 3600 characters that a cut left at the end, however long it is', () => {
    const token = 'ab+/'.repeat(900);

    expect(redactSecrets(`read ${token.slice(0, 3500)}`, [token], true)).toBe('read [redacted]');
  });

  it('reads the %2 of a cut as half of the escape of a percent sign in the token, not as a percent sign', () => {
    expect(redactSecrets('read ab%2', ['ab%cd'], true)).toBe('read [redacted]');
    expect(redactSecrets('read ab%25c', ['ab%cd'], true)).toBe('read [redacted]');
  });

  it.each([
    ['half a percent escape', '+ab/cd', 'read %2'],
    ['half a \\u escape', '+ab/cd', 'read \\u00'],
    ['the backslash of an escaped slash', '/ab+cd', 'read \\'],
  ])("removes %s of the token's first character that a cut left at the end", (_n, token, text) => {
    expect(redactSecrets(text, [token], true)).toBe('read [redacted]');
  });

  it("keeps an end that is no spelling of the token's first character", () => {
    expect(redactSecrets('read %3', ['+ab/cd'], true)).toBe('read %3');
  });

  it('keeps the end of a text that only looks like the start of a token, and every end when no cut was made', () => {
    expect(redactSecrets('read ab+x', [ODD_TOKEN], true)).toBe('read ab+x');
    expect(redactSecrets('read ab+c', [ODD_TOKEN])).toBe('read ab+c');
  });
});
