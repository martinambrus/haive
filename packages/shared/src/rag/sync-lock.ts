import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { logger } from '../logger/index.js';

const log = logger.child({ module: 'rag-sync-lock' });

/** Backstop for a holder whose process died: the key frees this long after its last beat. */
const LOCK_TTL_MS = 120_000;
const HEARTBEAT_MS = 30_000;
const POLL_MS = 5_000;

const REFRESH_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export class RagSyncLockAbortedError extends Error {
  constructor() {
    super('RAG sync lock wait aborted');
    this.name = 'RagSyncLockAbortedError';
  }
}

export class RagSyncLockTimeoutError extends Error {
  constructor(waitedMs: number) {
    super(
      `another RAG sync of this repository did not finish within ${Math.round(waitedMs / 1000)}s`,
    );
    this.name = 'RagSyncLockTimeoutError';
  }
}

export interface RagSyncLock {
  /** True once a heartbeat found the key gone or owned by another holder. */
  readonly lost: boolean;
  /** Idempotent; stops the heartbeat and deletes the key only while this holder still owns it. */
  release(): Promise<void>;
}

export interface RagSyncLockTuning {
  ttlMs?: number;
  heartbeatMs?: number;
}

export interface AcquireRagSyncLockOptions extends RagSyncLockTuning {
  /** How long to wait for the current holder before throwing RagSyncLockTimeoutError. */
  waitMs: number;
  pollMs?: number;
  signal?: AbortSignal;
  onWait?: () => void;
}

export function ragSyncLockKey(repositoryId: string): string {
  return `haive:rag-sync:${repositoryId}`;
}

async function attempt(
  redis: Redis,
  repositoryId: string,
  tuning: RagSyncLockTuning,
): Promise<RagSyncLock | null> {
  const key = ragSyncLockKey(repositoryId);
  const token = randomUUID();
  const ttlMs = tuning.ttlMs ?? LOCK_TTL_MS;
  if ((await redis.set(key, token, 'PX', ttlMs, 'NX')) !== 'OK') return null;
  let lost = false;
  let released = false;
  const beat = setInterval(() => {
    redis
      .eval(REFRESH_SCRIPT, 1, key, token, ttlMs)
      .then((kept) => {
        if (kept === 1 || lost) return;
        lost = true;
        clearInterval(beat);
        log.warn({ repositoryId }, 'RAG sync lock lost: the key expired or another holder took it');
      })
      .catch((err: unknown) => {
        log.warn({ err, repositoryId }, 'RAG sync lock heartbeat failed');
      });
  }, tuning.heartbeatMs ?? HEARTBEAT_MS);
  beat.unref();
  return {
    get lost() {
      return lost;
    },
    release: async () => {
      if (released) return;
      released = true;
      clearInterval(beat);
      await redis.eval(RELEASE_SCRIPT, 1, key, token).catch((err: unknown) => {
        log.warn({ err, repositoryId }, 'RAG sync lock release failed; its expiry will clear it');
      });
    },
  };
}

/** The lock if no other holder has it right now, else null. Throws when Redis is unreachable. */
export function tryAcquireRagSyncLock(
  redis: Redis,
  repositoryId: string,
  tuning: RagSyncLockTuning = {},
): Promise<RagSyncLock | null> {
  return attempt(redis, repositoryId, tuning);
}

/** Waits for the current holder, polling. Throws RagSyncLockAbortedError when `signal` fires and
 *  RagSyncLockTimeoutError after `waitMs`. The caller MUST release the lock in a finally. */
export async function acquireRagSyncLock(
  redis: Redis,
  repositoryId: string,
  options: AcquireRagSyncLockOptions,
): Promise<RagSyncLock> {
  const { waitMs, signal, onWait } = options;
  const pollMs = options.pollMs ?? POLL_MS;
  const startedAt = Date.now();
  for (;;) {
    if (signal?.aborted) throw new RagSyncLockAbortedError();
    const got = await attempt(redis, repositoryId, options);
    if (got) return got;
    if (Date.now() - startedAt >= waitMs) throw new RagSyncLockTimeoutError(waitMs);
    onWait?.();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, pollMs);
      function done(): void {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      }
      signal?.addEventListener('abort', done, { once: true });
    });
  }
}
