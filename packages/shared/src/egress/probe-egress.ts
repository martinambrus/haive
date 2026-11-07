import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { pipeline, Readable } from 'node:stream';
import zlib from 'node:zlib';
import { rethrowIfConfigUnavailable } from '../config/index.js';
import { logger } from '../logger/index.js';
import { EMPTY, loadAllowlist, type ParsedAllowlist } from './allowlist.js';
import {
  dnsResolver,
  EgressGuardError,
  guardedLookup,
  isBlockedAddress,
  isUnliftableByHostname,
  type Classifier,
  type Resolver,
} from './egress-guard.js';

const log = logger.child({ module: 'probe-egress' });
const LOOKUP_TIMEOUT_MS = 10_000;
const NO_BODY_STATUS = new Set([204, 205, 304]);

export interface ProbeSeams {
  resolve?: Resolver;
  isBlocked?: Classifier;
  allowHosts?: ReadonlySet<string>;
  privateAllowlist?: () => ParsedAllowlist | Promise<ParsedAllowlist>;
}

async function allowlistFor(seams: ProbeSeams): Promise<ParsedAllowlist> {
  try {
    return await (seams.privateAllowlist ?? loadAllowlist)();
  } catch (err) {
    // A store outage must stay an outage, not read as an empty list.
    rethrowIfConfigUnavailable(err);
    log.warn({ err }, 'private endpoint allowlist unreadable, treating it as empty');
    return EMPTY;
  }
}

function bareHost(host: string): string {
  const name = host.toLowerCase();
  return name.endsWith('.') ? name.slice(0, -1) : name;
}

function isBuiltIn(seams: ProbeSeams, host: string): boolean {
  return seams.allowHosts?.has(host.toLowerCase()) ?? false;
}

function classifierFor(host: string, seams: ProbeSeams, allow: ParsedAllowlist): Classifier {
  if (isBuiltIn(seams, host)) return () => false;
  const base = seams.isBlocked ?? ((a) => isBlockedAddress(a));
  const hostAllowed = allow.hosts.has(bareHost(host));
  return (a) => base(a) && !((hostAllowed && !isUnliftableByHostname(a)) || allow.matches(a));
}

function warnRefused(host: string): void {
  log.warn({ host }, 'egress guard refused a private or unresolvable target');
}

function notFound(host: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), {
    code: 'ENOTFOUND',
    syscall: 'getaddrinfo',
    hostname: host,
  });
}

// An exempt host may be named only in /etc/hosts (host-gateway), which c-ares never reads.
const systemResolve: Resolver = (hostname) => dns.promises.lookup(hostname, { all: true });

function probeLookup(host: string, seams: ProbeSeams, allow: ParsedAllowlist): net.LookupFunction {
  const resolve =
    seams.resolve ??
    (isBuiltIn(seams, host) || allow.hosts.has(bareHost(host))
      ? systemResolve
      : dnsResolver()(LOOKUP_TIMEOUT_MS).resolve);
  const inner = guardedLookup(resolve, classifierFor(host, seams, allow));
  return (hostname, options, callback) => {
    inner(hostname, options, (err, address, family) => {
      if (err instanceof EgressGuardError) {
        warnRefused(host);
        callback(notFound(host), '', 4);
      } else if ((err as NodeJS.ErrnoException | null)?.code === 'ENOTFOUND') {
        callback(notFound(host), '', 4);
      } else callback(err, address as never, family as never);
    });
  };
}

function stripBrackets(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '');
}

function decoderFor(
  header: string | undefined,
): zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | undefined {
  switch (header?.trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip();
    case 'deflate':
      return zlib.createInflate();
    case 'br':
      return zlib.createBrotliDecompress();
    default:
      return undefined;
  }
}

export function createGuardedFetch(seams: ProbeSeams = {}) {
  return async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const signal = init.signal ?? undefined;
    if (signal?.aborted) throw signal.reason;
    let builtIn = false;
    try {
      builtIn = isBuiltIn(seams, stripBrackets(new URL(input).hostname));
    } catch {
      // An invalid URL is refused below, after the list read as before.
    }
    const allow = builtIn ? EMPTY : await allowlistFor(seams);
    if (signal?.aborted) throw signal.reason;
    return new Promise<Response>((resolve, reject) => {
      const fail = (cause: unknown) => reject(new TypeError('fetch failed', { cause }));
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
      if (net.isIP(host) !== 0 && classifierFor(host, seams, allow)(host)) {
        warnRefused(host);
        fail(notFound(host));
        return;
      }
      const secure = url.protocol === 'https:';
      const agent = secure ? new https.Agent() : new http.Agent();
      const headers: Record<string, string> = { 'accept-encoding': 'identity' };
      new Headers(init.headers).forEach((value, key) => {
        headers[key] = value;
      });
      const body = init.body ?? undefined;
      if (body !== undefined && typeof body !== 'string' && !(body instanceof Uint8Array)) {
        reject(new TypeError('unsupported request body type'));
        return;
      }
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
          lookup: probeLookup(host, seams, allow),
        },
        (res) => {
          done = true;
          res.on('close', () => {
            cleanup();
            agent.destroy();
          });
          try {
            const responseHeaders = new Headers();
            for (const [key, value] of Object.entries(res.headers)) {
              if (Array.isArray(value)) for (const v of value) responseHeaders.append(key, v);
              else if (value !== undefined) responseHeaders.append(key, value);
            }
            const status = res.statusCode ?? 0;
            const noBody = NO_BODY_STATUS.has(status);
            if (noBody) res.resume();
            const decoder =
              noBody || init.method?.toUpperCase() === 'HEAD'
                ? undefined
                : decoderFor(res.headers['content-encoding']);
            let source: Readable = res;
            if (decoder) {
              pipeline(res, decoder, () => undefined);
              source = decoder;
              responseHeaders.delete('content-encoding');
              responseHeaders.delete('content-length');
            }
            resolve(
              new Response(noBody ? null : (Readable.toWeb(source) as ReadableStream), {
                status,
                statusText: res.statusMessage ?? '',
                headers: responseHeaders,
              }),
            );
          } catch (err) {
            res.destroy();
            fail(err);
          }
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
  };
}

export const guardedFetch = createGuardedFetch();

type PgSocketOptions = { host: string[]; port: number[]; path?: string | undefined };

function refusedSocket(host: string): net.Socket {
  warnRefused(host);
  const socket = new net.Socket();
  setImmediate(() => socket.destroy(notFound(host)));
  return socket;
}

export function createGuardedPgSocket(seams: ProbeSeams = {}) {
  return async (options: PgSocketOptions): Promise<net.Socket> => {
    const host = options.host?.[0] ?? '';
    const allow = isBuiltIn(seams, host) ? EMPTY : await allowlistFor(seams);
    if (
      options.path ||
      options.host?.length !== 1 ||
      host.includes('/') ||
      (net.isIP(host) !== 0 && classifierFor(host, seams, allow)(host))
    ) {
      return refusedSocket(host);
    }
    const socket = net.connect({
      host,
      port: options.port[0]!,
      lookup: probeLookup(host, seams, allow),
    });
    (socket as net.Socket & { host?: string }).host = host;
    return socket;
  };
}

export const guardedPgSocket = createGuardedPgSocket();
