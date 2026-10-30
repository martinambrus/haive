import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDE_IDLE_GRACE_MS, ideSessionKey } from '@haive/shared';

const h = vi.hoisted(() => ({ store: new Map<string, Record<string, string>>() }));

vi.mock('../src/db.js', () => ({ getDb: () => undefined }));
vi.mock('../src/queues.js', () => ({
  getIdeEnsureQueue: () => ({}),
  getIdeEnsureQueueEvents: () => ({}),
}));
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

import { resetStaleIdeRefcounts } from '../src/routes/ide.js';

const HELD = ideSessionKey('00000000-0000-4000-8000-0000000000c1');
const IDLE = ideSessionKey('00000000-0000-4000-8000-0000000000c2');

beforeEach(() => {
  h.store.clear();
});

describe('api boot reset of the editor registry', () => {
  it('gives an editor that had a socket attached a fresh grace, not the age of its last attach', async () => {
    const attachedLongAgo = String(Date.now() - 5 * IDE_IDLE_GRACE_MS);
    h.store.set(HELD, { refcount: '2', lastSeenAt: attachedLongAgo });
    const before = Date.now();

    await resetStaleIdeRefcounts();

    const entry = h.store.get(HELD)!;
    expect(entry.refcount).toBe('0');
    expect(Number(entry.lastSeenAt)).toBeGreaterThanOrEqual(before);
  });

  it('leaves the age of a session nobody held, so it still reaps on schedule', async () => {
    const idleSince = String(Date.now() - 5 * IDE_IDLE_GRACE_MS);
    h.store.set(IDLE, { refcount: '0', lastSeenAt: idleSince });

    await resetStaleIdeRefcounts();

    expect(h.store.get(IDLE)).toEqual({ refcount: '0', lastSeenAt: idleSince });
  });
});
