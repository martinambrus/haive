import path from 'node:path';
import { and, asc, eq, gt, isNull, isNotNull, ne, or, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger } from '@haive/shared';
import {
  sweepWorktreeAliases,
  type AliasProgress,
  type AliasCheckpoint,
  type AliasScanState,
  type AliasName,
  type AliasRetry,
  WORKTREE_ALIAS_LIMITS,
} from './worktree-alias-sweep.js';

export const WORKTREE_ALIAS_BATCH_STEPS = 256;
export const WORKTREE_ALIAS_BATCH_MS = 100;
export const WORKTREE_ALIAS_TICK_MS = 1000;
export const WORKTREE_ALIAS_IDLE_MS = 60_000;
export const WORKTREE_ALIAS_RETRY_BASE_MS = 60_000;
export const WORKTREE_ALIAS_RETRY_MAX_MS = 6 * 60 * 60 * 1000;
export function aliasRetry(attempts: number, now: number): AliasRetry {
  return {
    attempts: Math.min(attempts + 1, 32),
    retryAt:
      now +
      Math.min(
        WORKTREE_ALIAS_RETRY_MAX_MS,
        WORKTREE_ALIAS_RETRY_BASE_MS * 2 ** Math.min(attempts, 20),
      ),
  };
}
export interface AliasRepository {
  id: string;
  anchor: string;
  refusal?: string;
  retry?: AliasRetry;
}
export interface AliasSweepStore {
  next(after: string): Promise<AliasRepository | null>;
  complete(repo: AliasRepository, progress?: AliasProgress): Promise<boolean>;
  progress?(repo: AliasRepository): Promise<void>;
  fail?(repo: AliasRepository, retry: AliasRetry): Promise<void>;
  load?(repo: AliasRepository): Promise<AliasCheckpoint | undefined>;
  checkpoint?(repo: AliasRepository, scan: AliasScanState, names: AliasName[]): Promise<void>;
}

/** The completion stamp belongs to Postgres, never to a file an agent can forge. Only managed
 * writable checkouts participate; a read-only local-folder import is never rewritten. */
export function worktreeAliasStore(db: Database, storageRoot: string): AliasSweepStore {
  const repos = schema.repositories;
  const eligible = () =>
    and(
      isNull(repos.worktreeAliasesSweptAt),
      eq(repos.status, 'ready'),
      isNull(repos.rootClaimedAt),
      or(
        ne(repos.source, 'local_path'),
        and(isNotNull(repos.storagePath), ne(repos.storagePath, '')),
      ),
    );
  return {
    async next(after) {
      const [repo] = await db
        .select({
          id: repos.id,
          userId: repos.userId,
          source: repos.source,
          storagePath: repos.storagePath,
          scan: repos.worktreeAliasScan,
        })
        .from(repos)
        .where(
          and(
            eligible(),
            after ? gt(repos.id, after) : undefined,
            sql`coalesce((${repos.worktreeAliasScan}->'retry'->>'retryAt')::numeric, 0) <= ${Date.now()}`,
          ),
        )
        .orderBy(asc(repos.id))
        .limit(1);
      if (!repo) return null;
      const anchor = path.join(storageRoot, repo.userId, repo.id);
      if (repo.storagePath !== null && path.resolve(repo.storagePath) !== path.resolve(anchor)) {
        return {
          id: repo.id,
          anchor,
          retry: repo.scan?.retry,
          refusal: 'Repository storage is outside its managed anchor',
        };
      }
      return { id: repo.id, anchor, retry: repo.scan?.retry };
    },
    async load(repo) {
      const [row] = await db
        .select({ scan: repos.worktreeAliasScan })
        .from(repos)
        .where(eq(repos.id, repo.id));
      const names = await db
        .select({
          path: schema.worktreeAliasNames.path,
          dev: schema.worktreeAliasNames.dev,
          ino: schema.worktreeAliasNames.ino,
        })
        .from(schema.worktreeAliasNames)
        .where(eq(schema.worktreeAliasNames.repositoryId, repo.id))
        .limit(WORKTREE_ALIAS_LIMITS.maxLinkedNames + 1);
      if (names.length > WORKTREE_ALIAS_LIMITS.maxLinkedNames)
        throw new RangeError('Worktree linked-name limit');
      return row?.scan ? { scan: row.scan, names } : undefined;
    },
    async checkpoint(repo, scan, names) {
      await db.transaction(async (tx) => {
        const [before] = await tx
          .select({ scan: repos.worktreeAliasScan })
          .from(repos)
          .where(eq(repos.id, repo.id))
          .for('no key update');
        if ((before?.scan?.pass ?? 1) !== (scan.pass ?? 1))
          await tx
            .delete(schema.worktreeAliasNames)
            .where(eq(schema.worktreeAliasNames.repositoryId, repo.id));
        const rows = await tx
          .update(repos)
          .set({ worktreeAliasScan: { ...scan, retry: before?.scan?.retry } })
          .where(and(eq(repos.id, repo.id), eligible()))
          .returning({ id: repos.id });
        if (rows.length !== 1) throw new Error('Repository changed during alias scan');
        if (names.length)
          await tx
            .insert(schema.worktreeAliasNames)
            .values(names.map((name) => ({ repositoryId: repo.id, ...name })))
            .onConflictDoUpdate({
              target: [schema.worktreeAliasNames.repositoryId, schema.worktreeAliasNames.path],
              set: { dev: sql`excluded.dev`, ino: sql`excluded.ino` },
            });
      });
    },
    async progress(repo) {
      await db
        .update(repos)
        .set({
          worktreeAliasScan: sql`${repos.worktreeAliasScan} - 'retry'`,
        })
        .where(and(eq(repos.id, repo.id), isNull(repos.worktreeAliasesSweptAt)));
    },
    async fail(repo, retry) {
      await db
        .update(repos)
        .set({
          worktreeAliasScan: sql`jsonb_set(coalesce(${repos.worktreeAliasScan}, '{"cursor":"","examined":0,"complete":false}'::jsonb), '{retry}', ${JSON.stringify(retry)}::jsonb)`,
        })
        .where(and(eq(repos.id, repo.id), isNull(repos.worktreeAliasesSweptAt)));
    },
    async complete(repo, progress) {
      return db.transaction(async (tx) => {
        const [current] = await tx
          .select({ storagePath: repos.storagePath })
          .from(repos)
          .where(eq(repos.id, repo.id))
          .for('no key update');
        if (
          !current ||
          (current.storagePath !== null &&
            path.resolve(current.storagePath) !== path.resolve(repo.anchor))
        )
          return false;
        const skipped = progress?.skipped;
        const summary =
          skipped && Object.keys(skipped).length
            ? {
                cursor: '',
                examined: progress?.examined ?? 0,
                complete: true,
                skipped,
                outcome: 'done-with-skips' as const,
              }
            : null;
        const rows = await tx
          .update(repos)
          .set({ worktreeAliasesSweptAt: new Date(), worktreeAliasScan: summary })
          .where(
            and(
              eq(repos.id, repo.id),
              eligible(),
              current.storagePath === null
                ? isNull(repos.storagePath)
                : eq(repos.storagePath, current.storagePath),
            ),
          )
          .returning({ id: repos.id });
        if (rows.length === 1)
          await tx
            .delete(schema.worktreeAliasNames)
            .where(eq(schema.worktreeAliasNames.repositoryId, repo.id));
        return rows.length === 1;
      });
    },
  };
}

/** One worker per install, as for the existing boot reapers. A scan is retained between ticks;
 * durable sparse checkpoints resume discovery after death; detached names remain safe. */
export class WorktreeAliasSweeper {
  private after = '';
  private idleUntil = 0;
  private failures = new Map<string, AliasRetry>();
  private active:
    | {
        repo: AliasRepository;
        walk: AsyncGenerator<AliasProgress>;
        started: number;
        progress?: AliasProgress;
      }
    | undefined;
  private running: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  constructor(
    private readonly store: AliasSweepStore,
    private readonly opts: {
      maxSteps?: number;
      maxBatchMs?: number;
      walk?: typeof sweepWorktreeAliases;
      intervalMs?: number;
    } = {},
  ) {
    if (
      !Number.isSafeInteger(opts.maxSteps ?? WORKTREE_ALIAS_BATCH_STEPS) ||
      (opts.maxSteps ?? WORKTREE_ALIAS_BATCH_STEPS) < 1
    )
      throw new RangeError('Invalid batch size');
  }
  start(): void {
    this.timer ??= setInterval(
      () => void this.tick(),
      this.opts.intervalMs ?? WORKTREE_ALIAS_TICK_MS,
    );
    this.timer.unref();
    void this.tick();
  }
  tick(): Promise<void> {
    if (this.stopped || Date.now() < this.idleUntil) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.runBatch().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async runBatch(): Promise<void> {
    let repo = this.active?.repo;
    let scan: AliasScanState | undefined;
    let names: AliasName[] = [];
    const flush = async (resetFailure = false) => {
      if (scan && repo) {
        await this.store.checkpoint?.(repo, scan, names);
        scan = undefined;
        names = [];
        if (resetFailure && (this.failures.has(repo.id) || repo.retry)) {
          await this.store.progress?.(repo);
          this.failures.delete(repo.id);
          repo.retry = undefined;
        }
      }
    };
    try {
      if (!this.active) {
        repo = (await this.store.next(this.after)) ?? undefined;
        if (!repo) {
          const completedRotation = !this.after;
          this.after = '';
          if (completedRotation) this.idleUntil = Date.now() + WORKTREE_ALIAS_IDLE_MS;
          return;
        }
        this.after = repo.id;
        const retry = this.failures.get(repo.id) ?? repo.retry;
        if (retry && retry.retryAt > Date.now()) return;
        if (repo.refusal) throw new Error(repo.refusal);
        this.active = {
          repo,
          walk: (this.opts.walk ?? sweepWorktreeAliases)(repo.anchor, {
            resume: await this.store.load?.(repo),
          }),
          started: Date.now(),
        };
      }
      const active = this.active;
      const started = Date.now();
      for (
        let i = 0;
        i < (this.opts.maxSteps ?? WORKTREE_ALIAS_BATCH_STEPS) && !this.stopped;
        i++
      ) {
        const result = await active.walk.next();
        if (result.done) {
          await flush();
          if (!(await this.store.complete(active.repo, active.progress)))
            throw Object.assign(new Error('Repository changed before alias completion'), {
              code: 'alias_completion_refused',
            });
          this.failures.delete(active.repo.id);
          // Only vanished/replaced entries are known benign; unknown classes fail toward warning.
          const exposure = Object.entries(active.progress?.skipped ?? {}).some(
            ([kind, count]) => count > 0 && kind !== 'vanished' && kind !== 'changed_entry',
          );
          (exposure ? logger.warn.bind(logger) : logger.info.bind(logger))(
            {
              repositoryId: active.repo.id,
              examined: active.progress?.examined,
              replaced: active.progress?.replaced,
              skipped: active.progress?.skipped,
              outcome: Object.keys(active.progress?.skipped ?? {}).length
                ? 'done-with-skips'
                : 'done',
              elapsedMs: Date.now() - active.started,
            },
            'legacy worktree alias sweep completed',
          );
          this.active = undefined;
          return;
        }
        // Commit the old pass's names before resetting the journal for the next pass.
        if (scan && (result.value.scan?.pass ?? 1) !== (scan.pass ?? 1)) await flush(true);
        active.progress = result.value;
        if (result.value.scan) scan = result.value.scan;
        if (result.value.discovered) names.push(result.value.discovered);
        if (Date.now() - started >= (this.opts.maxBatchMs ?? WORKTREE_ALIAS_BATCH_MS)) break;
      }
      await flush(true);
    } catch (err) {
      // Even a generator fault after several yielded entries must retain this batch's cursor.
      await flush().catch(() => undefined);
      await this.active?.walk.return(undefined).catch(() => undefined);
      if (repo) {
        const previous = this.failures.get(repo.id) ?? repo.retry;
        const retry = aliasRetry(previous?.attempts ?? 0, Date.now());
        if (!previous?.attempts)
          logger.warn(
            {
              repositoryId: repo.id,
              code: (err as { code?: string })?.code ?? 'alias_sweep_failed',
            },
            'legacy worktree alias sweep incomplete; backing off',
          );
        // Bounded fallback if the database itself refuses the durable retry write.
        if (this.failures.size >= 1024) this.failures.delete(this.failures.keys().next().value!);
        this.failures.set(repo.id, retry);
        await this.store.fail?.(repo, retry).catch(() => undefined);
      } else {
        this.idleUntil = Date.now() + WORKTREE_ALIAS_IDLE_MS;
        logger.warn(
          { code: (err as { code?: string })?.code ?? 'alias_store_failed' },
          'legacy alias repository lookup deferred',
        );
      }
      this.active = undefined;
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.running;
    await this.active?.walk.return(undefined);
    this.active = undefined;
  }
}
