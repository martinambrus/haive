import { describe, expect, it } from 'vitest';
import {
  addressBucket,
  normalizeAddress,
  parseTrustedProxies,
  resolveClientAddress,
} from '../src/lib/auth-throttle.js';

describe('normalizeAddress', () => {
  it('strips a zone and an IPv4-mapped prefix', () => {
    expect(normalizeAddress('::ffff:10.0.0.1')).toBe('10.0.0.1');
    expect(normalizeAddress('fe80::1%eth0')).toBe('fe80::1');
    expect(normalizeAddress('2001:db8::1')).toBe('2001:db8::1');
  });
});

describe('addressBucket', () => {
  it('keeps IPv4 and cuts IPv6 to four hextets', () => {
    expect(addressBucket('203.0.113.9')).toBe('203.0.113.9');
    expect(addressBucket('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2');
    expect(addressBucket('2001:0db8::1')).toBe('2001:db8:0:0');
    expect(addressBucket('::1')).toBe('0:0:0:0');
    expect(addressBucket('2001:db8:0:0:0:0:0:1')).toBe('2001:db8:0:0');
  });
});

describe('resolveClientAddress', () => {
  const list = parseTrustedProxies('10.0.0.0/8, 192.0.2.1, bogus, 10.0.0.0/99');

  it('ignores the header from an untrusted peer', () => {
    expect(resolveClientAddress('198.51.100.4', '203.0.113.5', list)).toBe('198.51.100.4');
  });
  it('skips trusted hops from the right', () => {
    expect(resolveClientAddress('10.1.1.1', '1.1.1.1, 203.0.113.9, 10.9.9.9', list)).toBe(
      '203.0.113.9',
    );
  });
  it('falls back to the peer for a bad or all-trusted chain', () => {
    expect(resolveClientAddress('10.1.1.1', 'nope', list)).toBe('10.1.1.1');
    expect(resolveClientAddress('10.1.1.1', '10.2.2.2, 10.3.3.3', list)).toBe('10.1.1.1');
  });
  it('matches a mapped peer against IPv4 rules and returns undefined without a peer', () => {
    expect(resolveClientAddress('::ffff:10.1.1.1', '203.0.113.9', list)).toBe('203.0.113.9');
    expect(resolveClientAddress(undefined, '203.0.113.9', list)).toBeUndefined();
  });
});
