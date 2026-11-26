import path from 'node:path';
import { and, asc, eq, gt, isNull, ne, or, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger } from '@haive/shared';
import {
  sweepWorktreeAliases,
  type AliasProgress,
  type AliasCheckpoint,
  type AliasScanState,
  type AliasName,
  WORKTREE_ALIAS_LIMITS,
} from './worktree-alias-sweep.js';

export const WORKTREE_ALIAS_BATCH_STEPS = 256;
export const WORKTREE_ALIAS_BATCH_MS = 100;
export const WORKTREE_ALIAS_TICK_MS = 1000;
export interface AliasRepository {
  id: string;
  anchor: string;
  refusal?: string;
}
export interface AliasSweepStore {
  next(after: string): Promise<AliasRepository | null>;
  complete(repo: AliasRepository): Promise<boolean>;
  reset?(repo: AliasRepository): Promise<void>;
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
      or(ne(repos.source, 'local_path'), ne(repos.storagePath, '')),
    );
  return {
    async next(after) {
      const [repo] = await db
        .select({
          id: repos.id,
          userId: repos.userId,
          source: repos.source,
          storagePath: repos.storagePath,
        })
        .from(repos)
        .where(and(eligible(), after ? gt(repos.id, after) : undefined))
        .orderBy(asc(repos.id))
        .limit(1);
      if (!repo) return null;
      const anchor = path.join(storageRoot, repo.userId, repo.id);
      if (repo.storagePath !== null && path.resolve(repo.storagePath) !== path.resolve(anchor)) {
        return { id: repo.id, anchor, refusal: 'Repository storage is outside its managed anchor' };
      }
      return { id: repo.id, anchor };
    },
    async reset(repo) {
      await db.transaction(async (tx) => {
        const rows = await tx
          .update(repos)
          .set({ worktreeAliasScan: null })
          .where(and(eq(repos.id, repo.id), isNull(repos.worktreeAliasesSweptAt)))
          .returning({ id: repos.id });
        if (rows.length)
          await tx
            .delete(schema.worktreeAliasNames)
            .where(eq(schema.worktreeAliasNames.repositoryId, repo.id));
      });
    },
    async load(repo) {
      const [row] = await db
        .select({ scan: repos.worktreeAliasScan })
        .from(repos)
        .where(eq(repos.id, repo.id));
      // A death during copy may have left a parked or published name. Rediscover that tree
      // before replaying copies, so recovery artifacts join the inode count as well.
      if (row?.scan?.complete) {
        await db.transaction(async (tx) => {
          await tx.update(repos).set({ worktreeAliasScan: null }).where(eq(repos.id, repo.id));
          await tx
            .delete(schema.worktreeAliasNames)
            .where(eq(schema.worktreeAliasNames.repositoryId, repo.id));
        });
        return undefined;
      }
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
        const rows = await tx
          .update(repos)
          .set({ worktreeAliasScan: scan })
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
    async complete(repo) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .update(repos)
          .set({ worktreeAliasesSweptAt: new Date(), worktreeAliasScan: null })
          .where(
            and(
              eq(repos.id, repo.id),
              eligible(),
              or(isNull(repos.storagePath), eq(repos.storagePath, repo.anchor)),
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
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.runBatch().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async runBatch(): Promise<void> {
    try {
      if (!this.active) {
        const repo = await this.store.next(this.after);
        if (!repo) {
          this.after = '';
          return;
        }
        this.after = repo.id;
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
      let scan: AliasScanState | undefined;
      const names: AliasName[] = [];
      const started = Date.now();
      const replacedBefore = active.progress?.replaced ?? 0;
      for (
        let i = 0;
        i < (this.opts.maxSteps ?? WORKTREE_ALIAS_BATCH_STEPS) && !this.stopped;
        i++
      ) {
        const result = await active.walk.next();
        if (result.done) {
          if (await this.store.complete(active.repo)) {
            logger.info(
              {
                repositoryId: active.repo.id,
                ...active.progress,
                elapsedMs: Date.now() - active.started,
              },
              'legacy worktree alias sweep completed',
            );
          }
          this.active = undefined;
          return;
        }
        active.progress = result.value;
        if (result.value.scan) scan = result.value.scan;
        if (result.value.discovered) names.push(result.value.discovered);
        if (
          result.value.replaced > replacedBefore ||
          Date.now() - started >= (this.opts.maxBatchMs ?? WORKTREE_ALIAS_BATCH_MS)
        )
          break;
      }
      if (scan) await this.store.checkpoint?.(active.repo, scan, names);
    } catch (err) {
      logger.warn(
        { err, repositoryId: this.active?.repo.id },
        'legacy worktree alias sweep incomplete; will retry',
      );
      await this.active?.walk.return(undefined).catch(() => undefined);
      if (this.active)
        await this.store
          .reset?.(this.active.repo)
          .catch((resetError) =>
            logger.warn(
              { err: resetError, repositoryId: this.active?.repo.id },
              'alias scan reset deferred',
            ),
          );
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
