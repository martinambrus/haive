import dns from 'node:dns';
import type http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export type GuardReason =
  | 'blocked-address'
  | 'redirect-not-followed'
  | 'encoding-not-supported'
  | 'content-type-not-allowed'
  | 'request-timeout'
  | 'request-failed';

export class EgressGuardError extends Error {
  constructor(
    readonly reason: GuardReason,
    readonly httpStatus: number | null = null,
    options?: ErrorOptions,
  ) {
    super(reason, options);
    this.name = 'EgressGuardError';
  }
}

export interface GuardedResponse {
  status: number;
  /** The media type alone, lower case, without its parameters. */
  contentType: string;
  body: Buffer;
  truncated: boolean;
}

export type Resolver = (hostname: string) => Promise<dns.LookupAddress[]>;
export type Classifier = (address: string) => boolean;

/** The name resolution of one request: `cancel` ends whatever is still in flight when the request does. */
export interface NameResolver {
  resolve: Resolver;
  cancel: () => void;
}
export type NameResolverFactory = (timeoutMs: number) => NameResolver;

export interface GuardedGetOptions {
  timeoutMs: number;
  maxBytes: number;
}

export interface GuardSeams {
  resolver: NameResolverFactory;
  isBlocked: Classifier;
  ca?: string | Buffer;
}

export const GUARD_REQUEST_HEADERS = {
  'User-Agent': 'Haive-custom-tool',
  Accept: 'text/*, application/json, application/xml',
  'Accept-Encoding': 'identity',
} as const;

const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

// ::/96 takes in the unspecified, loopback and IPv4-compatible addresses.
const BLOCKED_V6: ReadonlyArray<readonly [string, number]> = [
  ['::', 96],
  // SIIT IPv4-translated, not the IPv4-mapped ::ffff:0:0/96 that the v4 rules above already match.
  ['::ffff:0:0:0', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:2::', 48],
  ['2001:db8::', 32],
  ['3fff::', 20],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
];

const BLOCKED = new net.BlockList();
for (const [network, prefix] of BLOCKED_V4) {
  BLOCKED.addSubnet(network, prefix, 'ipv4');
  // The v4 rules also match ::ffff:a.b.c.d; NAT64 and 6to4 carry the v4 in other bits, so repeat them there.
  const [a, b, c, d] = network.split('.').map(Number) as [number, number, number, number];
  const high = ((a << 8) | b).toString(16);
  const low = ((c << 8) | d).toString(16);
  BLOCKED.addSubnet(`64:ff9b::${high}:${low}`, 96 + prefix, 'ipv6');
  BLOCKED.addSubnet(`2002:${high}:${low}::`, 16 + prefix, 'ipv6');
}
for (const [network, prefix] of BLOCKED_V6) BLOCKED.addSubnet(network, prefix, 'ipv6');

/** True for a private, loopback, link-local or otherwise special address, and for anything that is not an address. */
export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  return family === 0 || BLOCKED.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** c-ares, not getaddrinfo: a stalled getaddrinfo keeps a libuv threadpool slot that no deadline can take back. */
export function dnsResolver(servers?: readonly string[]): NameResolverFactory {
  return (timeoutMs) => {
    // c-ares asks the nameservers one after another, each for the whole timeout.
    const count = Math.max(1, (servers ?? dns.getServers()).length);
    const cares = new dns.promises.Resolver({ timeout: Math.floor(timeoutMs / count), tries: 1 });
    if (servers) cares.setServers(servers);
    return {
      resolve: async (hostname) => {
        const [v4, v6] = await Promise.allSettled([
          cares.resolve4(hostname),
          cares.resolve6(hostname),
        ]);
        const addresses: dns.LookupAddress[] = [
          ...(v4.status === 'fulfilled' ? v4.value.map((address) => ({ address, family: 4 })) : []),
          ...(v6.status === 'fulfilled' ? v6.value.map((address) => ({ address, family: 6 })) : []),
        ];
        if (addresses.length > 0) return addresses;
        const failed = [v4, v6].find((result) => result.status === 'rejected');
        throw Object.assign(new Error(`no address for ${hostname}`, { cause: failed?.reason }), {
          code: 'ENOTFOUND',
        });
      },
      cancel: () => cares.cancel(),
    };
  };
}

// dnsResolver hands a timed-out query on as the cause of its ENOTFOUND.
function lookupTimedOut(err: unknown): boolean {
  const { code, cause } = (err ?? {}) as NodeJS.ErrnoException;
  return code === dns.TIMEOUT || (cause as NodeJS.ErrnoException | undefined)?.code === dns.TIMEOUT;
}

/** The lookup the socket connects with: it refuses the whole answer when any address in it is blocked. */
export function guardedLookup(resolve: Resolver, isBlocked: Classifier): net.LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0) {
          callback(
            Object.assign(new Error(`no address for ${hostname}`), { code: 'ENOTFOUND' }),
            [],
          );
        } else if (addresses.some((entry) => isBlocked(entry.address))) {
          callback(new EgressGuardError('blocked-address'), []);
        } else if (options.all) {
          callback(null, addresses);
        } else {
          callback(null, addresses[0]!.address, addresses[0]!.family);
        }
      },
      (err: NodeJS.ErrnoException) => callback(err, []),
    );
  };
}

const MEDIA_TYPE =
  /^(?:text\/[a-z0-9][a-z0-9.+_-]*|application\/(?:json|xml|[a-z0-9][a-z0-9.+_-]*\+(?:json|xml)))$/;
const MEDIA_TYPE_MAX_LENGTH = 127;

function allowedMediaType(header: string | undefined): string | null {
  const type = header?.split(';', 1)[0]?.trim().toLowerCase();
  return type !== undefined && type.length <= MEDIA_TYPE_MAX_LENGTH && MEDIA_TYPE.test(type)
    ? type
    : null;
}

function guardedRequest(
  url: URL,
  options: GuardedGetOptions,
  seams: GuardSeams,
): Promise<GuardedResponse> {
  return new Promise<GuardedResponse>((resolve, reject) => {
    // An IP literal never reaches the lookup, so it is refused here.
    if (net.isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0) {
      reject(new EgressGuardError('blocked-address'));
      return;
    }
    const names = seams.resolver(options.timeoutMs);
    const agent = new https.Agent();
    const chunks: Buffer[] = [];
    let size = 0;
    let head: { status: number; contentType: string } | null = null;
    let settled = false;

    const request = https.request(
      {
        method: 'GET',
        hostname: url.hostname,
        port: url.port === '' ? 443 : Number(url.port),
        path: url.pathname + url.search,
        headers: { ...GUARD_REQUEST_HEADERS },
        agent,
        lookup: guardedLookup(names.resolve, seams.isBlocked),
        ca: seams.ca,
      },
      onResponse,
    );
    const timer = setTimeout(() => {
      if (head === null) settle(new EgressGuardError('request-timeout'));
      else finish(true);
    }, options.timeoutMs);

    function settle(outcome: GuardedResponse | EgressGuardError): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      names.cancel();
      request.destroy();
      agent.destroy();
      if (outcome instanceof EgressGuardError) reject(outcome);
      else resolve(outcome);
    }

    function finish(truncated: boolean): void {
      settle({ ...head!, body: Buffer.concat(chunks), truncated });
    }

    function fail(err: unknown): void {
      settle(
        err instanceof EgressGuardError
          ? err
          : new EgressGuardError(lookupTimedOut(err) ? 'request-timeout' : 'request-failed', null, {
              cause: err,
            }),
      );
    }

    function onResponse(res: http.IncomingMessage): void {
      const status = res.statusCode ?? 0;
      const encoding = res.headers['content-encoding'];
      const contentType = allowedMediaType(res.headers['content-type']);
      if (status >= 300 && status < 400) {
        settle(new EgressGuardError('redirect-not-followed', status));
      } else if (encoding !== undefined && encoding.trim().toLowerCase() !== 'identity') {
        settle(new EgressGuardError('encoding-not-supported', status));
      } else if (contentType === null) {
        settle(new EgressGuardError('content-type-not-allowed', status));
      } else {
        head = { status, contentType };
        res.on('data', (chunk: Buffer) => {
          if (settled) return;
          const room = options.maxBytes - size;
          chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
          size += Math.min(chunk.length, room);
          if (chunk.length > room) finish(true);
        });
        res.on('end', () => finish(false));
        res.on('error', fail);
      }
    }

    request.on('error', fail);
    request.end();
  });
}

/** A GET to a DNS name, from this process: no redirect, no credential, no proxy, one deadline for all of it. */
export function guardedGet(url: URL, options: GuardedGetOptions): Promise<GuardedResponse> {
  return guardedRequest(url, options, { resolver: dnsResolver(), isBlocked: isBlockedAddress });
}

/** Only a test calls this: it swaps the name lookup, the classifier or the trusted CA to reach a local server. */
export function createGuardedGetForTest(seams: Partial<GuardSeams>): typeof guardedGet {
  return (url, options) =>
    guardedRequest(url, options, {
      resolver: dnsResolver(),
      isBlocked: isBlockedAddress,
      ...seams,
    });
}
