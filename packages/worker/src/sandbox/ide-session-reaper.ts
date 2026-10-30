import { IDE_IDLE_GRACE_MS, IDE_SESSION_PREFIX, ideSessionKey, logger } from '@haive/shared';
import type { Redis } from 'ioredis';
import { listIdeRunnerSessions, stopIdeRunner } from './ide-runner.js';
import { ideSessionHeld } from './ide-session.js';

const log = logger.child({ module: 'ide-session-reaper' });

/** Sweep interval. A session that closes right after a sweep waits at most
 *  IDE_IDLE_GRACE_MS + this before reaping. */
const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

export interface IdeSessionReaperOptions {
  redis: Redis;
  intervalMs?: number;
  /** Override grace period (mostly for tests). */
  graceMs?: number;
}

/** Periodic worker loop that gracefully stops idle IDE containers.
 *
 *  Lifecycle ownership:
 *    - The api increments/decrements `refcount` and updates `lastSeenAt` on the
 *      `ide:session:<taskId>` hash as the proxied editor connection opens/closes.
 *    - This reaper grace-stops the container (SIGTERM via `docker stop`, so
 *      code-server flushes hot-exit backups) once nobody's connected for the
 *      window, then drops the registry entry. The per-task user-data volume is
 *      left intact so a reopen restores unsaved work.
 *    - Task end (cleanupTask) force-removes the container + the registry entry
 *      regardless, so an open editor never outlives its task.
 */
export class IdeSessionReaper {
  private readonly redis: Redis;
  private readonly intervalMs: number;
  private readonly graceMs: number;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(opts: IdeSessionReaperOptions) {
    this.redis = opts.redis;
    this.intervalMs = opts.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.graceMs = opts.graceMs ?? IDE_IDLE_GRACE_MS;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.inFlight) return;
      this.inFlight = true;
      this.sweep()
        .catch((err) => log.warn({ err }, 'ide reaper sweep failed'))
        .finally(() => {
          this.inFlight = false;
        });
    }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    log.info({ intervalMs: this.intervalMs, graceMs: this.graceMs }, 'ide session reaper started');
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Single sweep pass. Exposed for tests so they can drive it deterministically. */
  async sweep(): Promise<{ scanned: number; reaped: number }> {
    let scanned = 0;
    let reaped = 0;
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        `${IDE_SESSION_PREFIX}*`,
        'COUNT',
        '100',
      );
      cursor = next;
      for (const key of keys) {
        scanned += 1;
        const dropped = await this.maybeReap(key).catch((err) => {
          log.warn({ err, key }, 'ide reap step failed');
          return false;
        });
        if (dropped) reaped += 1;
      }
    } while (cursor !== '0');
    // After the scan: an editor it just reaped is gone from the listing, not registered again.
    await this.registerRunningEditors();
    if (reaped > 0) log.info({ scanned, reaped }, 'ide reaper sweep complete');
    return { scanned, reaped };
  }

  /** The scan only sees editors with an entry, so a running one without would never be stopped:
   *  start its grace here, and stop nothing for the absence. HSETNX writes only where no
   *  `lastSeenAt` is recorded, so a racing attach is kept. A failure never fails the sweep. */
  private async registerRunningEditors(): Promise<void> {
    let registered = 0;
    try {
      for (const sessionId of await listIdeRunnerSessions()) {
        const key = ideSessionKey(sessionId);
        if ((await this.redis.hsetnx(key, 'lastSeenAt', String(Date.now()))) === 1) registered += 1;
      }
    } catch (err) {
      log.warn({ err }, 'ide session registration failed');
    }
    if (registered > 0) log.info({ registered }, 'registered running ide sessions with no entry');
  }

  private async maybeReap(key: string): Promise<boolean> {
    const entry = await this.redis.hgetall(key);
    if (!entry || Object.keys(entry).length === 0) return false;
    if (ideSessionHeld(entry, this.graceMs)) return false;
    const taskId = key.slice(IDE_SESSION_PREFIX.length);
    await stopIdeRunner(taskId).catch((err) => {
      log.warn({ err, taskId }, 'ide stop failed during reap');
    });
    await this.redis.del(key);
    log.info({ key, taskId }, 'reaped idle ide session');
    return true;
  }
}
