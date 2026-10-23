import { randomUUID } from 'node:crypto';
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from 'vitest';
import { customToolUrl, type HttpGetTool } from '@haive/shared/modularity';
import {
  createGuardedGetForTest,
  dnsResolver,
  EgressGuardError,
  GUARD_REQUEST_HEADERS,
  guardedGet,
  guardedLookup,
  isBlockedAddress,
  type GuardedGetOptions,
  type NameResolverFactory,
  type Resolver,
} from '../src/lib/egress-guard.js';
import { selfSignedCertificate } from './self-signed-cert.js';

const HOST = 'guard.test';
const LOOPBACK = [{ address: '127.0.0.1', family: 4 }];

const fixed =
  (resolve: Resolver): NameResolverFactory =>
  () => ({ resolve, cancel: () => {} });

const refusal = async (promise: Promise<unknown>): Promise<EgressGuardError> => {
  const outcome = await promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  if (!('error' in outcome)) throw new Error('expected the guard to refuse');
  expect(outcome.error).toBeInstanceOf(EgressGuardError);
  return outcome.error as EgressGuardError;
};

// A name lookup that never answers by itself: only cancel() ends it, as it ends a c-ares query.
function stalledNames() {
  const log: string[] = [];
  const factory: NameResolverFactory = (timeoutMs) => {
    const hung: Array<(err: Error) => void> = [];
    log.push(`resolver for ${timeoutMs} ms`);
    return {
      resolve: () =>
        new Promise<dns.LookupAddress[]>((_resolve, reject) => {
          hung.push(reject);
        }),
      cancel: () => {
        log.push('cancel');
        for (const reject of hung.splice(0)) {
          reject(Object.assign(new Error('queryA ECANCELLED'), { code: 'ECANCELLED' }));
        }
      },
    };
  };
  return { factory, log };
}

// [range, its first address, its last, the address just below it, the address just above it]; a
// neighbour that is another blocked range is null.
type V4Range = readonly [string, string, string, string | null, string | null];
const V4_RANGES: V4Range[] = [
  ['0.0.0.0/8', '0.0.0.0', '0.255.255.255', null, '1.0.0.0'],
  ['10.0.0.0/8', '10.0.0.0', '10.255.255.255', '9.255.255.255', '11.0.0.0'],
  ['100.64.0.0/10', '100.64.0.0', '100.127.255.255', '100.63.255.255', '100.128.0.0'],
  ['127.0.0.0/8', '127.0.0.0', '127.255.255.255', '126.255.255.255', '128.0.0.0'],
  ['169.254.0.0/16', '169.254.0.0', '169.254.255.255', '169.253.255.255', '169.255.0.0'],
  ['172.16.0.0/12', '172.16.0.0', '172.31.255.255', '172.15.255.255', '172.32.0.0'],
  ['192.0.0.0/24', '192.0.0.0', '192.0.0.255', '191.255.255.255', '192.0.1.0'],
  ['192.0.2.0/24', '192.0.2.0', '192.0.2.255', '192.0.1.255', '192.0.3.0'],
  ['192.88.99.0/24', '192.88.99.0', '192.88.99.255', '192.88.98.255', '192.88.100.0'],
  ['192.168.0.0/16', '192.168.0.0', '192.168.255.255', '192.167.255.255', '192.169.0.0'],
  ['198.18.0.0/15', '198.18.0.0', '198.19.255.255', '198.17.255.255', '198.20.0.0'],
  ['198.51.100.0/24', '198.51.100.0', '198.51.100.255', '198.51.99.255', '198.51.101.0'],
  ['203.0.113.0/24', '203.0.113.0', '203.0.113.255', '203.0.112.255', '203.0.114.0'],
  ['224.0.0.0/4', '224.0.0.0', '239.255.255.255', '223.255.255.255', null],
  ['240.0.0.0/4', '240.0.0.0', '255.255.255.255', null, null],
];
const V4_NEIGHBOURS = V4_RANGES.flatMap(([cidr, , , below, above]) => [
  ...(below === null ? [] : [[cidr, 'below', below] as const]),
  ...(above === null ? [] : [[cidr, 'above', above] as const]),
]);

const BLOCKED_V6: Array<[string, string[]]> = [
  ['::/96 (unspecified, loopback, IPv4-compatible)', ['::', '::1', '::7f00:1', '::a9fe:a9fe']],
  [
    '::ffff:0:0/96 (IPv4-mapped, by the v4 it carries)',
    [
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::FFFF:127.0.0.1',
      '0:0:0:0:0:ffff:7f00:1',
      '::ffff:10.1.2.3',
      '::ffff:169.254.169.254',
      '::ffff:192.168.1.1',
      '::ffff:100.64.0.1',
      '::ffff:0.0.0.0',
    ],
  ],
  [
    '64:ff9b::/96 (NAT64, by the v4 it carries)',
    [
      '64:ff9b::a9fe:a9fe',
      '64:ff9b::169.254.169.254',
      '64:ff9b::7f00:1',
      '64:ff9b::a00:1',
      '64:ff9b::c0a8:1',
      '64:ff9b::ac10:1',
      '64:ff9b::6440:1',
      '64:ff9b::e000:1',
      '64:ff9b::ffff:ffff',
    ],
  ],
  [
    '::ffff:0:0:0/96 (SIIT IPv4-translated, the whole prefix)',
    [
      '::ffff:0:0:0',
      '::ffff:0:7f00:1',
      '::ffff:0:127.0.0.1',
      '::ffff:0:a9fe:a9fe',
      '::ffff:0:169.254.169.254',
      '::ffff:0:a00:1',
      '::ffff:0:808:808',
      '::ffff:0:ffff:ffff',
      '0:0:0:0:ffff:0:7f00:1',
    ],
  ],
  [
    '64:ff9b:1::/48 (local-use NAT64, the whole prefix)',
    [
      '64:ff9b:1::',
      '64:ff9b:1::1',
      '64:ff9b:1::a00:1',
      '64:ff9b:1::10.0.0.1',
      '64:ff9b:1::a9fe:a9fe',
      '64:ff9b:1:a00:1::',
      '64:ff9b:1::808:808',
      '64:ff9b:1:ffff:ffff:ffff:ffff:ffff',
    ],
  ],
  ['100::/64 (discard-only)', ['100::', '100::1', '100::ffff:ffff:ffff:ffff']],
  [
    '2001::/32 (Teredo)',
    ['2001::', '2001::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:0:ffff:ffff::1'],
  ],
  ['2001:db8::/32 (documentation)', ['2001:db8::', '2001:db8::1', '2001:db8:ffff:ffff::1']],
  ['2001:2::/48 (benchmarking)', ['2001:2::', '2001:2::1', '2001:2:0:ffff:ffff:ffff:ffff:ffff']],
  ['3fff::/20 (documentation)', ['3fff::', '3fff::1', '3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff']],
  [
    '5f00::/16 (SRv6 segment identifiers)',
    ['5f00::', '5f00::1', '5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ],
  [
    '2002::/16 (6to4, by the v4 it carries)',
    [
      '2002:7f00:1::',
      '2002:7f00:1:abcd::1',
      '2002:a9fe:a9fe::',
      '2002:a00:1::',
      '2002:c0a8:1::',
      '2002:ac10:1::',
      '2002:6440:1::',
      '2002:0:0::',
    ],
  ],
  ['fc00::/7 (unique local)', ['fc00::', 'fc00::1', 'fd12:3456:789a::1', 'fdff:ffff::1']],
  ['fe80::/10 (link local)', ['fe80::1', 'fe80::1%eth0', 'febf:ffff::1']],
  [
    'fec0::/10 (deprecated site-local, the whole prefix)',
    ['fec0::', 'fec0::1', 'fed0:1::', 'fee0::a00:1', 'feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ],
  ['ff00::/8 (multicast)', ['ff00::', 'ff02::1', 'ffff::1']],
];

// The addresses just outside the prefixes added after the first review. fec0::/10 sits between
// fe80::/10 and ff00::/8, so it has no public neighbour.
const OUTSIDE_NEW_V6: Array<[string, string, string]> = [
  ['::ffff:0:0:0/96', 'below', '::fffe:ffff:ffff:ffff'],
  ['::ffff:0:0:0/96', 'above', '::ffff:1:0:0'],
  ['64:ff9b:1::/48', 'below', '64:ff9b:0:ffff:ffff:ffff:ffff:ffff'],
  ['64:ff9b:1::/48', 'above', '64:ff9b:2::'],
  ['2001:2::/48', 'below', '2001:1:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['2001:2::/48', 'above', '2001:2:1::'],
  ['3fff::/20', 'below', '3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['3fff::/20', 'above', '3fff:1000::'],
  ['5f00::/16', 'below', '5eff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['5f00::/16', 'above', '5f01::'],
];

const PUBLIC = [
  '1.1.1.1',
  '8.8.8.8',
  '93.184.216.34',
  '100.63.255.255',
  '100.128.0.1',
  '172.15.255.255',
  '172.32.0.1',
  '192.0.1.1',
  '192.167.255.255',
  '192.169.0.1',
  '198.17.255.255',
  '198.20.0.1',
  '223.255.255.254',
  '2606:4700:4700::1111',
  '2001:4860:4860::8888',
  '2a00:1450:4001::200e',
  '2620:fe::fe',
  '2001:db9::1',
  '::ffff:8.8.8.8',
  '::ffff:1.1.1.1',
  '::ffff:93.184.216.34',
  '64:ff9b::808:808',
  '64:ff9b::101:101',
  '2002:808:808::',
  '2002:101:101::1',
];

const NOT_AN_ADDRESS = [
  '',
  ' ',
  'localhost',
  'example.com',
  '127.0.0.1 ',
  ' 127.0.0.1',
  '127.0.0.1/8',
  '999.1.1.1',
  '1.2.3',
  '127.1',
  '0x7f.0.0.1',
  '2130706433',
  '[::1]',
  'fe80::g',
  'null',
];

// The six the design names, plus the ranges they stand for.
const BRIEF_BLOCKED = [
  '::ffff:127.0.0.1',
  '64:ff9b::a9fe:a9fe',
  '2002:7f00:1::',
  '::1',
  '100.64.0.1',
  '169.254.169.254',
];

describe('isBlockedAddress', () => {
  it.each(V4_RANGES)(
    'blocks %s, from its first address %s to its last %s',
    (_cidr, first, last) => {
      expect(isBlockedAddress(first)).toBe(true);
      expect(isBlockedAddress(last)).toBe(true);
    },
  );

  it.each(V4_NEIGHBOURS)(
    'stops at the edge of %s: the address %s it, %s, is public',
    (_cidr, _side, address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );

  it.each(OUTSIDE_NEW_V6)(
    'stops at the edge of %s: the address %s it, %s, is public',
    (_range, _side, address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );

  it.each(BLOCKED_V6.flatMap(([range, addresses]) => addresses.map((a) => [range, a] as const)))(
    'blocks %s: %s',
    (_range, address) => {
      expect(isBlockedAddress(address)).toBe(true);
    },
  );

  it.each(BRIEF_BLOCKED)('blocks %s, which the design names', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(PUBLIC)('lets the public address %s through', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it.each(NOT_AN_ADDRESS)(
    'blocks %j, which is not an address, rather than letting it through',
    (v) => {
      expect(isBlockedAddress(v)).toBe(true);
    },
  );

  it('reads the embedded v4 of the transition forms, so a public one passes and a private one does not', () => {
    expect(isBlockedAddress('64:ff9b::808:808')).toBe(false);
    expect(isBlockedAddress('64:ff9b::a00:1')).toBe(true);
    expect(isBlockedAddress('2002:808:808::')).toBe(false);
    expect(isBlockedAddress('2002:a00:1::')).toBe(true);
    expect(isBlockedAddress('::ffff:8.8.8.8')).toBe(false);
    expect(isBlockedAddress('::ffff:10.0.0.1')).toBe(true);
  });
});

type LookupResult = { err: NodeJS.ErrnoException | null; address: unknown; family?: number };

function callLookup(
  lookup: ReturnType<typeof guardedLookup>,
  hostname: string,
  all: boolean,
): Promise<LookupResult> {
  return new Promise((resolve) => {
    lookup(hostname, { all }, (err, address, family) => resolve({ err, address, family }));
  });
}

const answer =
  (...addresses: string[]) =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

describe('guardedLookup', () => {
  it.each([
    ...BRIEF_BLOCKED,
    '10.0.0.1',
    '172.17.0.2',
    '192.168.65.254',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    'fe80::1',
    'fd00::1',
    '2001:db8::1',
  ])('refuses %s answered by the resolver, with all addresses asked for', async (address) => {
    const lookup = guardedLookup(answer(address), isBlockedAddress);

    const { err, address: given } = await callLookup(lookup, 'names.test', true);

    expect(err).toBeInstanceOf(EgressGuardError);
    expect((err as EgressGuardError).reason).toBe('blocked-address');
    expect(given).not.toEqual([expect.objectContaining({ address })]);
  });

  it.each(BRIEF_BLOCKED)(
    'refuses %s when the socket asks for one address only',
    async (address) => {
      const lookup = guardedLookup(answer(address), isBlockedAddress);

      const { err } = await callLookup(lookup, 'names.test', false);

      expect(err).toBeInstanceOf(EgressGuardError);
      expect((err as EgressGuardError).reason).toBe('blocked-address');
    },
  );

  it.each([
    ['a public address first and a private one second', ['93.184.216.34', '10.0.0.1']],
    ['a private address first and a public one second', ['10.0.0.1', '93.184.216.34']],
    ['a public v6 address and a loopback v4 one', ['2606:4700:4700::1111', '127.0.0.1']],
    ['a public v4 address and a mapped private one', ['93.184.216.34', '::ffff:10.0.0.1']],
    ['two public addresses and a link-local one last', ['1.1.1.1', '8.8.8.8', '169.254.169.254']],
  ])('refuses an answer with %s, in either call shape', async (_name, addresses) => {
    const lookup = guardedLookup(answer(...addresses), isBlockedAddress);

    for (const all of [true, false]) {
      const { err } = await callLookup(lookup, 'names.test', all);
      expect(err).toBeInstanceOf(EgressGuardError);
      expect((err as EgressGuardError).reason).toBe('blocked-address');
    }
  });

  it('hands every address of an all-public answer to the socket, as the resolver gave them', async () => {
    const lookup = guardedLookup(answer('93.184.216.34', '2606:2800:220:1::1'), isBlockedAddress);

    const { err, address } = await callLookup(lookup, 'names.test', true);

    expect(err).toBeNull();
    expect(address).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1::1', family: 6 },
    ]);
  });

  it('hands the first address and its family to a socket that asked for one', async () => {
    const lookup = guardedLookup(answer('93.184.216.34', '2606:2800:220:1::1'), isBlockedAddress);

    const { err, address, family } = await callLookup(lookup, 'names.test', false);

    expect(err).toBeNull();
    expect(address).toBe('93.184.216.34');
    expect(family).toBe(4);
  });

  it('asks the resolver about the host name it was given, on every call', async () => {
    const asked: string[] = [];
    const lookup = guardedLookup(async (name) => {
      asked.push(name);
      return [{ address: '93.184.216.34', family: 4 }];
    }, isBlockedAddress);

    await callLookup(lookup, 'one.test', true);
    await callLookup(lookup, 'two.test', true);
    await callLookup(lookup, 'one.test', true);

    expect(asked).toEqual(['one.test', 'two.test', 'one.test']);
  });

  it('keeps no verdict between calls: public at first, private on the connect lookup, is refused', async () => {
    let calls = 0;
    const lookup = guardedLookup(async () => {
      calls += 1;
      return [{ address: calls === 1 ? '93.184.216.34' : '10.0.0.5', family: 4 }];
    }, isBlockedAddress);

    const first = await callLookup(lookup, 'rebind.test', true);
    const second = await callLookup(lookup, 'rebind.test', true);
    const third = await callLookup(lookup, 'rebind.test', true);

    expect(first.err).toBeNull();
    expect(second.err).toBeInstanceOf(EgressGuardError);
    expect((second.err as EgressGuardError).reason).toBe('blocked-address');
    expect(third.err).toBeInstanceOf(EgressGuardError);
    expect(calls).toBe(3);
  });

  it('answers an empty list as a name that did not resolve, which is not a blocked address', async () => {
    const lookup = guardedLookup(async () => [], isBlockedAddress);

    const { err } = await callLookup(lookup, 'nothing.test', true);

    expect(err).not.toBeInstanceOf(EgressGuardError);
    expect(err?.code).toBe('ENOTFOUND');
  });

  it('passes a resolver failure on as it is', async () => {
    const failure = Object.assign(new Error('getaddrinfo ENOTFOUND nothing.test'), {
      code: 'ENOTFOUND',
    });
    const lookup = guardedLookup(async () => Promise.reject(failure), isBlockedAddress);

    const { err } = await callLookup(lookup, 'nothing.test', true);

    expect(err).toBe(failure);
  });

  it('uses the classifier it was given, which is how a test reaches a local server', async () => {
    const lookup = guardedLookup(answer('127.0.0.1'), () => false);

    const { err, address } = await callLookup(lookup, 'local.test', true);

    expect(err).toBeNull();
    expect(address).toEqual([{ address: '127.0.0.1', family: 4 }]);
  });
});

interface Seen {
  method: string | undefined;
  url: string | undefined;
  rawHeaders: string[];
}

describe('guardedGet', () => {
  let key: string;
  let cert: string;
  let server: https.Server;
  let port: number;
  let seen: Seen[];
  let connections: number;
  let sockets: Set<net.Socket>;
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

  type Seams = NonNullable<Parameters<typeof createGuardedGetForTest>[0]>;
  const target = (path = '/') => new URL(`https://${HOST}:${port}${path}`);
  const local = (): Seams => ({
    resolver: fixed(async () => LOOPBACK),
    isBlocked: () => false,
    ca: cert,
  });
  const run = (url: URL, seams: Seams, over: Partial<GuardedGetOptions> = {}) =>
    createGuardedGetForTest(seams)(url, { timeoutMs: 2000, maxBytes: 4096, ...over });
  const get = (
    path = '/',
    { timeoutMs = 2000, maxBytes = 4096, ...seams }: Partial<GuardedGetOptions> & Seams = {},
  ) => run(target(path), { ...local(), ...seams }, { timeoutMs, maxBytes });
  const reply = (status: number, headers: http.OutgoingHttpHeaders, body: string | Buffer = '') => {
    handler = (_req, res) => {
      res.writeHead(status, headers);
      res.end(body);
    };
  };

  beforeAll(async () => {
    ({ key, cert } = selfSignedCertificate(HOST));
    sockets = new Set();
    server = https.createServer({ key, cert }, (req, res) => {
      seen.push({ method: req.method, url: req.url, rawHeaders: req.rawHeaders });
      handler(req, res);
    });
    server.on('connection', (socket) => {
      connections += 1;
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as net.AddressInfo).port;
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    seen = [];
    connections = 0;
    reply(200, { 'content-type': 'text/plain' }, 'hello');
  });

  describe('the request', () => {
    it('sends exactly User-Agent, Accept and Accept-Encoding: identity, and no cookie or credential', async () => {
      await get('/api/x?y=1');

      const names = seen[0]!.rawHeaders.filter((_v, i) => i % 2 === 0);
      expect(names).toEqual([...Object.keys(GUARD_REQUEST_HEADERS), 'Host', 'Connection']);
      const headers = Object.fromEntries(
        seen[0]!.rawHeaders.reduce<Array<[string, string]>>((pairs, v, i, all) => {
          if (i % 2 === 0) pairs.push([v.toLowerCase(), all[i + 1]!]);
          return pairs;
        }, []),
      );
      expect(headers['accept-encoding']).toBe('identity');
      expect(headers['user-agent']).toBe(GUARD_REQUEST_HEADERS['User-Agent']);
      expect(headers.accept).toBe(GUARD_REQUEST_HEADERS.Accept);
      expect(headers.host).toBe(`${HOST}:${port}`);
      expect(headers.connection).toBe('close');
      expect(headers).not.toHaveProperty('cookie');
      expect(headers).not.toHaveProperty('authorization');
      expect(headers).not.toHaveProperty('proxy-authorization');
    });

    it('sends a GET for the path and the query of the URL', async () => {
      await get('/api/x?y=1&z=a%20b');

      expect(seen).toHaveLength(1);
      expect(seen[0]!.method).toBe('GET');
      expect(seen[0]!.url).toBe('/api/x?y=1&z=a%20b');
    });

    it('sends no credential even when the URL carries user info', async () => {
      const url = target('/with-userinfo');
      const password = randomUUID();
      url.username = 'someone';
      url.password = password;

      await run(url, local());

      const names = seen[0]!.rawHeaders.filter((_v, i) => i % 2 === 0).map((n) => n.toLowerCase());
      expect(names).not.toContain('authorization');
      expect(JSON.stringify(seen[0]!.rawHeaders)).not.toContain(password);
      expect(seen[0]!.url).toBe('/with-userinfo');
    });

    it('opens a connection and resolves the name for every call: nothing is pooled between calls', async () => {
      let resolved = 0;
      const resolve = async () => {
        resolved += 1;
        return LOOPBACK;
      };

      await get('/one', { resolver: fixed(resolve) });
      await get('/two', { resolver: fixed(resolve) });
      await get('/three', { resolver: fixed(resolve) });

      expect(resolved).toBe(3);
      expect(connections).toBe(3);
    });

    it('keeps every reserved character of a value inside its slot, as the server receives it', async () => {
      const tool = {
        name: 'fetch',
        description: 'Fetches.',
        action: 'http-get',
        url: `https://${HOST}:${port}/api/{page}`,
        query: ['q'],
        params: [
          { name: 'page', type: 'string', description: 'Which.', required: true, maxLength: 64 },
          { name: 'q', type: 'string', description: 'Search.', required: false, maxLength: 64 },
        ],
        timeoutMs: 2000,
        maxResponseBytes: 4096,
      } as HttpGetTool;
      const built = customToolUrl(tool, { page: 'a?b#c%2Fd e', q: 'x&y=z/w' });
      if (!built.ok) throw new Error(built.message);

      await run(built.url, local());

      expect(seen[0]!.url).toBe('/api/a%3Fb%23c%252Fd%20e?q=x%26y%3Dz%2Fw');
    });

    it.each(['.', '..', 'a/b', '../../admin', 'a\\b', String.fromCodePoint(0xff0e).repeat(2)])(
      'sends nothing for a %j value, which the URL builder refuses',
      async (page) => {
        const tool = {
          name: 'fetch',
          description: 'Fetches.',
          action: 'http-get',
          url: `https://${HOST}:${port}/api/{page}`,
          query: [],
          params: [
            { name: 'page', type: 'string', description: 'Which.', required: true, maxLength: 64 },
          ],
          timeoutMs: 2000,
          maxResponseBytes: 4096,
        } as HttpGetTool;

        const built = customToolUrl(tool, { page });

        expect(built.ok).toBe(false);
        expect(seen).toEqual([]);
        expect(connections).toBe(0);
      },
    );

    it('cannot be given a header by a value: a CRLF in it is encoded into the path', async () => {
      const tool = {
        name: 'fetch',
        description: 'Fetches.',
        action: 'http-get',
        url: `https://${HOST}:${port}/api/{page}`,
        query: [],
        params: [
          { name: 'page', type: 'string', description: 'Which.', required: true, maxLength: 128 },
        ],
        timeoutMs: 2000,
        maxResponseBytes: 4096,
      } as HttpGetTool;
      const built = customToolUrl(tool, {
        page: 'x\r\nCookie: session=1\r\nAuthorization: Bearer t',
      });
      if (!built.ok) throw new Error(built.message);

      await run(built.url, local());

      const names = seen[0]!.rawHeaders.filter((_v, i) => i % 2 === 0);
      expect(names).toEqual([...Object.keys(GUARD_REQUEST_HEADERS), 'Host', 'Connection']);
      expect(seen[0]!.url).toContain('%0D%0ACookie');
    });
  });

  describe('the response', () => {
    it('returns the status, the media type without its parameters, and the body', async () => {
      reply(200, { 'content-type': 'Application/JSON; charset=utf-8' }, '{"ok":true}');

      const res = await get();

      expect(res.status).toBe(200);
      expect(res.contentType).toBe('application/json');
      expect(res.body.toString('utf8')).toBe('{"ok":true}');
      expect(res.truncated).toBe(false);
    });

    it.each([404, 410, 429, 500, 503])(
      'returns a %i as a result, not as a refusal',
      async (status) => {
        reply(status, { 'content-type': 'text/html' }, `<p>status ${status}</p>`);

        const res = await get();

        expect(res.status).toBe(status);
        expect(res.body.toString('utf8')).toBe(`<p>status ${status}</p>`);
      },
    );

    it('returns an empty body as an empty buffer', async () => {
      reply(200, { 'content-type': 'text/plain', 'content-length': '0' });

      const res = await get();

      expect(res.body.length).toBe(0);
      expect(res.truncated).toBe(false);
    });
  });

  describe('redirects', () => {
    it.each([300, 301, 302, 303, 307, 308])(
      'does not follow a %i: it fails with redirect-not-followed and the target is never asked',
      async (status) => {
        handler = (_req, res) => {
          res.writeHead(status, {
            location: `https://${HOST}:${port}/followed`,
            'content-type': 'text/html',
          });
          res.end('moved');
        };

        const error = await refusal(get('/start'));

        expect(error.reason).toBe('redirect-not-followed');
        expect(error.httpStatus).toBe(status);
        expect(seen.map((s) => s.url)).toEqual(['/start']);
        expect(connections).toBe(1);
      },
    );

    it('does not follow a redirect to a private address either', async () => {
      handler = (_req, res) => {
        res.writeHead(302, { location: 'https://169.254.169.254/latest/meta-data/' });
        res.end();
      };

      const error = await refusal(get('/start'));

      expect(error.reason).toBe('redirect-not-followed');
      expect(seen).toHaveLength(1);
    });
  });

  describe('the size cap', () => {
    it('cuts a larger body at maxBytes and says so', async () => {
      reply(200, { 'content-type': 'text/plain' }, 'a'.repeat(10_000));

      const res = await get('/', { maxBytes: 1024 });

      expect(res.body.length).toBe(1024);
      expect(res.truncated).toBe(true);
      expect(res.body.toString('utf8')).toBe('a'.repeat(1024));
    });

    it('does not mark a body of exactly maxBytes, and marks one of a single byte more', async () => {
      reply(200, { 'content-type': 'text/plain' }, 'b'.repeat(1024));
      const exact = await get('/', { maxBytes: 1024 });
      reply(200, { 'content-type': 'text/plain' }, 'b'.repeat(1025));
      const over = await get('/', { maxBytes: 1024 });

      expect(exact.body.length).toBe(1024);
      expect(exact.truncated).toBe(false);
      expect(over.body.length).toBe(1024);
      expect(over.truncated).toBe(true);
    });

    it('cuts a body that arrives in many small pieces, and closes the connection instead of reading on', async () => {
      let closedEarly = false;
      handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.on('close', () => {
          closedEarly = true;
        });
        const timer = setInterval(() => res.write('c'.repeat(100)), 5);
        res.on('close', () => clearInterval(timer));
      };

      const res = await get('/', { maxBytes: 1024 });

      expect(res.body.length).toBe(1024);
      expect(res.truncated).toBe(true);
      await vi.waitFor(() => expect(closedEarly).toBe(true), { timeout: 2000 });
    });
  });

  describe('the deadline', () => {
    it('cuts a slow body at the deadline and returns what arrived, marked as cut', async () => {
      let closed = false;
      handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('partial');
        res.on('close', () => {
          closed = true;
        });
      };

      const startedAt = Date.now();
      const res = await get('/', { timeoutMs: 300 });
      const elapsed = Date.now() - startedAt;

      expect(res.status).toBe(200);
      expect(res.body.toString('utf8')).toBe('partial');
      expect(res.truncated).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(250);
      expect(elapsed).toBeLessThan(3000);
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 2000 });
    });

    it('fails with request-timeout when the server never answers', async () => {
      handler = () => {};

      const startedAt = Date.now();
      const error = await refusal(get('/', { timeoutMs: 300 }));

      expect(error.reason).toBe('request-timeout');
      expect(Date.now() - startedAt).toBeLessThan(3000);
    });

    it('counts the name lookup in the deadline', async () => {
      const startedAt = Date.now();
      const error = await refusal(
        get('/', { timeoutMs: 300, resolver: fixed(() => new Promise(() => {})) }),
      );

      expect(error.reason).toBe('request-timeout');
      expect(Date.now() - startedAt).toBeLessThan(3000);
      expect(connections).toBe(0);
    });

    it('reports a name lookup that timed out by itself as request-timeout, as the deadline does', async () => {
      const timedOut = Object.assign(new Error('queryA ETIMEOUT'), { code: dns.TIMEOUT });

      const error = await refusal(get('/', { resolver: fixed(() => Promise.reject(timedOut)) }));

      expect(error.reason).toBe('request-timeout');
      expect(error.cause).toBe(timedOut);
      expect(connections).toBe(0);
    });

    it('counts the TLS handshake in the deadline: a server that accepts and never speaks', async () => {
      const held: net.Socket[] = [];
      const silent = net.createServer((socket) => held.push(socket));
      await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
      const silentPort = (silent.address() as net.AddressInfo).port;
      try {
        const startedAt = Date.now();
        const error = await refusal(
          run(new URL(`https://${HOST}:${silentPort}/`), local(), { timeoutMs: 300 }),
        );

        expect(error.reason).toBe('request-timeout');
        expect(Date.now() - startedAt).toBeLessThan(3000);
      } finally {
        for (const socket of held) socket.destroy();
        silent.close();
      }
    });

    it('does not cut a body that finishes in time', async () => {
      reply(200, { 'content-type': 'text/plain' }, 'whole');

      const res = await get('/', { timeoutMs: 5000 });

      expect(res.truncated).toBe(false);
    });
  });

  describe('what it refuses to read', () => {
    it.each(['gzip', 'GZIP', 'br', 'deflate', 'compress', 'zstd', 'gzip, br'])(
      'refuses a Content-Encoding of %s even though identity was asked for',
      async (encoding) => {
        reply(200, { 'content-type': 'text/plain', 'content-encoding': encoding }, 'x');

        const error = await refusal(get());

        expect(error.reason).toBe('encoding-not-supported');
      },
    );

    it.each(['identity', 'Identity', ' identity '])(
      'reads a body with a Content-Encoding of %j',
      async (encoding) => {
        reply(200, { 'content-type': 'text/plain', 'content-encoding': encoding }, 'plain');

        const res = await get();

        expect(res.body.toString('utf8')).toBe('plain');
      },
    );

    it.each([
      'image/png',
      'image/svg+xml',
      'application/octet-stream',
      'application/pdf',
      'application/zip',
      'application/javascript',
      'application/x-www-form-urlencoded',
      'application/json2',
      'application/jsonp',
      'application/+json',
      'application/x-www-form+urlencoded',
      'multipart/form-data',
      'video/mp4',
      'audio/mpeg',
      'font/woff2',
      '*/*',
      'text',
      'text/',
      'textual/plain',
      'x'.repeat(200),
    ])('refuses the content type %j', async (contentType) => {
      reply(200, { 'content-type': contentType }, 'body');

      const error = await refusal(get());

      expect(error.reason).toBe('content-type-not-allowed');
    });

    it('refuses an answer with no content type', async () => {
      reply(200, {}, 'body');

      const error = await refusal(get());

      expect(error.reason).toBe('content-type-not-allowed');
    });

    it.each([
      ['text/plain', 'text/plain'],
      ['text/html; charset=utf-8', 'text/html'],
      ['TEXT/CSV', 'text/csv'],
      ['text/event-stream', 'text/event-stream'],
      ['application/json', 'application/json'],
      ['application/json; charset=utf-8', 'application/json'],
      ['Application/JSON', 'application/json'],
      ['application/xml', 'application/xml'],
      ['application/ld+json', 'application/ld+json'],
      ['application/vnd.api+json', 'application/vnd.api+json'],
      ['application/problem+json', 'application/problem+json'],
      ['application/atom+xml; charset=UTF-8', 'application/atom+xml'],
      ['application/xhtml+xml', 'application/xhtml+xml'],
    ])('reads the content type %j and reports it as %j', async (header, reported) => {
      reply(200, { 'content-type': header }, 'body');

      const res = await get();

      expect(res.contentType).toBe(reported);
    });

    it('calls a redirect a redirect even when its body is of a type it would not read', async () => {
      reply(302, { location: '/x', 'content-type': 'image/png' }, 'png');

      const error = await refusal(get());

      expect(error.reason).toBe('redirect-not-followed');
    });
  });

  describe('failures that are not a policy', () => {
    it('does not trust a certificate its caller did not vouch for, and sends the server nothing', async () => {
      const error = await refusal(get('/', { ca: undefined }));

      expect(error.reason).toBe('request-failed');
      expect(seen).toEqual([]);
    });

    it('reports a name that does not resolve as request-failed', async () => {
      const error = await refusal(
        get('/', {
          resolver: fixed(async () =>
            Promise.reject(Object.assign(new Error('nx'), { code: 'ENOTFOUND' })),
          ),
        }),
      );

      expect(error.reason).toBe('request-failed');
    });

    it('reports a name lookup the nameserver failed as request-failed, with the failure as its cause', async () => {
      const failure = Object.assign(new Error('queryA ESERVFAIL'), { code: 'ESERVFAIL' });

      const error = await refusal(get('/', { resolver: fixed(() => Promise.reject(failure)) }));

      expect(error.reason).toBe('request-failed');
      expect(error.cause).toBe(failure);
    });

    it('reports a refused connection as request-failed', async () => {
      const closed = net.createServer();
      await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
      const closedPort = (closed.address() as net.AddressInfo).port;
      await new Promise((resolve) => closed.close(resolve));

      const error = await refusal(run(new URL(`https://${HOST}:${closedPort}/`), local()));

      expect(error.reason).toBe('request-failed');
    });

    it('reports a connection the server resets as request-failed', async () => {
      handler = (req) => req.socket.destroy();

      const error = await refusal(get());

      expect(error.reason).toBe('request-failed');
    });

    it('reports a connection the server drops in the middle of the body as request-failed', async () => {
      handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '1000' });
        res.write('begin');
        setTimeout(() => res.socket?.destroy(), 20);
      };

      const error = await refusal(get());

      expect(error.reason).toBe('request-failed');
    });
  });

  describe('the guard itself', () => {
    it('refuses a name that resolves to loopback by default: the server on 127.0.0.1 is never reached', async () => {
      const error = await refusal(
        run(target('/'), { resolver: fixed(async () => LOOPBACK), ca: cert }),
      );

      expect(error.reason).toBe('blocked-address');
      expect(connections).toBe(0);
      expect(seen).toEqual([]);
    });

    it('reaches that same server once the classifier is replaced, which shows the refusal was the classifier', async () => {
      const res = await run(target('/'), {
        resolver: fixed(async () => LOOPBACK),
        isBlocked: () => false,
        ca: cert,
      });

      expect(res.status).toBe(200);
      expect(connections).toBe(1);
    });

    it.each(BRIEF_BLOCKED)(
      'refuses a request whose name resolves to %s, before any connection',
      async (address) => {
        const startedAt = Date.now();
        const error = await refusal(
          run(new URL('https://rebind.test/'), { resolver: fixed(answer(address)) }),
        );

        expect(error.reason).toBe('blocked-address');
        expect(Date.now() - startedAt).toBeLessThan(1500);
      },
    );

    it('refuses a request whose name resolves to a public and a private address', async () => {
      const error = await refusal(
        run(new URL('https://mixed.test/'), {
          resolver: fixed(answer('93.184.216.34', '10.0.0.1')),
        }),
      );

      expect(error.reason).toBe('blocked-address');
    });

    it('refuses the second request to a name that moved to a private address between two calls', async () => {
      let calls = 0;
      const resolve = async () => {
        calls += 1;
        return [{ address: calls === 1 ? '127.0.0.1' : '10.0.0.9', family: 4 }];
      };
      const isBlocked = (address: string) => address === '10.0.0.9';

      const first = await get('/first', { resolver: fixed(resolve), isBlocked });
      const startedAt = Date.now();
      const error = await refusal(get('/second', { resolver: fixed(resolve), isBlocked }));

      expect(first.status).toBe(200);
      expect(error.reason).toBe('blocked-address');
      expect(Date.now() - startedAt).toBeLessThan(1500);
      expect(seen.map((s) => s.url)).toEqual(['/first']);
      expect(connections).toBe(1);
    });

    it.each([
      ['a loopback v4 literal', () => `https://127.0.0.1:${port}/`],
      ['a loopback v6 literal', () => `https://[::1]:${port}/`],
      ['a private v4 literal', () => 'https://10.0.0.1/'],
      ['a documentation v4 literal', () => 'https://192.0.2.1/'],
      ['a documentation v6 literal', () => 'https://[2001:db8::1]/'],
      [
        'a decimal v4 literal, which the URL parser reads as 127.0.0.1',
        () => `https://2130706433:${port}/`,
      ],
    ])(
      'refuses %s as a host, which would skip the name lookup, even with a permissive classifier',
      async (_name, url) => {
        const error = await refusal(run(new URL(url()), local()));

        expect(error.reason).toBe('blocked-address');
        expect(connections).toBe(0);
        expect(seen).toEqual([]);
      },
    );

    it('sends the TLS server nothing at all when it refuses: a raw listener sees no connection and no byte', async () => {
      const bytes: number[] = [];
      let accepted = 0;
      const held: net.Socket[] = [];
      const raw = net.createServer((socket) => {
        held.push(socket);
        accepted += 1;
        socket.on('data', (chunk) => bytes.push(chunk.length));
      });
      await new Promise<void>((resolve) => raw.listen(0, '127.0.0.1', resolve));
      const rawPort = (raw.address() as net.AddressInfo).port;
      try {
        const error = await refusal(
          run(new URL(`https://${HOST}:${rawPort}/`), {
            resolver: fixed(async () => LOOPBACK),
            ca: cert,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 150));

        expect(error.reason).toBe('blocked-address');
        expect(accepted).toBe(0);
        expect(bytes).toEqual([]);
      } finally {
        for (const socket of held) socket.destroy();
        raw.close();
      }
    });

    it('does not route through an environment proxy, which the global agent does', async () => {
      const connects: string[] = [];
      const proxy = net.createServer((socket) => {
        socket.once('data', (chunk) => {
          connects.push(chunk.toString().split('\r\n')[0]!);
          socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        });
      });
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      const proxyUrl = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
      const restore = http.setGlobalProxyFromEnv({ HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl });
      try {
        await new Promise<void>((resolve) => {
          const req = https.request({ hostname: HOST, port, path: '/control', ca: cert }, (res) => {
            res.resume();
            resolve();
          });
          req.on('error', () => resolve());
          req.end();
        });
        expect(connects).toEqual([`CONNECT ${HOST}:${port} HTTP/1.1`]);

        const res = await get('/guarded');

        expect(res.status).toBe(200);
        expect(connects).toHaveLength(1);
        expect(seen.map((s) => s.url)).toEqual(['/guarded']);
      } finally {
        restore();
        proxy.close();
      }
    });
  });
});

const caresError = (code: string) => Object.assign(new Error(`query ${code}`), { code });

// Stands in for the c-ares resolver of node:dns, so the answers it gives are the test's.
function mockCares(over: { a?: string[] | Error; aaaa?: string[] | Error }) {
  const answer = (result: string[] | Error | undefined) => async () => {
    if (result instanceof Error) throw result;
    return result ?? [];
  };
  const cares = {
    resolve4: vi.fn(answer(over.a)),
    resolve6: vi.fn(answer(over.aaaa)),
    setServers: vi.fn(),
    cancel: vi.fn(),
  };
  const Resolver = vi.spyOn(dns.promises, 'Resolver').mockImplementation(function () {
    return cares;
  } as never);
  return { cares, Resolver };
}

describe('the name lookup of a call', () => {
  const guard = (resolver: NameResolverFactory) =>
    createGuardedGetForTest({ resolver, isBlocked: () => false });
  const stalled = new URL('https://stall.test/');

  it('is cancelled once when the deadline falls, and the call fails as request-timeout', async () => {
    const names = stalledNames();
    const startedAt = Date.now();

    const error = await refusal(guard(names.factory)(stalled, { timeoutMs: 300, maxBytes: 4096 }));

    const elapsed = Date.now() - startedAt;
    expect(error.reason).toBe('request-timeout');
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(3000);
    expect(names.log).toEqual(['resolver for 300 ms', 'cancel']);
  });

  it('is cancelled for every one of eight calls, and a lookup of localhost stays fast meanwhile', async () => {
    const names = stalledNames();
    const calls = Array.from({ length: 8 }, () =>
      refusal(guard(names.factory)(stalled, { timeoutMs: 1000, maxBytes: 4096 })),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    const probeStartedAt = Date.now();
    await dns.promises.lookup('localhost');
    const probe = Date.now() - probeStartedAt;
    const errors = await Promise.all(calls);

    expect(probe).toBeLessThan(1000);
    expect(errors.map((error) => error.reason)).toEqual(Array(8).fill('request-timeout'));
    expect(names.log.filter((line) => line === 'cancel')).toHaveLength(8);
  });
});

describe('the default name resolver, against a nameserver that never answers', () => {
  let blackhole: dgram.Socket;
  let questions = 0;
  let servers: string[];

  beforeAll(async () => {
    blackhole = dgram.createSocket('udp4');
    blackhole.on('message', () => {
      questions += 1;
    });
    await new Promise<void>((resolve) => blackhole.bind(0, '127.0.0.1', resolve));
    servers = [`127.0.0.1:${blackhole.address().port}`];
  });

  afterAll(() => {
    blackhole.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const guard = () =>
    createGuardedGetForTest({ resolver: dnsResolver(servers), isBlocked: () => false });

  it('ends each call at its own deadline, and a lookup of localhost is not held up behind them', async () => {
    const asked = questions;
    const startedAt = Date.now();
    const calls = Array.from({ length: 8 }, (_unused, i) =>
      refusal(guard()(new URL(`https://slow${i}.test/`), { timeoutMs: 1000, maxBytes: 4096 })),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    const probeStartedAt = Date.now();
    await dns.promises.lookup('localhost');
    const probe = Date.now() - probeStartedAt;
    const errors = await Promise.all(calls);

    expect(probe).toBeLessThan(1000);
    expect(errors.map((error) => error.reason)).toEqual(Array(8).fill('request-timeout'));
    expect(Date.now() - startedAt).toBeLessThan(2500);
    expect(questions - asked).toBeGreaterThanOrEqual(8);
  });

  it('never calls dns.lookup or dns.promises.lookup', async () => {
    const lookup = vi.spyOn(dns, 'lookup');
    const promisesLookup = vi.spyOn(dns.promises, 'lookup');

    await refusal(guard()(new URL('https://slow.test/'), { timeoutMs: 300, maxBytes: 4096 }));

    expect(lookup).not.toHaveBeenCalled();
    expect(promisesLookup).not.toHaveBeenCalled();
  });
});

describe('the default name resolver, as c-ares answers it', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is built for the call: the deadline of the call is its timeout, with one try', () => {
    const { Resolver } = mockCares({});
    vi.spyOn(dns, 'getServers').mockReturnValue(['192.0.2.53']);

    dnsResolver()(1500);

    expect(Resolver).toHaveBeenCalledTimes(1);
    expect(Resolver).toHaveBeenCalledWith({ timeout: 1500, tries: 1 });
  });

  it('splits the deadline across the system nameservers, so a dead first one leaves time for the next', () => {
    const { Resolver } = mockCares({});
    vi.spyOn(dns, 'getServers').mockReturnValue(['192.0.2.53', '192.0.2.54', '192.0.2.55']);

    dnsResolver()(1500);

    expect(Resolver).toHaveBeenCalledWith({ timeout: 500, tries: 1 });
  });

  it('splits the deadline across the nameservers it is given', () => {
    const { Resolver } = mockCares({});

    dnsResolver(['127.0.0.1:5353', '127.0.0.1:5354'])(1000);

    expect(Resolver).toHaveBeenCalledWith({ timeout: 500, tries: 1 });
  });

  it('asks for the A and the AAAA records of the name at the same time', async () => {
    const { cares } = mockCares({});
    let release!: () => void;
    const sixAsked = new Promise<void>((resolve) => {
      release = resolve;
    });
    cares.resolve4.mockImplementation(async () => {
      await sixAsked;
      return ['93.184.216.34'];
    });
    cares.resolve6.mockImplementation(async () => {
      release();
      return [];
    });

    const found = await dnsResolver()(2000).resolve('names.test');

    expect(found).toEqual([{ address: '93.184.216.34', family: 4 }]);
    expect(cares.resolve4).toHaveBeenCalledWith('names.test');
    expect(cares.resolve6).toHaveBeenCalledWith('names.test');
  });

  it('combines both answers, the IPv4 addresses first, each with its family', async () => {
    mockCares({ a: ['93.184.216.34', '93.184.216.35'], aaaa: ['2606:2800:220:1::1'] });

    const found = await dnsResolver()(2000).resolve('names.test');

    expect(found).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '93.184.216.35', family: 4 },
      { address: '2606:2800:220:1::1', family: 6 },
    ]);
  });

  it.each([
    [
      'IPv6 only: the name has no A record',
      { a: caresError('ENODATA'), aaaa: ['2606:2800:220:1::1'] },
    ],
    [
      'IPv4 only: the name has no AAAA record',
      { a: ['93.184.216.34'], aaaa: caresError('ENODATA') },
    ],
    ['IPv4 only: the AAAA query timed out', { a: ['93.184.216.34'], aaaa: caresError('ETIMEOUT') }],
  ])('still answers when one family fails: %s', async (_name, over) => {
    mockCares(over);

    const found = await dnsResolver()(2000).resolve('names.test');

    expect(found).toHaveLength(1);
  });

  it.each([
    ['both are not found', caresError('ENOTFOUND'), caresError('ENOTFOUND')],
    ['both have no data', caresError('ENODATA'), caresError('ENODATA')],
    ['both time out', caresError('ETIMEOUT'), caresError('ETIMEOUT')],
    ['both are cancelled', caresError('ECANCELLED'), caresError('ECANCELLED')],
    ['one has no data and one is refused', caresError('ENODATA'), caresError('EREFUSED')],
  ])('is not found only when both families fail: %s', async (_name, a, aaaa) => {
    mockCares({ a, aaaa });

    const failure = await dnsResolver()(2000)
      .resolve('names.test')
      .then(
        () => null,
        (err: NodeJS.ErrnoException) => err,
      );

    expect(failure?.code).toBe('ENOTFOUND');
    expect((failure?.cause as NodeJS.ErrnoException).code).toBe(a.code);
  });

  it('is not found for an answer with no address in it', async () => {
    mockCares({});

    const failure = await dnsResolver()(2000)
      .resolve('names.test')
      .then(
        () => null,
        (err: NodeJS.ErrnoException) => err,
      );

    expect(failure?.code).toBe('ENOTFOUND');
  });

  it('cancels the c-ares resolver of the call, and nothing else', () => {
    const { cares } = mockCares({});
    const names = dnsResolver()(2000);

    names.cancel();

    expect(cares.cancel).toHaveBeenCalledTimes(1);
  });

  it('points the resolver at nameservers only when it is given some', () => {
    const { cares } = mockCares({});

    dnsResolver()(2000);
    expect(cares.setServers).not.toHaveBeenCalled();
    dnsResolver(['127.0.0.1:5353'])(2000);

    expect(cares.setServers).toHaveBeenCalledWith(['127.0.0.1:5353']);
  });
});

describe('the production entry point', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('takes a deadline and a cap, and nothing a test would replace', () => {
    expectTypeOf<Parameters<typeof guardedGet>[1]>().toEqualTypeOf<{
      timeoutMs: number;
      maxBytes: number;
    }>();
  });

  it('looks the name up through c-ares with the deadline of the call, and refuses a loopback answer', async () => {
    const { cares, Resolver } = mockCares({ a: ['127.0.0.1'] });
    vi.spyOn(dns, 'getServers').mockReturnValue(['192.0.2.53']);
    const lookup = vi.spyOn(dns, 'lookup');
    const promisesLookup = vi.spyOn(dns.promises, 'lookup');

    const error = await refusal(
      guardedGet(new URL('https://prod.test/'), { timeoutMs: 1500, maxBytes: 4096 }),
    );

    expect(error.reason).toBe('blocked-address');
    expect(Resolver).toHaveBeenCalledWith({ timeout: 1500, tries: 1 });
    expect(cares.resolve4).toHaveBeenCalledWith('prod.test');
    expect(cares.cancel).toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(promisesLookup).not.toHaveBeenCalled();
  });

  it.each([
    ['request-timeout', dns.TIMEOUT],
    ['request-failed', 'ENOTFOUND'],
    ['request-failed', 'ESERVFAIL'],
  ])('reports %s when both families of a name fail with %s', async (reason, code) => {
    const first = caresError(code);
    mockCares({ a: first, aaaa: caresError(code) });

    const error = await refusal(
      guardedGet(new URL('https://prod.test/'), { timeoutMs: 1500, maxBytes: 4096 }),
    );

    expect(error.reason).toBe(reason);
    expect((error.cause as Error).cause).toBe(first);
  });

  it.each([
    ['A answers at once, AAAA times out', 'ENODATA', dns.TIMEOUT],
    ['AAAA answers at once, A times out', dns.TIMEOUT, 'ENODATA'],
  ])('reports request-timeout when %s', async (_name, a, aaaa) => {
    mockCares({ a: caresError(a), aaaa: caresError(aaaa) });

    const error = await refusal(
      guardedGet(new URL('https://prod.test/'), { timeoutMs: 1500, maxBytes: 4096 }),
    );

    expect(error.reason).toBe('request-timeout');
  });

  it('ignores a classifier, a resolver or a CA slipped in through its options', async () => {
    mockCares({ a: ['127.0.0.1'] });
    const slipped = {
      timeoutMs: 1500,
      maxBytes: 4096,
      isBlocked: () => false,
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      resolver: fixed(async () => [{ address: '93.184.216.34', family: 4 }]),
    } as GuardedGetOptions;

    const error = await refusal(guardedGet(new URL('https://prod.test/'), slipped));

    expect(error.reason).toBe('blocked-address');
  });
});
