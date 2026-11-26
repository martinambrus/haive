import { randomBytes } from 'node:crypto';
import { constants } from 'node:os';
import { rename } from 'node:fs/promises';
import { inInstall, type InstallDirectory } from './install-files.js';
import { UpgradeRefusal } from './refusal.js';

/** Wire contract shared with the Desktop extension bridge: file name and timings must match it. */
export const STACK_LOCK_NAME = '.haive-stack-lock';
export const STACK_LOCK_BEAT_MS = 5000;
export const STACK_LOCK_STALE_MS = 60000;
export const STACK_LOCK_POLL_MS = 1000;
export const STACK_LOCK_ROUNDS = 3;
export const STACK_LOCK_MAX_BYTES = 4096;
export const STACK_LOCK_RELEASE_TRIES = 3;
export const STACK_LOCK_RELEASE_PAUSE_MS = 100;
export const STACK_LOCK_PROOF_TRIES = 3;
export const STACK_LOCK_PROOF_PAUSE_MS = 100;
// Leave time to release the lock before docker stop's default 10 s SIGKILL grace expires.
export const STACK_LOCK_SIGNAL_CLEANUP_TIMEOUT_MS = 5000;

export interface StackLockOptions {
  holder?: string;
  beatMs?: number;
  staleMs?: number;
  pollMs?: number;
  rounds?: number;
  maxBytes?: number;
  proofTries?: number;
  proofPauseMs?: number;
  releaseTries?: number;
  releasePauseMs?: number;
  heartbeat?: boolean;
  sleep?: (ms: number) => Promise<void>;
  /** Monotonic elapsed-time clock, independent of the informational startedAt. */
  now?: () => number;
  onEvent?: (event: string, fields?: Record<string, unknown>) => void;
  hooks?: { beforeBreak?: () => Promise<void> };
}

export type BusyOutcome = { status: 'busy'; holder: string; startedAt?: string };
export type AcquireOutcome =
  { status: 'held'; lock: StackLock } | BusyOutcome | { status: 'absent' };

type Resolved = Required<Omit<StackLockOptions, 'onEvent' | 'hooks'>> &
  Pick<StackLockOptions, 'onEvent' | 'hooks'>;

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;
const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function resolve(options: StackLockOptions): Resolved {
  return {
    holder: options.holder ?? 'updater',
    beatMs: options.beatMs ?? STACK_LOCK_BEAT_MS,
    staleMs: options.staleMs ?? STACK_LOCK_STALE_MS,
    pollMs: options.pollMs ?? STACK_LOCK_POLL_MS,
    rounds: options.rounds ?? STACK_LOCK_ROUNDS,
    maxBytes: options.maxBytes ?? STACK_LOCK_MAX_BYTES,
    proofTries: Math.max(1, options.proofTries ?? STACK_LOCK_PROOF_TRIES),
    proofPauseMs: options.proofPauseMs ?? STACK_LOCK_PROOF_PAUSE_MS,
    releaseTries: options.releaseTries ?? STACK_LOCK_RELEASE_TRIES,
    releasePauseMs: options.releasePauseMs ?? STACK_LOCK_RELEASE_PAUSE_MS,
    heartbeat: options.heartbeat ?? true,
    sleep: options.sleep ?? realSleep,
    now: options.now ?? (() => performance.now()),
    onEvent: options.onEvent,
    hooks: options.hooks,
  };
}

function encode(token: string, holder: string, startedAt: string, seq: number): Buffer {
  return Buffer.from(`${JSON.stringify({ v: 1, token, holder, startedAt, seq })}\n`);
}

function decode(bytes: Buffer): { token?: string; holder?: string; startedAt?: string } {
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (typeof value !== 'object' || value === null) return {};
    const { token, holder, startedAt } = value as Record<string, unknown>;
    return {
      ...(typeof token === 'string' ? { token } : {}),
      ...(typeof holder === 'string' ? { holder } : {}),
      ...(typeof startedAt === 'string' ? { startedAt } : {}),
    };
  } catch {
    return {};
  }
}

const parses = (bytes: Buffer): boolean => {
  try {
    JSON.parse(bytes.toString('utf8'));
    return true;
  } catch {
    return false;
  }
};

export class StackLock {
  private seq = 1;
  private lostFlag = false;
  private failing = false;
  private ownWriteFailed = false;
  private releasing: Promise<void> | undefined;
  private inFlight: Promise<'ok' | 'lost' | 'error'> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private checking: Promise<void> | undefined;

  constructor(
    private readonly installDir: string,
    readonly token: string,
    private readonly startedAt: string,
    private readonly options: Resolved,
    private lastGood: number,
  ) {
    if (options.heartbeat) {
      this.timer = setInterval(() => void this.beat(), options.beatMs);
      this.timer.unref();
    }
  }

  get lost(): boolean {
    return this.lostFlag;
  }

  /** A phase needs a fresh proof from the store, not merely the absence of a failed heartbeat.
   * Never recreate or refresh here: an absent or unreadable record proves no ownership. */
  assertOwned(): Promise<void> {
    if (this.lostFlag) return Promise.reject(this.lossRefusal());
    if (this.releasing) return Promise.reject(this.lossRefusal());
    return (this.checking ??= this.checkOwner().finally(() => {
      this.checking = undefined;
    }));
  }

  private async checkOwner(): Promise<void> {
    // A heartbeat rewrites in place. Do not mistake its unfinished write for a foreign record.
    await this.inFlight;
    if (this.lostFlag) throw this.lossRefusal();
    if (this.releasing) throw this.lossRefusal();
    for (let attempt = 1; attempt <= this.options.proofTries; attempt++) {
      let current;
      try {
        current = await inInstall(this.installDir, (dir) =>
          dir.read(STACK_LOCK_NAME, this.options.maxBytes),
        );
      } catch {
        if (attempt === this.options.proofTries) throw this.unprovenRefusal();
        await this.options.sleep(this.options.proofPauseMs);
        continue;
      }
      if (this.lostFlag) throw this.lossRefusal();
      if (this.releasing) throw this.lossRefusal();
      // breakStale can leave the name absent while restoring a displaced holder. Never infer
      // takeover from absence, or recreate the record as a side effect of a phase proof.
      if (!current) throw this.unprovenRefusal();
      if (!parses(current.bytes)) {
        if (this.ownWriteFailed && !this.proofExpired()) return;
        throw this.unprovenRefusal();
      }
      const owner = decode(current.bytes);
      if (!owner.token || !owner.holder || !owner.startedAt) throw this.unprovenRefusal();
      if (
        owner.token !== this.token ||
        owner.holder !== this.options.holder ||
        owner.startedAt !== this.startedAt
      ) {
        this.markLost();
        throw this.lossRefusal();
      }
      return;
    }
  }

  private proofExpired(): boolean {
    if (this.options.now() - this.lastGood >= this.options.staleMs) this.markLost();
    return this.lostFlag;
  }

  private unprovenRefusal(): UpgradeRefusal {
    if (this.proofExpired()) return this.lossRefusal();
    return new UpgradeRefusal(
      'stack-lock-unproven',
      'install stack lease ownership could not be proved; refusing the phase',
    );
  }

  private lossRefusal(): UpgradeRefusal {
    return new UpgradeRefusal(
      'stack-lock-lost',
      'install stack lease was lost; leaving the upgrade for recovery',
    );
  }

  private markLost(): void {
    if (this.lostFlag) return;
    this.lostFlag = true;
    this.stopTimer();
    this.options.onEvent?.('stack-lock-lost', { token: this.token });
  }

  beat(): Promise<'ok' | 'lost' | 'error'> {
    // After release has started a beat must never re-create the file.
    if (this.lostFlag || this.releasing) return Promise.resolve('lost');
    if (this.checking)
      return this.checking.then(
        () => this.beat(),
        () => (this.lostFlag ? ('lost' as const) : ('error' as const)),
      );
    // A tick that arrives while a write is still in flight joins it rather than overlapping.
    this.inFlight ??= this.beatOnce().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async beatOnce(): Promise<'ok' | 'lost' | 'error'> {
    const started = this.options.now();
    try {
      const outcome = await inInstall(this.installDir, async (dir) => {
        const current = await dir.read(STACK_LOCK_NAME, this.options.maxBytes);
        // A break-then-restore leaves the name absent for a moment: take it back; EEXIST fails the beat.
        if (!current) {
          if (this.proofExpired()) return 'lost' as const;
          await dir.createExclusive(
            STACK_LOCK_NAME,
            encode(this.token, this.options.holder, this.startedAt, this.seq + 1),
          );
          return 'created' as const;
        }
        // A write that failed after truncating leaves our own record empty or partial: not a loss.
        const parsed = parses(current.bytes);
        if (!parsed && (!this.ownWriteFailed || this.proofExpired())) throw this.unprovenRefusal();
        const owner = decode(current.bytes);
        if (parsed && (!owner.token || !owner.holder || !owner.startedAt))
          throw this.unprovenRefusal();
        if (
          parsed &&
          (owner.token !== this.token ||
            owner.holder !== this.options.holder ||
            owner.startedAt !== this.startedAt)
        )
          return 'lost' as const;
        let truncated = false;
        try {
          await dir.overwrite(
            STACK_LOCK_NAME,
            encode(this.token, this.options.holder, this.startedAt, this.seq + 1),
            () => {
              truncated = true;
            },
          );
        } catch (error) {
          // Only our own failed rewrite can explain torn bytes. A read or proof failure
          // may have observed another holder's unfinished write and grants no tolerance.
          this.ownWriteFailed ||= truncated;
          throw error;
        }
        return 'ok' as const;
      });
      if (outcome === 'ok' || outcome === 'created') {
        this.seq += 1;
        this.lastGood = started;
        this.failing = false;
        this.ownWriteFailed = false;
        return 'ok';
      }
      this.markLost();
      return 'lost';
    } catch (error) {
      if (this.proofExpired()) return 'lost';
      if (!this.failing) {
        this.failing = true;
        this.options.onEvent?.('stack-lock-beat-failed', { code: code(error) });
      }
      return 'error';
    }
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Every caller gets the one release in progress, so a second signal never exits before it ends. */
  release(): Promise<void> {
    return (this.releasing ??= this.releaseOnce());
  }

  private async releaseOnce(): Promise<void> {
    this.stopTimer();
    await this.inFlight?.catch(() => {});
    if (this.lostFlag) return;
    const { releaseTries: tries, releasePauseMs: pause } = this.options;
    for (let attempt = 1; attempt <= tries; attempt++) {
      try {
        await inInstall(this.installDir, async (dir) => {
          const current = await dir.read(STACK_LOCK_NAME, this.options.maxBytes);
          if (current && decode(current.bytes).token === this.token)
            await dir.remove(STACK_LOCK_NAME).catch((error: unknown) => {
              if (code(error) !== 'ENOENT') throw error;
            });
        });
        return;
      } catch (error) {
        if (attempt === tries) {
          this.options.onEvent?.('stack-lock-release-failed', { code: code(error) });
          return;
        }
        await this.options.sleep(pause).catch(() => {});
      }
    }
  }
}

type Verdict = 'free' | 'live' | 'stale' | 'unknown';

export async function acquireStackLock(
  installDir: string,
  options: StackLockOptions = {},
): Promise<AcquireOutcome> {
  const opts = resolve(options);
  const op = <T>(work: (dir: InstallDirectory) => Promise<T>): Promise<T> =>
    inInstall(installDir, work);
  const token = randomBytes(16).toString('hex');
  const startedAt = new Date().toISOString();
  let busy: BusyOutcome = { status: 'busy', holder: 'unknown' };
  let waiting = false;

  for (let round = 0; round < opts.rounds; round++) {
    const started = opts.now();
    try {
      await op((dir) =>
        dir.createExclusive(STACK_LOCK_NAME, encode(token, opts.holder, startedAt, 1)),
      );
      opts.onEvent?.('stack-lock-acquired', { holder: opts.holder });
      return { status: 'held', lock: new StackLock(installDir, token, startedAt, opts, started) };
    } catch (error) {
      // Only the directory open can report ENOENT: the create itself is inside an open directory.
      if (code(error) === 'ENOENT') {
        opts.onEvent?.('stack-lock-skipped', { reason: 'install directory absent' });
        return { status: 'absent' };
      }
      if (code(error) !== 'EEXIST') throw error;
    }

    // A non-regular entry throws here and is propagated: never read, followed or deleted.
    const first = await op(async (dir) => {
      await dir.entry(STACK_LOCK_NAME);
      return dir.read(STACK_LOCK_NAME, opts.maxBytes).catch(() => null);
    });
    if (first === undefined) continue;
    if (first === null) return { status: 'busy', holder: 'unknown' };
    const seen = decode(first.bytes);
    busy = {
      status: 'busy',
      holder: seen.holder ?? 'unknown',
      ...(seen.startedAt ? { startedAt: seen.startedAt } : {}),
    };
    if (!waiting) {
      waiting = true;
      opts.onEvent?.('stack-lock-waiting', {
        holder: busy.holder,
        startedAt: busy.startedAt,
        staleMs: opts.staleMs,
      });
    }

    let verdict: Verdict = 'stale';
    let waited = 0;
    // A poll below 1 ms would never advance `waited`.
    const poll = Math.max(1, opts.pollMs);
    while (waited < opts.staleMs) {
      await opts.sleep(poll);
      waited += poll;
      const now = await op((dir) => dir.read(STACK_LOCK_NAME, opts.maxBytes)).catch(() => null);
      if (now === null) {
        verdict = 'unknown';
        break;
      }
      if (now === undefined) {
        verdict = 'free';
        break;
      }
      if (!now.bytes.equals(first.bytes)) {
        verdict = 'live';
        break;
      }
    }
    if (verdict === 'free') continue;
    if (verdict === 'live') return busy;
    if (verdict === 'unknown') return { status: 'busy', holder: 'unknown' };

    if ((await breakStale(op, first.bytes, seen.token, waited, opts)) === 'busy') return busy;
  }
  return busy;
}

/** Tombstone by rename so that exactly one breaker wins, then verify what was displaced. */
async function breakStale(
  op: <T>(work: (dir: InstallDirectory) => Promise<T>) => Promise<T>,
  expected: Buffer,
  oldToken: string | undefined,
  unchangedMs: number,
  opts: Resolved,
): Promise<'free' | 'busy'> {
  await opts.hooks?.beforeBreak?.();
  const tomb = `${STACK_LOCK_NAME}.stale.${randomBytes(4).toString('hex')}`;
  try {
    return await op(async (dir) => {
      try {
        await rename(dir.path(STACK_LOCK_NAME), dir.path(tomb));
      } catch (error) {
        if (code(error) === 'ENOENT') return 'free' as const;
        throw error;
      }
      const displaced = await dir.read(tomb, opts.maxBytes);
      if (displaced?.bytes.equals(expected)) {
        // The name is already free: a tomb that cannot be removed is harmless, so report it and go on.
        await dir.remove(tomb).catch((error: unknown) => {
          opts.onEvent?.('stack-lock-tomb-left', { code: code(error) });
        });
        opts.onEvent?.('stack-lock-broken', { token: oldToken, unchangedMs });
        return 'free' as const;
      }
      // A holder beat or re-acquired between our last read and the rename: give its lock back.
      if (displaced) {
        try {
          await dir.createExclusive(STACK_LOCK_NAME, displaced.bytes);
        } catch {
          opts.onEvent?.('stack-lock-lost', { reason: 'displaced holder could not be restored' });
        }
      }
      await dir.remove(tomb);
      return 'busy' as const;
    });
  } catch {
    return 'busy';
  }
}

export function releaseOnSignal(
  lock: StackLock,
  exit: (code: number) => never = process.exit,
  signals: NodeJS.Signals[] = ['SIGTERM'],
  cleanup: {
    beforeRelease?: () => Promise<void>;
    onError?: (error: unknown) => void;
    timeoutMs?: number;
  } = {},
): () => Promise<void> | undefined {
  let stopping: Promise<void> | undefined;
  const handlers = signals.map((signal) => {
    const handler = () => {
      stopping ??= (async () => {
        let timer: NodeJS.Timeout | undefined;
        try {
          if (cleanup.beforeRelease) {
            const timeoutMs = cleanup.timeoutMs ?? STACK_LOCK_SIGNAL_CLEANUP_TIMEOUT_MS;
            await Promise.race([
              cleanup.beforeRelease(),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                  reject(
                    Object.assign(
                      new Error(`${signal} cleanup exceeded ${timeoutMs} ms deadline`),
                      {
                        code: 'ETIMEDOUT',
                      },
                    ),
                  );
                }, timeoutMs);
              }),
            ]);
          }
        } catch (error) {
          cleanup.onError?.(error);
        } finally {
          clearTimeout(timer);
          await lock.release();
          exit(128 + (constants.signals[signal] ?? 0));
        }
      })();
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    return stopping;
  };
}

export function describeBusy(outcome: BusyOutcome): string {
  // The holder name comes from a file anyone with write access to the install can edit, and the
  // message is rendered as markdown: show only a plain token.
  const label = /^[A-Za-z0-9._-]{1,32}$/.test(outcome.holder) ? outcome.holder : 'unknown';
  const who =
    outcome.holder === 'updater'
      ? 'another upgrade'
      : outcome.holder === 'extension'
        ? 'a Haive Desktop operation'
        : `another process (${label})`;
  return (
    `${who} is using this install right now. Retry when it finishes. ` +
    `If that holder was interrupted, its lock clears itself after the stale window of about ` +
    `${STACK_LOCK_STALE_MS / 1000} seconds without activity.`
  );
}
