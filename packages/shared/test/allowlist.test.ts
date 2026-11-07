import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIG_KEYS, ConfigUnavailableError, configService } from '../src/config/index.js';
import {
  EMPTY,
  loadAllowlist,
  parseAllowlist,
  validateAllowlist,
} from '../src/egress/allowlist.js';

afterEach(() => vi.restoreAllMocks());

const long = (n: number) => 'a'.repeat(n);

describe('allowlist grammar', () => {
  it.each([
    '10.0.0.1',
    '::1',
    '[::1]',
    '10.0.0.0/8',
    '10.0.0.0/32',
    'fd00::/8',
    '[fd00::]/128',
    'db',
    'db.internal',
    'DB.Internal.',
    'a-b.c1.example',
    `${long(63)}.example`,
  ])('accepts %s', (entry) => {
    expect(validateAllowlist(entry)).toEqual({ ok: true, entries: 1 });
    expect(parseAllowlist(entry).invalid).toEqual([]);
  });

  it.each([
    '10.0.0.0/0',
    '::/0',
    '10.0.0.0/33',
    'fd00::/129',
    '10.0.0.0/x',
    '10.0.0.0/',
    '999.1.1.1',
    '10',
    '1.2.3',
    '*.example.com',
    'db:5432',
    'http://db',
    'db/path',
    'user@db',
    'db..internal',
    '-db',
    'db-',
    'a_b',
    `${long(64)}.example`,
    `${long(60)}.${long(60)}.${long(60)}.${long(60)}.${long(60)}`,
    '..',
  ])('rejects %s', (entry) => {
    const result = validateAllowlist(entry);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.entry).toBe(entry);
    expect(parseAllowlist(entry).invalid).toEqual([entry]);
  });

  it('splits on newlines and commas, trims and ignores blanks', () => {
    const raw = ' 10.0.0.1 ,\n\n db.internal\r\n,, 172.16.0.0/12 ';
    expect(validateAllowlist(raw)).toEqual({ ok: true, entries: 3 });
    const parsed = parseAllowlist(raw);
    expect([...parsed.hosts]).toEqual(['db.internal']);
    expect(parsed.matches('10.0.0.1')).toBe(true);
    expect(parsed.matches('172.20.1.1')).toBe(true);
    expect(parsed.matches('10.0.0.2')).toBe(false);
  });

  it('skips invalid entries, keeps the valid ones and records the invalid', () => {
    const parsed = parseAllowlist('10.0.0.1\nbad entry\n10.0.0.0/0');
    expect(parsed.invalid).toEqual(['bad entry', '10.0.0.0/0']);
    expect(parsed.matches('10.0.0.1')).toBe(true);
  });

  it('treats empty, blank and missing input as empty', () => {
    for (const raw of ['', '  \n ', null, undefined]) {
      expect(parseAllowlist(raw)).toBe(EMPTY);
      expect(validateAllowlist(raw)).toEqual({ ok: true, entries: 0 });
    }
    expect(EMPTY.matches('127.0.0.1')).toBe(false);
  });
});

describe('allowlist caps', () => {
  it('validate rejects more than 256 entries and parse takes the first 256', () => {
    const raw = Array.from({ length: 257 }, (_, i) => `h${i}.test`).join('\n');
    expect(validateAllowlist(raw).ok).toBe(false);
    const parsed = parseAllowlist(raw);
    expect(parsed.hosts.size).toBe(256);
    expect(parsed.hosts.has('h256.test')).toBe(false);
    expect(parsed.hosts.has('h0.test')).toBe(true);
  });

  it('accepts exactly 256 entries', () => {
    const raw = Array.from({ length: 256 }, (_, i) => `h${i}.test`).join('\n');
    expect(validateAllowlist(raw)).toEqual({ ok: true, entries: 256 });
  });

  it('validate rejects over 16 KiB and parse keeps only whole entries that fit', () => {
    const filler = Array.from({ length: 1500 }, (_, i) => `10.${i % 250}.0.0/16`).join('\n');
    const raw = `${filler}\n${'z'.repeat(60)}.test`;
    expect(Buffer.byteLength(raw)).toBeGreaterThan(16 * 1024);
    expect(validateAllowlist(raw).ok).toBe(false);
    const parsed = parseAllowlist(raw);
    expect(parsed.hosts.size).toBe(0);
    expect(parsed.invalid).toEqual([]);
  });
});

describe('allowlist address matching', () => {
  it('an IPv4 rule also matches the IPv4-mapped form', () => {
    const parsed = parseAllowlist('10.0.0.0/8\n192.168.1.5');
    expect(parsed.matches('10.1.2.3')).toBe(true);
    expect(parsed.matches('::ffff:10.1.2.3')).toBe(true);
    expect(parsed.matches('::ffff:192.168.1.5')).toBe(true);
    expect(parsed.matches('::ffff:192.168.1.6')).toBe(false);
  });

  it('NAT64 and 6to4 embeddings of a listed IPv4 address stay unmatched', () => {
    const parsed = parseAllowlist('10.0.0.1');
    expect(parsed.matches('64:ff9b::a00:1')).toBe(false);
    expect(parsed.matches('2002:a00:1::')).toBe(false);
  });

  it('matches IPv6 rules and rejects non-addresses', () => {
    const parsed = parseAllowlist('fd00::/8');
    expect(parsed.matches('fd12::1')).toBe(true);
    expect(parsed.matches('fe80::1')).toBe(false);
    expect(parsed.matches('not-an-ip')).toBe(false);
  });
});

describe('allowlist byte cap boundary', () => {
  const padded = (bytes: number) =>
    Array.from({ length: 100 }, (_, i) => `h${i}.internal`)
      .join('\n')
      .padEnd(bytes, ' ');

  it('accepts exactly 16384 bytes of valid entries', () => {
    const raw = padded(16384);
    expect(Buffer.byteLength(raw)).toBe(16384);
    expect(validateAllowlist(raw)).toEqual({ ok: true, entries: 100 });
  });

  it('refuses 16385 bytes', () => {
    const raw = padded(16385);
    expect(Buffer.byteLength(raw)).toBe(16385);
    expect(validateAllowlist(raw)).toMatchObject({ ok: false, entry: '' });
  });
});

describe('allowlist memoisation and loading', () => {
  it('returns the same parse for the same raw string', () => {
    const a = parseAllowlist('10.9.9.9');
    expect(parseAllowlist('10.9.9.9')).toBe(a);
    expect(parseAllowlist('10.9.9.8')).not.toBe(a);
  });

  it('loads the configured list through the config service', async () => {
    const get = vi.spyOn(configService, 'get').mockResolvedValue('db.internal\n10.0.0.0/8');
    const parsed = await loadAllowlist();
    expect(get).toHaveBeenCalledWith(CONFIG_KEYS.PRIVATE_ENDPOINT_ALLOWLIST);
    expect(parsed.hosts.has('db.internal')).toBe(true);
    expect(parsed.matches('10.1.1.1')).toBe(true);
  });

  it('rejects with the very error a config outage raised', async () => {
    const outage = new ConfigUnavailableError('get');
    vi.spyOn(configService, 'get').mockRejectedValue(outage);
    await expect(loadAllowlist()).rejects.toBe(outage);
  });

  it('answers empty for an unset key', async () => {
    vi.spyOn(configService, 'get').mockResolvedValue(null);
    await expect(loadAllowlist()).resolves.toBe(EMPTY);
  });
});
