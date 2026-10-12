import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { logger } from '../logger/index.js';

const log = logger.child({ module: 'rag-sync-lock' });

/** Backstop for a holder whose process died: the key frees this long after its last beat. */
const LOCK_TTL_MS = 120_000;
const HEARTBEAT_MS = 30_000;
const POLL_MS = 5_000;
/** The shared Redis clients queue commands forever while Redis is stalled; no lock command waits longer. */
const COMMAND_TIMEOUT_MS = 5_000;

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

export class RagSyncLockCommandTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`the RAG sync lock store did not answer within ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'RagSyncLockCommandTimeoutError';
  }
}

export class RagSyncLockLostError extends Error {
  constructor() {
    super(
      'the RAG sync lock of this repository was lost (it expired or another sync took it), so this sync stopped writing. Retry this step once the other sync has finished.',
    );
    this.name = 'RagSyncLockLostError';
  }
}

export interface RagSyncLock {
  /** True once a heartbeat found the key gone or owned by another holder. */
  readonly lost: boolean;
  /** Throws RagSyncLockLostError once `lost`; a holder calls it before it writes. */
  assertHeld(): void;
  /** Idempotent; stops the heartbeat and deletes the key only while this holder still owns it. */
  release(): Promise<void>;
}

export interface RagSyncLockTuning {
  ttlMs?: number;
  heartbeatMs?: number;
  commandTimeoutMs?: number;
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

function bounded<T>(op: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      finish(() => reject(new RagSyncLockCommandTimeoutError(timeoutMs)));
    }, timeoutMs);
    const onAbort = (): void => finish(() => reject(new RagSyncLockAbortedError()));
    function finish(settle: () => void): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      settle();
    }
    op.then(
      (value) => finish(() => resolve(value)),
      (err: unknown) => finish(() => reject(err)),
    );
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function attempt(
  redis: Redis,
  repositoryId: string,
  tuning: RagSyncLockTuning,
  signal?: AbortSignal,
): Promise<RagSyncLock | null> {
  const key = ragSyncLockKey(repositoryId);
  const token = randomUUID();
  const ttlMs = tuning.ttlMs ?? LOCK_TTL_MS;
  const commandTimeoutMs = tuning.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
  const taking = redis.set(key, token, 'PX', ttlMs, 'NX');
  let taken: string | null;
  try {
    taken = await bounded(taking, commandTimeoutMs, signal);
  } catch (err) {
    void taking
      .then((late) => (late === 'OK' ? redis.eval(RELEASE_SCRIPT, 1, key, token) : null))
      .catch(() => undefined);
    throw err;
  }
  if (taken !== 'OK') return null;
  let lost = false;
  let released = false;
  const beat = setInterval(() => {
    bounded(redis.eval(REFRESH_SCRIPT, 1, key, token, ttlMs), commandTimeoutMs)
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
    assertHeld: () => {
      if (lost) throw new RagSyncLockLostError();
    },
    release: async () => {
      if (released) return;
      released = true;
      clearInterval(beat);
      await bounded(redis.eval(RELEASE_SCRIPT, 1, key, token), commandTimeoutMs).catch(
        (err: unknown) => {
          log.warn({ err, repositoryId }, 'RAG sync lock release failed; its expiry will clear it');
        },
      );
    },
  };
}

/** The lock if no other holder has it right now, else null. Throws when Redis is unreachable or
 *  does not answer within the command timeout. */
export function tryAcquireRagSyncLock(
  redis: Redis,
  repositoryId: string,
  tuning: RagSyncLockTuning = {},
): Promise<RagSyncLock | null> {
  return attempt(redis, repositoryId, tuning);
}

/** Waits for the current holder, polling; an attempt Redis does not answer counts as not acquired.
 *  Throws RagSyncLockAbortedError when `signal` fires and RagSyncLockTimeoutError after `waitMs`.
 *  The caller MUST release the lock in a finally. */
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
    let got: RagSyncLock | null = null;
    try {
      got = await attempt(redis, repositoryId, options, signal);
    } catch (err) {
      if (!(err instanceof RagSyncLockCommandTimeoutError)) throw err;
      log.warn({ err, repositoryId }, 'RAG sync lock attempt got no answer; retrying');
    }
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
