import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { HAIVE_DATA_FILES, logger } from '@haive/shared';
import { readFileNoFollow, readdirNoFollow, removeNoFollow } from '@haive/shared/fs-safe';
import { markPlanMirrorDirty } from '@haive/shared/plan';
import {
  PROJECT_STATE_DIR,
  PROJECT_STATE_LIMITS,
  ProjectStateError,
  emptyProjectState,
  renderProjectState,
  type ProjectStateRecord,
} from '@haive/shared/project-state';
import { markProjectStateDirty } from '@haive/shared/project-state-outbox';
import {
  PLAN_JSON_MAX_BYTES,
  flushPlanMirrorForRepository,
  lockPlanMirror,
} from '../plan/mirror.js';
import { syncPlanFromCheckout } from '../plan/sync-checkout.js';
import { gitRun } from '../repo/git-exec.js';
import { gitOperationInProgress } from '../repo/git-operation.js';
import { refreshProjectState } from './refresh.js';
import { rebaseProjectStateOnCheckout, syncProjectStateFromCheckout } from './sync.js';
import { lockProjectState } from './write.js';

type DbOrTx = Parameters<typeof markPlanMirrorDirty>[0];
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export type SetAsideResult =
  | { outcome: 'clean' }
  | { outcome: 'set-aside'; paths: string[] }
  | { outcome: 'refused'; file: string; reason: string }
  | { outcome: 'held'; holding: number };

/** How many tasks hold the checkout now; read inside each lock, before the first file is touched. */
export type CheckoutFence = (db: DbOrTx) => Promise<number>;

const STATE_PREFIX = `${PROJECT_STATE_DIR}/`;
const ABSENT_PLAN_HASH = 'absent';

const refuse = (file: string, why: string): SetAsideResult => ({
  outcome: 'refused',
  file,
  reason: `${file} ${why}`,
});

const NOT_HAIVE = 'holds changes Haive did not write';

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Every projection path that differs from HEAD or is untracked, and whether git sees a conflict. */
async function dirtyProjections(repoPath: string): Promise<{ paths: string[]; unmerged: boolean }> {
  const res = await gitRun(repoPath, [
    '--no-optional-locks',
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--',
    PROJECT_STATE_DIR,
    HAIVE_DATA_FILES.plan,
    HAIVE_DATA_FILES.planMarkdown,
  ]);
  if (res.code !== 0) throw new Error(`git status failed: ${res.stderr.trim().slice(0, 300)}`);
  const paths = new Set<string>();
  let unmerged = false;
  const fields = res.stdout.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (field.length < 4) continue;
    const [x, y] = [field[0]!, field[1]!];
    paths.add(field.slice(3));
    if ('RC'.includes(x) || 'RC'.includes(y)) paths.add(fields[++i]!);
    if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
      unmerged = true;
    }
  }
  return { paths: [...paths].sort(), unmerged };
}

/** Whether the file holds exactly `want`, or is absent when `want` is null. */
async function holds(repoPath: string, rel: string, want: Buffer | null, maxBytes: number) {
  let read;
  try {
    read = await readFileNoFollow(repoPath, rel, { maxBytes, strict: true });
  } catch {
    return false;
  }
  if (read === null) return want === null;
  return want !== null && !read.truncated && read.data.equals(want);
}

/** The first dirty state file that is not what the sync base renders there, or null. The base is the
 *  record the files were last written from or read in as. */
async function stateOffender(
  db: DbOrTx,
  repositoryId: string,
  repoPath: string,
  paths: readonly string[],
): Promise<string | null> {
  if (paths.length === 0) return null;
  const [row] = await db
    .select({ baseSnapshot: schema.projectStateSync.baseSnapshot })
    .from(schema.projectStateSync)
    .where(eq(schema.projectStateSync.repositoryId, repositoryId))
    .limit(1);
  let expected = new Map<string, string>();
  if (row) {
    try {
      expected = renderProjectState({
        ...emptyProjectState(),
        ...(row.baseSnapshot as Partial<ProjectStateRecord>),
      });
    } catch (err) {
      if (!(err instanceof ProjectStateError)) throw err;
      return paths[0]!;
    }
  }
  for (const path of paths) {
    const want = expected.get(path.slice(STATE_PREFIX.length));
    const ok = await holds(
      repoPath,
      path,
      want === undefined ? null : Buffer.from(want, 'utf8'),
      PROJECT_STATE_LIMITS.maxFileBytes,
    );
    if (!ok) return path;
  }
  return null;
}

/** plan.json must be what the last flush or read-in stamped, and the database must hold a plan to write it
 *  from again; plan.md is rendered from it on every flush and read by nobody, so it is never judged. */
async function planOffender(
  db: DbOrTx,
  repositoryId: string,
  repoPath: string,
  paths: readonly string[],
): Promise<string | null> {
  if (!paths.includes(HAIVE_DATA_FILES.plan)) return null;
  const [row] = await db
    .select({ syncedHash: schema.planMirrorState.syncedHash })
    .from(schema.planMirrorState)
    .where(eq(schema.planMirrorState.repositoryId, repositoryId))
    .limit(1);
  const stamp = row?.syncedHash ?? null;
  if (stamp === null) return HAIVE_DATA_FILES.plan;
  let read;
  try {
    read = await readFileNoFollow(repoPath, HAIVE_DATA_FILES.plan, {
      maxBytes: PLAN_JSON_MAX_BYTES,
      strict: true,
    });
  } catch {
    return HAIVE_DATA_FILES.plan;
  }
  if (read === null) return stamp === ABSENT_PLAN_HASH ? null : HAIVE_DATA_FILES.plan;
  if (read.truncated || stamp !== sha256(read.data)) return HAIVE_DATA_FILES.plan;
  const [held] = await db
    .select({ id: schema.planNodes.id })
    .from(schema.planNodes)
    .where(eq(schema.planNodes.repositoryId, repositoryId))
    .limit(1);
  return held ? null : HAIVE_DATA_FILES.plan;
}

/** The restore under the domain's lock, with the fence read there and the stale mark raised first.
 *  A restore that throws raises the mark again, since the transaction took the first one back. */
async function restoreUnderLock(
  db: Database,
  repoPath: string,
  paths: readonly string[],
  guard: {
    lock: (tx: Tx) => Promise<unknown>;
    offender: (tx: Tx) => Promise<string | null>;
    mark: (tx: DbOrTx) => Promise<unknown>;
    fence: CheckoutFence | undefined;
  },
): Promise<SetAsideResult | null> {
  try {
    return await db.transaction(async (tx) => {
      await guard.lock(tx);
      const offender = await guard.offender(tx);
      if (offender) return refuse(offender, NOT_HAIVE);
      const holding = guard.fence ? await guard.fence(tx) : 0;
      if (holding > 0) return { outcome: 'held' as const, holding };
      await guard.mark(tx);
      await restoreFromHead(repoPath, paths);
      return null;
    });
  } catch (err) {
    await guard.mark(db).catch(() => undefined);
    throw err;
  }
}

async function restoreFromHead(repoPath: string, paths: readonly string[]): Promise<void> {
  const tracked: string[] = [];
  const own: string[] = [];
  for (const path of paths) {
    const inHead = await gitRun(repoPath, ['cat-file', '-e', `HEAD:${path}`]);
    (inHead.code === 0 ? tracked : own).push(path);
  }
  if (tracked.length > 0) {
    const res = await gitRun(repoPath, ['checkout', '-q', 'HEAD', '--', ...tracked]);
    if (res.code !== 0) throw new Error(`git checkout failed: ${res.stderr.trim().slice(0, 300)}`);
  }
  for (const path of own) {
    await gitRun(repoPath, ['rm', '--cached', '-q', '--ignore-unmatch', '--', path]);
    await removeNoFollow(repoPath, path);
    await pruneEmptyStateDirs(repoPath, path);
  }
}

/** A directory left empty under the state directory reads as a record with no format file, not as no record. */
async function pruneEmptyStateDirs(repoPath: string, removed: string): Promise<void> {
  if (!removed.startsWith(STATE_PREFIX)) return;
  for (let dir = posix.dirname(removed); dir.length >= PROJECT_STATE_DIR.length;) {
    if (((await readdirNoFollow(repoPath, dir)) ?? ['.']).length > 0) return;
    await removeNoFollow(repoPath, dir);
    dir = posix.dirname(dir);
  }
}

/** Puts Haive's own pending projection files (`.haive-data/state/**`, `plan.json`, `plan.md`) aside before
 *  a move of the checkout: the database holds what they say, so each one is returned to HEAD and the
 *  mark that says the files are stale is raised first, which a crash then finds. A file that is not what
 *  Haive last wrote refuses the move and is named. After the move, `resyncHaiveProjections` brings the
 *  new head in and writes the pending changes over it. */
export async function setAsideHaiveProjections(
  db: Database,
  repositoryId: string,
  repoPath: string,
  fence?: CheckoutFence,
): Promise<SetAsideResult> {
  const dirty = await dirtyProjections(repoPath);
  if (dirty.paths.length === 0) return { outcome: 'clean' };
  const holdingEarly = fence ? await fence(db) : 0;
  if (holdingEarly > 0) return { outcome: 'held', holding: holdingEarly };
  if (dirty.unmerged || (await gitOperationInProgress(repoPath))) {
    return refuse(dirty.paths[0]!, 'is part of a merge or rebase that is still open');
  }
  const state = dirty.paths.filter((p) => p.startsWith(STATE_PREFIX));
  const plan = dirty.paths.filter((p) => !p.startsWith(STATE_PREFIX));

  if (state.length > 0) {
    await syncProjectStateFromCheckout(db, { repositoryId, repoPath }).catch((err: unknown) =>
      logger.warn({ err, repositoryId }, 'project state not synced before a checkout move'),
    );
  }
  const early =
    (await stateOffender(db, repositoryId, repoPath, state)) ??
    (await planOffender(db, repositoryId, repoPath, plan));
  if (early) return refuse(early, NOT_HAIVE);

  if (state.length > 0) {
    const stopped = await restoreUnderLock(db, repoPath, state, {
      lock: (tx) => lockProjectState(tx, repositoryId),
      offender: (tx) => stateOffender(tx, repositoryId, repoPath, state),
      mark: (tx) => markProjectStateDirty(tx, repositoryId),
      fence,
    });
    if (stopped) return stopped;
    await rebaseProjectStateOnCheckout(db, { repositoryId, repoPath });
    await markProjectStateDirty(db, repositoryId);
  }
  if (plan.length > 0) {
    const stopped = await restoreUnderLock(db, repoPath, plan, {
      lock: (tx) => lockPlanMirror(tx, repositoryId),
      offender: (tx) => planOffender(tx, repositoryId, repoPath, plan),
      mark: (tx) => markPlanMirrorDirty(tx, repositoryId),
      fence,
    });
    if (stopped) return stopped;
    await markPlanMirrorDirty(db, repositoryId);
  }
  return { outcome: 'set-aside', paths: dirty.paths };
}

async function isDirty(
  db: Database,
  table: typeof schema.projectStateOutbox | typeof schema.planMirrorState,
  repositoryId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ revision: table.revision, written: table.writtenRevision })
    .from(table)
    .where(eq(table.repositoryId, repositoryId))
    .limit(1);
  return row !== undefined && row.written < row.revision;
}

/** After a move of the checkout: reads the new head's record and plan in, then writes what this install
 *  still has pending over them. A step that fails here leaves its mark raised, so the sweep retries it. */
export async function resyncHaiveProjections(
  db: Database,
  repositoryId: string,
  repoPath: string,
): Promise<void> {
  try {
    await syncProjectStateFromCheckout(db, { repositoryId, repoPath });
    if (await isDirty(db, schema.projectStateOutbox, repositoryId)) {
      await refreshProjectState(db, repositoryId);
    }
  } catch (err) {
    logger.warn({ err, repositoryId }, 'project state not re-synced after a checkout move');
  }
  try {
    await syncPlanFromCheckout(db, repositoryId, repoPath);
    if (await isDirty(db, schema.planMirrorState, repositoryId)) {
      await flushPlanMirrorForRepository(db, repositoryId);
    }
  } catch (err) {
    logger.warn({ err, repositoryId }, 'plan not re-synced after a checkout move');
  }
}
