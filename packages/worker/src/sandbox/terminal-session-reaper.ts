import Docker from 'dockerode';
import {
  DEFAULT_GIT_CRED_TOKEN_TTL_SECONDS,
  TERMINAL_IDLE_GRACE_MS,
  TERMINAL_SESSION_PREFIX,
  logger,
} from '@haive/shared';
import type { Redis } from 'ioredis';
import { refreshGitCredentialToken, removeShellContainer } from '../terminal/terminal-container.js';

const log = logger.child({ module: 'terminal-session-reaper' });

/** Default sweep interval. Picked so a session that closes right after a
 *  sweep waits at most TERMINAL_IDLE_GRACE_MS + SWEEP_INTERVAL_MS before
 *  reaping (so worst-case ~2.5 min). Aggressive enough to keep WSL's
 *  container ceiling clear, lazy enough to avoid burning cycles. */
const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

const GIT_CRED_REFRESH_AFTER_MS = (DEFAULT_GIT_CRED_TOKEN_TTL_SECONDS * 1000) / 2;
// A docker exec that never answers must not hold the sweep, which also reaps idle shells.
const GIT_CRED_REFRESH_TIMEOUT_MS = 30_000;

export interface TerminalSessionReaperOptions {
  redis: Redis;
  docker?: Docker;
  intervalMs?: number;
  /** Override grace period (mostly for tests). */
  graceMs?: number;
}

/** Periodic worker loop that drops idle terminal session entries from the
 *  Redis registry and force-removes their containers.
 *
 *  Lifecycle ownership:
 *    - The session manager creates the registry entry and the container.
 *    - The API increments/decrements `refcount` and updates `lastSeenAt`
 *      as WebSocket clients connect / disconnect.
 *    - This reaper deletes both when nobody's connected for the grace
 *      window. Force-killing the container preserves the "tab disabled
 *      while task ended" guarantee even if the API is down.
 */
export class TerminalSessionReaper {
  private readonly redis: Redis;
  private readonly docker: Docker;
  private readonly intervalMs: number;
  private readonly graceMs: number;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(opts: TerminalSessionReaperOptions) {
    this.redis = opts.redis;
    this.docker = opts.docker ?? new Docker();
    this.intervalMs = opts.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.graceMs = opts.graceMs ?? TERMINAL_IDLE_GRACE_MS;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.inFlight) return;
      this.inFlight = true;
      this.sweep()
        .catch((err) => log.warn({ err }, 'reaper sweep failed'))
        .finally(() => {
          this.inFlight = false;
        });
    }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    log.info(
      { intervalMs: this.intervalMs, graceMs: this.graceMs },
      'terminal session reaper started',
    );
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Single sweep pass. Exposed for tests so they can drive it deterministically
   *  rather than waiting for the interval. */
  async sweep(): Promise<{ scanned: number; reaped: number }> {
    let scanned = 0;
    let reaped = 0;
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        `${TERMINAL_SESSION_PREFIX}*`,
        'COUNT',
        '100',
      );
      cursor = next;
      for (const key of keys) {
        scanned += 1;
        const dropped = await this.maybeReap(key).catch((err) => {
          log.warn({ err, key }, 'reap step failed');
          return false;
        });
        if (dropped) reaped += 1;
      }
    } while (cursor !== '0');
    if (reaped > 0) log.info({ scanned, reaped }, 'reaper sweep complete');
    return { scanned, reaped };
  }

  private async maybeReap(key: string): Promise<boolean> {
    const entry = await this.redis.hgetall(key);
    if (!entry || Object.keys(entry).length === 0) return false;
    const refcount = Number.parseInt(entry.refcount ?? '0', 10);
    const lastSeenAt = Number.parseInt(entry.lastSeenAt ?? '0', 10);
    const containerName = entry.containerName;
    if (refcount > 0 || Date.now() - lastSeenAt < this.graceMs) {
      await this.refreshGitCredential(key, entry);
      return false;
    }
    if (containerName) {
      await removeShellContainer(this.docker, containerName).catch((err) => {
        log.warn({ err, containerName }, 'remove failed during reap');
      });
    }
    await this.redis.del(key);
    log.info({ key, containerName }, 'reaped idle terminal session');
    return true;
  }

  /** Re-mints a live repo shell's token once half its TTL is gone; a failure retries next sweep. */
  private async refreshGitCredential(key: string, entry: Record<string, string>): Promise<void> {
    const { containerName, scope, scopeId, userId } = entry;
    const mintedAt = Number.parseInt(entry.gitCredMintedAt ?? '', 10);
    const secret = process.env.CONFIG_ENCRYPTION_KEY;
    if (scope !== 'repo' || !containerName || !scopeId || !userId || !secret) return;
    if (!Number.isFinite(mintedAt) || Date.now() - mintedAt < GIT_CRED_REFRESH_AFTER_MS) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      const refreshedAt = await Promise.race([
        refreshGitCredentialToken(this.docker, containerName, scopeId, userId, secret),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('git credential token refresh timed out')),
            GIT_CRED_REFRESH_TIMEOUT_MS,
          );
        }),
      ]);
      await this.redis.hset(key, 'gitCredMintedAt', String(refreshedAt));
      log.info({ key, containerName }, 'refreshed git credential token');
    } catch (err) {
      log.warn({ err, key, containerName }, 'git credential token refresh failed');
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Helper: scan + drop every terminal session for a given task. Called from
 *  the task-end hook so a cancel/finish always tears terminals down even if
 *  there's still a connected WS (the WS will see the out-channel close and
 *  the API will mark the tab disabled on the next refresh). */
export async function reapAllSessionsForTask(
  redis: Redis,
  docker: Docker,
  taskId: string,
): Promise<number> {
  let cursor = '0';
  let killed = 0;
  do {
    const [next, keys] = await redis.scan(
      cursor,
      'MATCH',
      `${TERMINAL_SESSION_PREFIX}*:${taskId}:*`,
      'COUNT',
      '100',
    );
    cursor = next;
    for (const key of keys) {
      const entry = await redis.hgetall(key);
      if (entry?.containerName) {
        await removeShellContainer(docker, entry.containerName).catch(() => undefined);
      }
      await redis.del(key);
      killed += 1;
    }
  } while (cursor !== '0');
  if (killed > 0) {
    log.info({ taskId, killed }, 'reaped all terminal sessions for ended task');
  }
  return killed;
}
