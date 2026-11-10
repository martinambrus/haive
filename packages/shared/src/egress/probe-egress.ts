import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { pipeline, Readable } from 'node:stream';
import zlib from 'node:zlib';
import { ConfigUnavailableError, rethrowIfConfigUnavailable } from '../config/index.js';
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
  /** Normalized `URL.origin` strings, compared as is; fetch only (a database dial has no URL). */
  allowOrigins?: ReadonlySet<string>;
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

// One list read per dial, made only when an address needs it.
function lazyAllowlist(seams: ProbeSeams): () => Promise<ParsedAllowlist> {
  let pending: Promise<ParsedAllowlist> | undefined;
  return () => (pending ??= allowlistFor(seams));
}

function baseClassifier(seams: ProbeSeams): Classifier {
  return seams.isBlocked ?? ((a) => isBlockedAddress(a));
}

function classifierFor(host: string, seams: ProbeSeams, allow: ParsedAllowlist): Classifier {
  if (isBuiltIn(seams, host)) return () => false;
  const base = baseClassifier(seams);
  const hostAllowed = allow.hosts.has(bareHost(host));
  return (a) => base(a) && !((hostAllowed && !isUnliftableByHostname(a)) || allow.matches(a));
}

const REFUSAL_WARN_INTERVAL_MS = 60_000;
const REFUSAL_WARN_HOSTS_MAX = 256;
const refusalWarnedAt = new Map<string, number>();

function warnRefused(host: string): void {
  const key = host.toLowerCase().slice(0, 253);
  const now = Date.now();
  const last = refusalWarnedAt.get(key);
  if (last !== undefined && now - last >= 0 && now - last < REFUSAL_WARN_INTERVAL_MS) return;
  refusalWarnedAt.delete(key);
  while (refusalWarnedAt.size >= REFUSAL_WARN_HOSTS_MAX) {
    refusalWarnedAt.delete(refusalWarnedAt.keys().next().value!);
  }
  refusalWarnedAt.set(key, now);
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

// Only an IP literal the base classifier blocks can be lifted by the list, so only it reads it.
async function literalRefused(
  host: string,
  seams: ProbeSeams,
  lazy: () => Promise<ParsedAllowlist>,
): Promise<boolean> {
  if (net.isIP(host) === 0 || isBuiltIn(seams, host)) return false;
  if (!baseClassifier(seams)(host)) return false;
  return classifierFor(host, seams, await lazy())(host);
}

function probeLookup(
  host: string,
  seams: ProbeSeams,
  lazy: () => Promise<ParsedAllowlist>,
): net.LookupFunction {
  const builtIn = isBuiltIn(seams, host);
  const base = baseClassifier(seams);
  let allow = EMPTY;
  const primary =
    seams.resolve ?? (builtIn ? systemResolve : dnsResolver()(LOOKUP_TIMEOUT_MS).resolve);
  const resolve: Resolver = async (hostname) => {
    let answers;
    try {
      answers = await primary(hostname);
    } catch (err) {
      if (builtIn) throw err;
      allow = await lazy();
      // A name defined only in /etc/hosts (host-gateway) is never seen by c-ares.
      if (allow.hosts.has(bareHost(host))) return systemResolve(hostname);
      throw err;
    }
    if (!builtIn && answers.some((entry) => base(entry.address))) allow = await lazy();
    return answers;
  };
  const inner = guardedLookup(resolve, (a) => classifierFor(host, seams, allow)(a));
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

/** Resolve once for a transport that can pin an address itself, using the probe's dial policy. */
export async function resolveGuardedAddress(host: string, seams: ProbeSeams = {}): Promise<string> {
  host = stripBrackets(host);
  const lazy = lazyAllowlist(seams);
  if (net.isIP(host)) {
    if (await literalRefused(host, seams, lazy)) {
      warnRefused(host);
      throw notFound(host);
    }
    return host;
  }
  return new Promise<string>((resolve, reject) => {
    probeLookup(host, seams, lazy)(host, {}, (err, address) => {
      if (err) reject(err);
      else resolve(address as string);
    });
  });
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

// A built-in origin runs as a built-in host for this dial only.
function seamsFor(input: string | URL, seams: ProbeSeams): ProbeSeams {
  if (!seams.allowOrigins?.size) return seams;
  try {
    const target = new URL(input);
    if (!seams.allowOrigins.has(target.origin)) return seams;
    return {
      ...seams,
      allowHosts: new Set([...(seams.allowHosts ?? []), stripBrackets(target.hostname)]),
    };
  } catch {
    return seams;
  }
}

export function createGuardedFetch(baseSeams: ProbeSeams = {}) {
  return async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const signal = init.signal ?? undefined;
    if (signal?.aborted) throw signal.reason;
    const seams = seamsFor(input, baseSeams);
    const lazy = lazyAllowlist(seams);
    let refusedLiteral = false;
    try {
      const target = new URL(input);
      if (target.protocol === 'http:' || target.protocol === 'https:') {
        refusedLiteral = await literalRefused(stripBrackets(target.hostname), seams, lazy);
      }
    } catch (err) {
      // An invalid URL is refused below; an unreadable list is not.
      rethrowIfConfigUnavailable(err);
    }
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
      if (refusedLiteral) {
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
          lookup: probeLookup(host, seams, lazy),
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
          if (err instanceof ConfigUnavailableError) reject(err);
          else fail(err);
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
    const lazy = lazyAllowlist(seams);
    if (
      options.path ||
      options.host?.length !== 1 ||
      host.includes('/') ||
      (await literalRefused(host, seams, lazy))
    ) {
      return refusedSocket(host);
    }
    const socket = net.connect({
      host,
      port: options.port[0]!,
      lookup: probeLookup(host, seams, lazy),
    });
    (socket as net.Socket & { host?: string }).host = host;
    return socket;
  };
}

export const guardedPgSocket = createGuardedPgSocket();
