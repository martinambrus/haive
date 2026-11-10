import { expect, it, vi } from 'vitest';
import { resolveGuardedAddress } from '../src/egress/probe-egress.js';
import { EMPTY, parseAllowlist } from '../src/egress/allowlist.js';
import { ConfigUnavailableError } from '../src/config/index.js';

it('public-only answers do not read the allowlist, and resolve once', async () => {
  const resolve = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
  const privateAllowlist = vi.fn(() => {
    throw new Error('must not read');
  });
  expect(await resolveGuardedAddress('public.test', { resolve, privateAllowlist })).toEqual([
    '93.184.216.34',
  ]);
  expect(resolve).toHaveBeenCalledExactlyOnceWith('public.test');
  expect(privateAllowlist).not.toHaveBeenCalled();
});
it('classifies literals without DNS and accepts bracketed IPv6', async () => {
  const resolve = vi.fn();
  const privateAllowlist = () => EMPTY;
  expect(await resolveGuardedAddress('[2606:4700:4700::1111]', { resolve })).toEqual([
    '2606:4700:4700::1111',
  ]);
  await expect(
    resolveGuardedAddress('127.0.0.1', { resolve, privateAllowlist }),
  ).rejects.toMatchObject({ code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: '127.0.0.1' });
  expect(resolve).not.toHaveBeenCalled();
});
it('refuses mixed answers before selecting a public address', async () => {
  const privateAllowlist = vi.fn(() => EMPTY);
  await expect(
    resolveGuardedAddress('mixed.test', {
      resolve: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ],
      privateAllowlist,
    }),
  ).rejects.toMatchObject({ code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: 'mixed.test' });
  expect(privateAllowlist).toHaveBeenCalledTimes(1);
});
it.each(['internal.test', '10.0.0.0/8'])('lifts private answers through %s', async (entry) => {
  expect(
    await resolveGuardedAddress('internal.test', {
      resolve: async () => [{ address: '10.1.2.3', family: 4 }],
      privateAllowlist: () => parseAllowlist(entry),
    }),
  ).toEqual(['10.1.2.3']);
});
it('returns the same error for a refused and a missing name', async () => {
  const privateAllowlist = () => EMPTY;
  const refused = await resolveGuardedAddress('target.test', {
    resolve: async () => [{ address: '10.1.2.3', family: 4 }],
    privateAllowlist,
  }).catch((e) => e);
  const missing = await resolveGuardedAddress('target.test', {
    resolve: async () => {
      throw Object.assign(new Error('different DNS text'), { code: 'ENOTFOUND' });
    },
    privateAllowlist,
  }).catch((e) => e);
  expect(refused).toEqual(missing);
});
it('propagates a configuration outage without dialing', async () => {
  const outage = new ConfigUnavailableError('get');
  await expect(
    resolveGuardedAddress('127.0.0.1', {
      privateAllowlist: () => {
        throw outage;
      },
    }),
  ).rejects.toBe(outage);
});

it('returns every checked public address for transport failover', async () => {
  expect(
    await resolveGuardedAddress('public.test', {
      resolve: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:4700:4700::1111', family: 6 },
      ],
    }),
  ).toEqual(['93.184.216.34', '2606:4700:4700::1111']);
});
