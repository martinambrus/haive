// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest';
import { AttentionLease, ATTENTION_LEASE_KEY, ATTENTION_LEASE_MS } from './attention-lease';
beforeEach(() => localStorage.clear());
it('pins a bounded lease, arbitrates owners, expires, and releases only its own', () => {
  expect(ATTENTION_LEASE_MS).toBe(5000);
  let now = 0;
  const a = new AttentionLease(localStorage, 'a', () => now, 10);
  const b = new AttentionLease(localStorage, 'b', () => now, 10);
  expect(a.touch()).toBe(false);
  expect(a.touch()).toBe(true);
  expect(b.touch()).toBe(false);
  b.release();
  expect(a.touch()).toBe(true);
  now = 11;
  expect(b.touch()).toBe(false);
  expect(b.touch()).toBe(true);
  expect(a.touch()).toBe(false);
  b.release();
  expect(a.touch()).toBe(false);
  expect(a.touch()).toBe(true);
});
it('rejects unbounded future leases and recovers malformed storage on the next sample', () => {
  const a = new AttentionLease(localStorage, 'a', () => 0, 10);
  localStorage.setItem(ATTENTION_LEASE_KEY, JSON.stringify({ owner: 'b', until: 999 }));
  expect(a.touch()).toBe(false);
  expect(a.touch()).toBe(true);
  localStorage.setItem(ATTENTION_LEASE_KEY, 'invalid');
  expect(a.touch()).toBe(false);
  expect(a.touch()).toBe(true);
});
