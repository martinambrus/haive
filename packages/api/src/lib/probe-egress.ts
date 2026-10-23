import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';
import {
  dnsResolver,
  EgressGuardError,
  guardedLookup,
  isBlockedAddress,
  type Classifier,
  type Resolver,
} from './egress-guard.js';

const LOOKUP_TIMEOUT_MS = 10_000;
const NO_BODY_STATUS = new Set([204, 205, 304]);

export interface ProbeSeams {
  resolve?: Resolver;
  isBlocked?: Classifier;
}

function notFound(host: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), {
    code: 'ENOTFOUND',
    syscall: 'getaddrinfo',
    hostname: host,
  });
}

function probeLookup(host: string, seams: ProbeSeams): net.LookupFunction {
  const resolve = seams.resolve ?? dnsResolver()(LOOKUP_TIMEOUT_MS).resolve;
  const inner = guardedLookup(resolve, seams.isBlocked ?? ((a) => isBlockedAddress(a)));
  return (hostname, options, callback) => {
    inner(hostname, options, (err, address, family) => {
      if (
        err instanceof EgressGuardError ||
        (err as NodeJS.ErrnoException | null)?.code === 'ENOTFOUND'
      ) {
        callback(notFound(host), '', 4);
      } else callback(err, address as never, family as never);
    });
  };
}

function stripBrackets(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '');
}

export function createGuardedFetch(seams: ProbeSeams = {}) {
  return (input: string | URL, init: RequestInit = {}): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      const fail = (cause: unknown) => reject(new TypeError('fetch failed', { cause }));
      const signal = init.signal ?? undefined;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      let url: URL;
      try {
        url = new URL(input);
      } catch (err) {
        fail(err);
        return;
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        fail(new Error(`unsupported protocol ${url.protocol}`));
        return;
      }
      const host = stripBrackets(url.hostname);
      const isBlocked = seams.isBlocked ?? ((a: string) => isBlockedAddress(a));
      if (net.isIP(host) !== 0 && isBlocked(host)) {
        fail(notFound(host));
        return;
      }
      const secure = url.protocol === 'https:';
      const agent = secure ? new https.Agent() : new http.Agent();
      const headers: Record<string, string> = { 'accept-encoding': 'identity' };
      new Headers(init.headers).forEach((value, key) => {
        headers[key] = value;
      });
      const body = typeof init.body === 'string' ? init.body : undefined;
      if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));

      let done = false;
      const onAbort = () => {
        request.destroy();
        agent.destroy();
        if (!done) {
          done = true;
          reject(signal?.reason);
        }
      };
      const cleanup = () => signal?.removeEventListener('abort', onAbort);

      const request = (secure ? https : http).request(
        {
          method: init.method ?? 'GET',
          hostname: host,
          port: url.port === '' ? (secure ? 443 : 80) : Number(url.port),
          path: url.pathname + url.search,
          headers,
          agent,
          lookup: probeLookup(host, seams),
        },
        (res) => {
          done = true;
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) for (const v of value) responseHeaders.append(key, v);
            else if (value !== undefined) responseHeaders.append(key, value);
          }
          const status = res.statusCode ?? 0;
          const noBody = NO_BODY_STATUS.has(status);
          if (noBody) res.resume();
          res.on('close', () => {
            cleanup();
            agent.destroy();
          });
          resolve(
            new Response(noBody ? null : (Readable.toWeb(res) as ReadableStream), {
              status,
              statusText: res.statusMessage ?? '',
              headers: responseHeaders,
            }),
          );
        },
      );
      request.on('error', (err) => {
        cleanup();
        agent.destroy();
        if (!done) {
          done = true;
          fail(err);
        }
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      request.end(body);
    });
}

export const guardedFetch = createGuardedFetch();

type PgSocketOptions = { host: string[]; port: number[]; path?: string | undefined };

function refusedSocket(host: string): net.Socket {
  const socket = new net.Socket();
  setImmediate(() => socket.destroy(notFound(host)));
  return socket;
}

export function createGuardedPgSocket(seams: ProbeSeams = {}) {
  return (options: PgSocketOptions): net.Socket => {
    const host = options.host?.[0] ?? '';
    const isBlocked = seams.isBlocked ?? ((a: string) => isBlockedAddress(a));
    if (
      options.path ||
      options.host?.length !== 1 ||
      host.includes('/') ||
      (net.isIP(host) !== 0 && isBlocked(host))
    ) {
      return refusedSocket(host);
    }
    const socket = net.connect({
      host,
      port: options.port[0]!,
      lookup: probeLookup(host, seams),
    });
    (socket as net.Socket & { host?: string }).host = host;
    return socket;
  };
}

export const guardedPgSocket = createGuardedPgSocket();

export function egressFor(role: string | undefined): {
  fetchFn: typeof fetch;
  pgSocket: ((options: PgSocketOptions) => net.Socket) | undefined;
} {
  if (role === 'admin') return { fetchFn: fetch, pgSocket: undefined };
  return { fetchFn: guardedFetch as typeof fetch, pgSocket: guardedPgSocket };
}
