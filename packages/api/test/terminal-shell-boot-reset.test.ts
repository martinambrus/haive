import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TERMINAL_IDLE_GRACE_MS, TERMINAL_SESSION_PREFIX } from '@haive/shared';

const h = vi.hoisted(() => ({ store: new Map<string, Record<string, string>>() }));

vi.mock('../src/redis.js', () => ({
  getRedis: () => ({
    scan: async () => ['0', [...h.store.keys()]],
    hget: async (key: string, field: string) => h.store.get(key)?.[field] ?? null,
    hset: async (key: string, ...pairs: string[]) => {
      const entry = h.store.get(key) ?? {};
      for (let i = 0; i < pairs.length; i += 2) entry[pairs[i]!] = pairs[i + 1]!;
      h.store.set(key, entry);
      return pairs.length / 2;
    },
  }),
}));

import { resetStaleRefcounts } from '../src/routes/terminal-shell.js';

const HELD = `${TERMINAL_SESSION_PREFIX}u1:t1:p1`;
const IDLE = `${TERMINAL_SESSION_PREFIX}u2:t2:p2`;

beforeEach(() => {
  h.store.clear();
});

describe('api boot reset of the terminal shell registry', () => {
  it('gives a shell that had a socket attached a fresh grace, not the age of its last attach', async () => {
    const attachedLongAgo = String(Date.now() - 5 * TERMINAL_IDLE_GRACE_MS);
    h.store.set(HELD, {
      refcount: '2',
      lastSeenAt: attachedLongAgo,
      containerName: 'haive-shell-a',
    });
    const before = Date.now();

    await resetStaleRefcounts();

    const entry = h.store.get(HELD)!;
    expect(entry.refcount).toBe('0');
    expect(Number(entry.lastSeenAt)).toBeGreaterThanOrEqual(before);
    expect(entry.containerName).toBe('haive-shell-a');
  });

  it('leaves the age of a shell nobody held, so it still reaps on schedule', async () => {
    const idleSince = String(Date.now() - 5 * TERMINAL_IDLE_GRACE_MS);
    // A count below zero is the one way an unheld shell reaches the write: a release that raced.
    h.store.set(IDLE, { refcount: '-1', lastSeenAt: idleSince });

    await resetStaleRefcounts();

    expect(h.store.get(IDLE)).toEqual({ refcount: '0', lastSeenAt: idleSince });
  });
});
