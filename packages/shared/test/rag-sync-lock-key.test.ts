import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import {
  RagSyncLockTimeoutError,
  acquireRagSyncLock,
  ragSyncLockKey,
  tryAcquireRagSyncLock,
} from '../src/rag/sync-lock.js';

/** The two commands the lock sends, with SET NX and the owner-checked refresh and release. */
function fakeRedis() {
  const store = new Map<string, string>();
  const redis = {
    set: async (key: string, token: string) => {
      if (store.has(key)) return null;
      store.set(key, token);
      return 'OK';
    },
    eval: async (script: string, _keys: number, key: string, token: string) => {
      if (store.get(key) !== token) return 0;
      if (script.includes('DEL')) store.delete(key);
      return 1;
    },
  } as unknown as Redis;
  return { store, redis };
}

// PostgreSQL reads a uuid in any case, in braces and with the hyphens omitted, so a route can hand
// the lock the same repository in a spelling other than the printed one the worker's rows give.
function spellings(id: string): string[] {
  return [id.toUpperCase(), id.replaceAll('-', ''), `{${id}}`, `{${id.toUpperCase()}}`];
}

describe('RAG sync lock key', () => {
  it('is one key for every spelling of a repository id', () => {
    const repo = randomUUID();
    for (const spelled of spellings(repo)) {
      expect(spelled).not.toBe(repo);
      expect(ragSyncLockKey(spelled)).toBe(`haive:rag-sync:${repo}`);
    }
  });

  it('keeps the text a canonical id and a value that is not a uuid already keyed', () => {
    const repo = randomUUID();
    expect(ragSyncLockKey(repo)).toBe(`haive:rag-sync:${repo}`);
    expect(ragSyncLockKey('repo-1')).toBe('haive:rag-sync:repo-1');
  });

  it('excludes a second holder that spells the repository differently', async () => {
    const repo = randomUUID();
    for (const spelled of spellings(repo)) {
      const { store, redis } = fakeRedis();
      const held = await tryAcquireRagSyncLock(redis, spelled);
      expect(held).not.toBeNull();
      expect(await tryAcquireRagSyncLock(redis, repo)).toBeNull();
      await expect(acquireRagSyncLock(redis, repo, { waitMs: 0 })).rejects.toBeInstanceOf(
        RagSyncLockTimeoutError,
      );
      expect([...store.keys()]).toEqual([`haive:rag-sync:${repo}`]);
      await held!.release();
      expect(store.size).toBe(0);
      const next = await tryAcquireRagSyncLock(redis, repo);
      expect(next).not.toBeNull();
      await next!.release();
    }
  });
});
