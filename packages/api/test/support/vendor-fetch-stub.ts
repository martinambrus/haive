import { FX_HOST } from './module-executors-fixture.js';

export interface VendorCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  redirect: string | undefined;
  hasSignal: boolean;
  at: number;
  abortedAt: number | null;
  hop: boolean;
}
export type Reply = (call: VendorCall, init: RequestInit) => Response | Promise<Response>;

export const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
export const text = (status: number, body: string, contentType = 'text/plain'): Response =>
  new Response(body, { status, headers: { 'content-type': contentType } });
export const redirect = (status: number, location: string): Response =>
  new Response(null, { status, headers: { location } });

const idOf = (segment: string | undefined): string => decodeURIComponent(segment ?? '');

/** The document service behind docs.example.test; any other host answers 200 with the host it reached. */
export const defaultReply: Reply = (call) => {
  const url = new URL(call.url);
  if (url.hostname !== FX_HOST) return json(200, { landed: url.hostname, path: url.pathname });
  const doc = /^\/v1\/docs\/([^/]+)$/.exec(url.pathname);
  if (call.method === 'GET' && doc) {
    return json(200, { id: idOf(doc[1]), title: `Doc ${idOf(doc[1])}` });
  }
  const append = /^\/v1\/docs\/([^/]+)\/append$/.exec(url.pathname);
  if (call.method === 'POST' && append) {
    const sent = JSON.parse(call.body ?? '{}') as { text?: unknown };
    return json(200, {
      id: idOf(append[1]),
      appended: true,
      length: String(sent.text ?? '').length,
    });
  }
  const moved = /^\/moved\/(\d{3})$/.exec(url.pathname);
  if (moved) return redirect(Number(moved[1]), 'https://evil.example.test/landing');
  if (url.pathname === '/redirect') return redirect(302, 'https://evil.example.test/landing');
  if (url.pathname === '/old') return redirect(301, '/v1/docs/new');
  if (url.pathname === '/v1/json') return json(200, { a: 1 });
  if (url.pathname === '/v1/json-utf8') {
    return text(200, '{"a":2}', 'application/json; charset=utf-8');
  }
  if (url.pathname === '/v1/text') return text(200, 'hello');
  return json(200, { unexpected: call.url });
};

/** A fetch that records every request. A 3xx answer is what Node's fetch makes of it: with redirect 'error' it
 *  rejects with the TypeError the platform gives (measured: message 'fetch failed', cause 'unexpected redirect'),
 *  with 'manual' it is returned, otherwise it is followed, a hop recorded, Authorization dropped across origins. */
export function createVendorStub() {
  const stub = {
    calls: [] as VendorCall[],
    respond: defaultReply as Reply,
    pending: [] as Array<() => void>,
    fetch: undefined as unknown as typeof fetch,
    reset(): void {
      stub.calls = [];
      stub.respond = defaultReply;
      stub.pending = [];
    },
    release(): number {
      const released = stub.pending.splice(0);
      for (const release of released) release();
      return released.length;
    },
  };

  async function send(call: VendorCall, init: RequestInit, hops: number): Promise<Response> {
    stub.calls.push(call);
    init.signal?.addEventListener(
      'abort',
      () => {
        call.abortedAt = Date.now();
      },
      { once: true },
    );
    const response = await stub.respond(call, init);
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || location === null) return response;
    if (call.redirect === 'error') {
      throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
    }
    if (call.redirect === 'manual') return response;
    if (hops >= 20)
      throw new TypeError('fetch failed', { cause: new Error('redirect count exceeded') });
    const next = new URL(location, call.url);
    const headers = { ...call.headers };
    if (next.origin !== new URL(call.url).origin) {
      delete headers.authorization;
      delete headers.cookie;
      delete headers['proxy-authorization'];
    }
    const toGet = response.status === 303 || (response.status !== 307 && response.status !== 308);
    return send(
      {
        ...call,
        url: next.href,
        method: toGet && call.method !== 'HEAD' ? 'GET' : call.method,
        headers,
        body: toGet ? null : call.body,
        at: Date.now(),
        abortedAt: null,
        hop: true,
      },
      init,
      hops + 1,
    );
  }

  stub.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const asked = input instanceof Request ? input : null;
    const headers = new Headers(asked?.headers);
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    let body: string | null = null;
    if (typeof init.body === 'string') body = init.body;
    else if (init.body instanceof URLSearchParams) body = init.body.toString();
    else if (init.body instanceof Uint8Array) body = Buffer.from(init.body).toString();
    else if (asked !== null) body = (await asked.clone().text()) || null;
    const call: VendorCall = {
      url: asked?.url ?? String(input),
      method: (init.method ?? asked?.method ?? 'GET').toUpperCase(),
      headers: Object.fromEntries(headers.entries()),
      body,
      redirect: init.redirect ?? asked?.redirect,
      hasSignal: init.signal instanceof AbortSignal,
      at: Date.now(),
      abortedAt: null,
      hop: false,
    };
    return send(call, init, 0);
  }) as typeof fetch;

  function hang(init: RequestInit): Promise<Response> {
    return new Promise((_resolve, reject) => {
      stub.pending.push(() => reject(new Error('the stub released a hanging request')));
      const signal = init.signal;
      if (!signal) return;
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }

  function stallBody(init: RequestInit): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"id":"d1",'));
        stub.pending.push(() => controller.error(new Error('the stub released a stalled body')));
        const signal = init.signal;
        if (!signal) return;
        if (signal.aborted) controller.error(signal.reason);
        else
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  }

  return { stub, hang, stallBody };
}

export const networkFailure = () =>
  new TypeError('fetch failed', {
    cause: Object.assign(new Error('connect ECONNREFUSED 203.0.113.9:443'), {
      code: 'ECONNREFUSED',
    }),
  });

export const reflecting =
  (status: number): Reply =>
  (call) =>
    json(
      status,
      { message: 'Bad credentials', received: call.headers.authorization },
      status === 401
        ? {
            'www-authenticate': `Bearer error="invalid_token", error_description="${call.headers.authorization}"`,
          }
        : {},
    );
