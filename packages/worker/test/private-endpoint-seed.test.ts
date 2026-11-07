import dns from 'node:dns';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_ALLOWLIST_BYTES,
  MAX_ALLOWLIST_ENTRIES,
  isBlockedAddress,
  validateAllowlist,
  type Resolver,
} from '@haive/shared/egress';
import { dsnDialHost } from '@haive/shared/rag';
import { planPrivateEndpointSeed, seedHostOfUrl } from '../src/private-endpoint-seed.js';

type Answers = Record<string, string[] | Error>;

const answer = (address: string): dns.LookupAddress => ({
  address,
  family: address.includes(':') ? 6 : 4,
});

const resolverOf =
  (table: Answers): Resolver =>
  async (host) => {
    const found = table[host];
    if (found === undefined) throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
    if (found instanceof Error) throw found;
    return found.map(answer);
  };

const plan = (hosts: string[], dnsTable: Answers = {}, systemTable: Answers = {}) =>
  planPrivateEndpointSeed(hosts, {
    resolvers: { dns: resolverOf(dnsTable), system: resolverOf(systemTable) },
  });

afterEach(() => vi.useRealTimers());

describe('planPrivateEndpointSeed names answered by dns', () => {
  it.each([
    ['10.1.2.3'],
    ['172.16.5.5'],
    ['192.168.1.9'],
    ['100.64.3.3'],
    ['fd12:3456::1'],
    ['::ffff:10.0.0.7'],
  ])('seeds a name that resolves to private %s', async (address) => {
    const result = await plan(['svc.lan'], { 'svc.lan': [address] });
    expect(result).toEqual({ entries: ['svc.lan'], skipped: [], dropped: 0 });
  });

  it('skips a public name', async () => {
    const result = await plan(['example.com'], { 'example.com': ['93.184.216.34'] });
    expect(result.entries).toEqual([]);
    expect(result.skipped).toEqual([{ host: 'example.com', reason: 'public' }]);
  });

  it.each([
    ['loopback v4', '127.0.0.1'],
    ['loopback v6', '::1'],
    ['link-local v4', '169.254.10.10'],
    ['link-local v6', 'fe80::1'],
    ['unspecified', '0.0.0.0'],
    ['metadata v4', '100.100.100.200'],
    ['metadata v6', 'fd00:ec2::254'],
    ['mapped loopback', '::ffff:127.0.0.1'],
    ['mapped metadata', '::ffff:100.100.100.200'],
  ])('never seeds a name that resolves to %s', async (_label, address) => {
    const result = await plan(['svc.lan'], { 'svc.lan': [address] });
    expect(result.entries).toEqual([]);
    expect(result.skipped).toEqual([{ host: 'svc.lan', reason: 'not-seedable' }]);
  });

  it('seeds a name with a public and a private answer', async () => {
    const result = await plan(['mix.lan'], { 'mix.lan': ['93.184.216.34', '10.0.0.5'] });
    expect(result.entries).toEqual(['mix.lan']);
  });

  it('refuses a name with a private and a loopback answer', async () => {
    const result = await plan(['mix.lan'], { 'mix.lan': ['10.0.0.5', '127.0.0.1'] });
    expect(result.skipped).toEqual([{ host: 'mix.lan', reason: 'not-seedable' }]);
  });
});

describe('planPrivateEndpointSeed names only the hosts file knows', () => {
  it('uses the system answer when dns fails', async () => {
    const result = await plan(['a.lan'], { 'a.lan': new Error('boom') }, { 'a.lan': ['10.9.9.9'] });
    expect(result.entries).toEqual(['a.lan']);
  });

  it('uses the system answer when dns answers nothing', async () => {
    const result = await plan(['a.lan'], { 'a.lan': [] }, { 'a.lan': ['10.9.9.9'] });
    expect(result.entries).toEqual(['a.lan']);
  });

  it('seeds a system answer that is public, since the name needs the entry whatever it maps to', async () => {
    const result = await plan(['a.lan'], {}, { 'a.lan': ['93.184.216.34'] });
    expect(result.entries).toEqual(['a.lan']);
  });

  it('refuses a system answer that is loopback', async () => {
    const result = await plan(['a.lan'], {}, { 'a.lan': ['127.0.0.1'] });
    expect(result.skipped).toEqual([{ host: 'a.lan', reason: 'not-seedable' }]);
  });

  it('counts a name neither resolver knows as unresolved', async () => {
    const result = await plan(['gone.lan']);
    expect(result.skipped).toEqual([{ host: 'gone.lan', reason: 'unresolved' }]);
  });

  it('does not ask the system resolver when dns answered', async () => {
    const system = vi.fn<Resolver>();
    await planPrivateEndpointSeed(['a.lan'], {
      resolvers: { dns: resolverOf({ 'a.lan': ['10.0.0.1'] }), system },
    });
    expect(system).not.toHaveBeenCalled();
  });
});

describe('planPrivateEndpointSeed IP literals', () => {
  it.each(['10.1.1.1', '172.20.0.4', '192.168.0.2', '100.64.0.9', 'fd00::5', '::ffff:192.168.1.1'])(
    'seeds the private literal %s as an address entry',
    async (literal) => {
      const result = await plan([literal]);
      expect(result.entries).toEqual([literal]);
    },
  );

  it('skips a public literal', async () => {
    expect((await plan(['8.8.8.8'])).skipped).toEqual([{ host: '8.8.8.8', reason: 'public' }]);
  });

  it.each([
    '127.0.0.1',
    '::1',
    '169.254.169.254',
    'fe80::1',
    '0.0.0.0',
    '100.100.100.200',
    'fd00:ec2::254',
  ])('never seeds the literal %s', async (literal) => {
    const result = await plan([literal]);
    expect(result.entries).toEqual([]);
    expect(result.skipped).toEqual([{ host: literal, reason: 'not-seedable' }]);
  });
});

describe('planPrivateEndpointSeed normalization and validity', () => {
  it('lowercases, trims, strips brackets and one trailing dot, and dedupes', async () => {
    const result = await plan(['  SVC.Lan ', 'svc.lan.', '[FD00::5]', 'fd00::5', 'svc.lan'], {
      'svc.lan': ['10.0.0.1'],
    });
    expect(result.entries).toEqual(['fd00::5', 'svc.lan']);
    expect(result.skipped).toEqual([]);
  });

  it.each([
    [''],
    ['   '],
    ['not a host'],
    ['a,b'],
    ['a\nb'],
    ['10.0.0.0/8'],
    ['bad_name.lan'],
    ['['],
    ['10'],
  ])('skips %j as invalid', async (host) => {
    const result = await plan([host]);
    expect(result.entries).toEqual([]);
    expect(result.skipped.map((skip) => skip.reason)).toEqual(['invalid']);
  });

  it('sorts the entries', async () => {
    const result = await plan(['b.lan', 'a.lan', '10.0.0.1'], {
      'a.lan': ['10.0.0.2'],
      'b.lan': ['10.0.0.3'],
    });
    expect(result.entries).toEqual(['10.0.0.1', 'a.lan', 'b.lan']);
  });

  it('produces text the allowlist validator accepts', async () => {
    const result = await plan(['svc.lan', '10.0.0.1', '[fd00::9]', 'Host.Two.'], {
      'svc.lan': ['10.0.0.1'],
      'host.two': ['192.168.0.1'],
    });
    const verdict = validateAllowlist(result.entries.join('\n'));
    expect(verdict).toEqual({ ok: true, entries: result.entries.length });
  });
});

describe('planPrivateEndpointSeed caps', () => {
  it('keeps at most the entry cap and counts the rest as dropped', async () => {
    const extra = 5;
    const hosts = Array.from(
      { length: MAX_ALLOWLIST_ENTRIES + extra },
      (_, i) => `10.${Math.floor(i / 250)}.${i % 250}.1`,
    );
    const result = await plan(hosts);
    expect(result.entries).toHaveLength(MAX_ALLOWLIST_ENTRIES);
    expect(result.dropped).toBe(extra);
    expect(validateAllowlist(result.entries.join('\n')).ok).toBe(true);
  });

  it('keeps the joined text within the byte cap and counts the rest as dropped', async () => {
    const label = 'a'.repeat(60);
    const hosts = Array.from(
      { length: 200 },
      (_, i) => `${label}.h${String(i).padStart(3, '0')}.${label}.lan`,
    );
    const table: Answers = Object.fromEntries(hosts.map((host) => [host, ['10.0.0.1']]));
    const result = await plan(hosts, table);
    const text = result.entries.join('\n');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_ALLOWLIST_BYTES);
    expect(result.entries.length).toBeLessThan(200);
    expect(result.entries.length + result.dropped).toBe(200);
    expect(validateAllowlist(text).ok).toBe(true);
  });
});

describe('planPrivateEndpointSeed bounds', () => {
  it('gives up on a resolver that never settles at the deadline and leaves no timer behind', async () => {
    vi.useFakeTimers();
    const never: Resolver = () => new Promise(() => {});
    const pending = planPrivateEndpointSeed(['hang.lan', '10.0.0.1'], {
      resolvers: { dns: never, system: never },
      lookupTimeoutMs: 60_000,
      deadlineMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(result.entries).toEqual(['10.0.0.1']);
    expect(result.skipped).toEqual([{ host: 'hang.lan', reason: 'unresolved' }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores an answer that arrives after the deadline', async () => {
    vi.useFakeTimers();
    const late: Resolver = () =>
      new Promise((resolve) => setTimeout(() => resolve([answer('10.0.0.9')]), 5000));
    const pending = planPrivateEndpointSeed(['late.lan'], {
      resolvers: { dns: late, system: resolverOf({}) },
      lookupTimeoutMs: 60_000,
      deadlineMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await pending).skipped).toEqual([{ host: 'late.lan', reason: 'unresolved' }]);
  });

  it('times out one slow lookup and falls back to the system resolver', async () => {
    vi.useFakeTimers();
    const never: Resolver = () => new Promise(() => {});
    const pending = planPrivateEndpointSeed(['slow.lan'], {
      resolvers: { dns: never, system: resolverOf({ 'slow.lan': ['10.0.0.4'] }) },
      lookupTimeoutMs: 500,
      deadlineMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(500);
    expect((await pending).entries).toEqual(['slow.lan']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runs at most `concurrency` lookups at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const counting: Resolver = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return [answer('10.0.0.1')];
    };
    const hosts = Array.from({ length: 12 }, (_, i) => `h${i}.lan`);
    const result = await planPrivateEndpointSeed(hosts, {
      resolvers: { dns: counting, system: counting },
      concurrency: 3,
    });
    expect(result.entries).toHaveLength(12);
    expect(peak).toBe(3);
  });
});

describe('the seedable set', () => {
  it('only ever names addresses the guard blocks', async () => {
    const probes = [
      '10.0.0.0',
      '10.255.255.255',
      '172.16.0.0',
      '172.31.255.255',
      '192.168.0.0',
      '192.168.255.255',
      '100.64.0.0',
      '100.127.255.255',
      'fc00::',
      'fdff:ffff::1',
      '::ffff:10.1.1.1',
    ];
    for (const address of probes) {
      expect(isBlockedAddress(address)).toBe(true);
      expect((await plan([address])).entries).toEqual([address]);
    }
    for (const address of ['172.32.0.1', '100.128.0.1', '11.0.0.1', '192.169.0.1', 'fe00::1']) {
      expect((await plan([address])).entries).toEqual([]);
    }
  });
});

describe('seedHostOfUrl', () => {
  it.each([
    ['http://host.docker.internal:11434', null],
    ['http://host.docker.internal:11434/api/tags', null],
    ['http://host.docker.internal:11435', 'host.docker.internal'],
    ['https://host.docker.internal:11434', 'host.docker.internal'],
    ['http://ollama:11434', null],
    ['http://haive-ollama:11434', null],
    ['http://OLLAMA:11434', null],
    ['http://ollama.:11434', 'ollama'],
    ['http://user@evil.lan/', 'evil.lan'],
    ['http://ollama@evil.lan:11434', 'evil.lan'],
    ['http://Svc.Lan.:8080/x', 'svc.lan'],
    ['http://[FD00::5]:11434', 'fd00::5'],
    ['http://10.0.0.5:11434', '10.0.0.5'],
    ['ftp://svc.lan', null],
    ['file:///etc/passwd', null],
    ['not a url', null],
    ['', null],
  ])('%s -> %j', (url, expected) => {
    expect(seedHostOfUrl(url)).toBe(expected);
  });
});

describe('a stored DSN host reaches the planner as the dial reads it', () => {
  it('hands an encoded socket path on as a name the planner refuses as invalid', async () => {
    const host = dsnDialHost('postgres://u@%2Fvar%2Frun%2Fpostgresql/rag');
    expect((await plan([host!])).skipped.map((skip) => skip.reason)).toEqual(['invalid']);
  });

  it('skips the bracketed form as an invalid name', async () => {
    const result = await plan([dsnDialHost('postgres://u:p@[fd00::5]:5432/rag')!]);
    expect(result.skipped.map((skip) => skip.reason)).toEqual(['invalid']);
  });
});
