import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { eq } from 'drizzle-orm';
import { lockRepositoryTasksKey, schema, type Database } from '@haive/database';
import { HAIVE_DATA_FILES, logger } from '@haive/shared';
import {
  chmodNoFollow,
  chownNoFollow,
  readFileNoFollow,
  lstatNoFollow,
  readdirNoFollow,
  removeFileIfNoFollow,
  removeNoFollow,
  rewriteFileIfNoFollow,
  writeFileNoFollow,
} from '@haive/shared/fs-safe';
import { markPlanMirrorDirty } from '@haive/shared/plan';
import {
  PROJECT_STATE_DIR,
  PROJECT_STATE_LIMITS,
  ProjectStateError,
  emptyProjectState,
  isClaimablePath,
  renderProjectState,
  type ProjectStateRecord,
} from '@haive/shared/project-state';
import { markProjectStateDirty } from '@haive/shared/project-state-outbox';
import {
  PLAN_JSON_MAX_BYTES,
  flushPlanMirrorForRepository,
  lockPlanMirror,
} from '../plan/mirror.js';
import { readBlob } from '../plan/projection-merge.js';
import { syncPlanFromCheckout } from '../plan/sync-checkout.js';
import { gitRun } from '../repo/git-exec.js';
import { gitOperationInProgress } from '../repo/git-operation.js';
import { refreshProjectState } from './refresh.js';
import {
  readProjectStateBase,
  rebaseProjectStateOnHeadLocked,
  syncProjectStateFromCheckout,
} from './sync.js';
import {
  loadPendingClaimConflicts,
  loadPendingRenderConflicts,
  loadPendingSettingConflicts,
  lockProjectState,
  overlayClaims,
  overlayEnvironment,
  overlayRender,
  overlaySettings,
} from './write.js';

type DbOrTx = Parameters<typeof markPlanMirrorDirty>[0];
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** What each set-aside path held before its restore: its bytes (null where absent, missing where unread)
 *  and its index entry as `mode sha` (null where unstaged). */
export interface KeptFile {
  bytes?: Buffer | null;
  index: string | null;
  /** Turns the index entry the restore left (HEAD's) back into `index`; set once the swap landed. */
  indexPatch?: Buffer;
  mode?: number;
  owner?: { uid: number; gid: number };
  untracked?: boolean;
  parents?: { path: string; owner: { uid: number; gid: number }; mode: number }[];
}
export type KeptFiles = Map<string, KeptFile>;

export type SetAsideResult =
  | { outcome: 'clean' }
  | { outcome: 'set-aside'; paths: string[]; kept: KeptFiles }
  | { outcome: 'refused'; file: string; reason: string }
  | { outcome: 'held'; holding: number };

/** What the check inside the caller's move transaction finds; it writes nothing, so a dirty file is
 *  `retry`: abort the transaction, set aside again, and try the move again. */
export type RestoreInTxResult = { outcome: 'clean' } | Refused | { outcome: 'retry' };

/** How many times a set-aside, or a move that finds a file rewritten, goes round before it gives up. */
export const MOVE_ATTEMPTS = 3;

/** How many tasks hold the checkout now; read inside each lock, before the first file is touched. */
export type CheckoutFence = (db: DbOrTx) => Promise<number>;
/** Runs the transaction that writes the files; a caller holding a merge-dir claim passes its section. */
export type RestoreSection = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

const STATE_PREFIX = `${PROJECT_STATE_DIR}/`;
const ABSENT_PLAN_HASH = 'absent';

type Refused = Extract<SetAsideResult, { outcome: 'refused' }>;

const refuse = (file: string, why: string): Refused => ({
  outcome: 'refused',
  file,
  reason: `${file} ${why}`,
});

const NOT_HAIVE = 'holds changes Haive did not write';

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Every projection path that differs from HEAD, is untracked or is ignored, and whether git sees a conflict. */
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
  // status --ignored lists an ignored directory whole; ls-files names each file in it.
  const ignored = await gitRun(repoPath, [
    '--no-optional-locks',
    'ls-files',
    '-z',
    '-o',
    '-i',
    '--exclude-standard',
    '--',
    PROJECT_STATE_DIR,
    HAIVE_DATA_FILES.plan,
    HAIVE_DATA_FILES.planMarkdown,
  ]);
  if (ignored.code !== 0) {
    throw new Error(`git ls-files failed: ${ignored.stderr.trim().slice(0, 300)}`);
  }
  for (const path of ignored.stdout.split('\0')) if (path.length > 0) paths.add(path);
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

const literal = (rel: string): string => `:(literal)${rel}`;

/** The blob the index holds for `rel`: null when it holds none, 'unmerged' when it holds a conflict. */
async function stagedOid(repoPath: string, rel: string): Promise<string | null | 'unmerged'> {
  const res = await gitRun(repoPath, [
    '--no-optional-locks',
    'ls-files',
    '-s',
    '-z',
    '--',
    literal(rel),
  ]);
  if (res.code !== 0) throw new Error(`git ls-files failed: ${res.stderr.trim().slice(0, 300)}`);
  let oid: string | null = null;
  for (const entry of res.stdout.split('\0')) {
    const m = /^\d+ ([0-9a-f]+) (\d)\t/.exec(entry);
    if (!m) continue;
    if (m[2] !== '0') return 'unmerged';
    oid = m[1]!;
  }
  return oid;
}

/** Why each path's mode differs from HEAD's, in the index or in the working tree. A blob id does not
 *  carry the mode, so a path HEAD lacks has none to differ from and is left to its bytes. */
async function modeChanges(
  repoPath: string,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const changed = new Map<string, string>();
  if (paths.length === 0) return changed;
  for (const side of ['index', 'tree'] as const) {
    const res = await gitRun(repoPath, [
      '--no-optional-locks',
      'diff-index',
      '--raw',
      '-z',
      '--no-renames',
      ...(side === 'index' ? ['--cached'] : []),
      'HEAD',
      '--',
      ...paths.map(literal),
    ]);
    if (res.code !== 0)
      throw new Error(`git diff-index failed: ${res.stderr.trim().slice(0, 300)}`);
    const fields = res.stdout.split('\0');
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const m = /^:(\d+) (\d+) /.exec(fields[i]!);
      if (!m || m[1] === m[2] || /^0+$/.test(m[2]!)) continue;
      // A path HEAD lacks is Haive's only as the regular file its writer creates.
      if (/^0+$/.test(m[1]!) && m[2] === '100644') continue;
      changed.set(fields[i + 1]!, `${side}:${m[1]}>${m[2]}`);
    }
  }
  // A path neither HEAD nor the index holds shows its type and mode only on disk.
  for (const path of paths) {
    if (changed.has(path) || (await headEntry(repoPath, path)) !== null) continue;
    if ((await indexEntry(repoPath, path)) !== null) continue;
    const entry = await lstatNoFollow(repoPath, path).catch(() => null);
    if (entry === null) continue;
    if (entry.kind !== 'file') changed.set(path, `tree:${entry.kind}`);
    else if ((Number(entry.stats.mode) & 0o111) !== 0) changed.set(path, 'tree:executable');
  }
  return changed;
}

async function headOid(repoPath: string, rel: string): Promise<string | null> {
  const res = await gitRun(repoPath, ['rev-parse', '--verify', '--quiet', `HEAD:${rel}`]);
  return res.code === 0 ? res.stdout.trim() : null;
}

/** Whether what the index holds for `rel` is HEAD's blob or exactly what Haive writes there, so that
 *  returning the path to HEAD discards nothing a person staged. */
async function stagedIsHaives(
  repoPath: string,
  rel: string,
  maxBytes: number,
  haives: (bytes: Buffer | null) => boolean,
): Promise<boolean> {
  const staged = await stagedOid(repoPath, rel);
  if (staged === 'unmerged') return false;
  if (staged === (await headOid(repoPath, rel))) return true;
  if (staged === null) return haives(null);
  const size = await gitRun(repoPath, ['cat-file', '-s', staged]);
  if (size.code !== 0 || Number(size.stdout.trim()) > maxBytes) return false;
  const bytes = await readBlob(repoPath, staged);
  return bytes !== null && haives(bytes);
}

// plan.md repeats a target's title (and an edge's note) once per edge, so it can outgrow the plan.json it renders.
const PLAN_MD_MAX_BYTES = 8 * PLAN_JSON_MAX_BYTES;

/** The most bytes the set-aside reads of a projection it may have to hold. */
function projectionCap(rel: string): number {
  if (rel.startsWith(STATE_PREFIX)) return PROJECT_STATE_LIMITS.maxFileBytes;
  return rel === HAIVE_DATA_FILES.planMarkdown ? PLAN_MD_MAX_BYTES : PLAN_JSON_MAX_BYTES;
}

/** The working-tree bytes, the index blob, any mode change and the owner of `rel` as one string, to tell later whether any moved. */
async function fingerprint(repoPath: string, rel: string): Promise<string> {
  const maxBytes = projectionCap(rel);
  let work = 'unreadable';
  try {
    const read = await readFileNoFollow(repoPath, rel, { maxBytes, strict: true });
    work = read === null ? 'absent' : read.truncated ? 'truncated' : sha256(read.data);
  } catch {
    work = 'unreadable';
  }
  const entry = await lstatNoFollow(repoPath, rel).catch(() => null);
  const owner = entry === null ? '' : `${entry.stats.uid}:${entry.stats.gid}`;
  return `${work}|${await stagedOid(repoPath, rel)}|${(await modeChanges(repoPath, [rel])).get(rel) ?? ''}|${owner}`;
}

/** The first dirty state file that is not what the sync base renders there, or null. The base is the
 *  record the files were last written from or read in as, with a pending conflict at the incoming
 *  side the writer renders into the file. */
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
  // With no sync row this install never wrote state, so no state change is Haive's.
  if (!row) return paths[0]!;
  let expected = new Map<string, string>();
  try {
    const base = { ...emptyProjectState(), ...(row.baseSnapshot as Partial<ProjectStateRecord>) };
    const render = await loadPendingRenderConflicts(db, repositoryId);
    const claims = await loadPendingClaimConflicts(db, repositoryId);
    const settings = await loadPendingSettingConflicts(db, repositoryId);
    expected = renderProjectState({
      ...base,
      render: overlayRender(base.render, render, 'incoming'),
      // A git-data claim the base lists is only there for the writer to remove its file.
      claims: overlayClaims(
        base.claims.filter((c) => isClaimablePath(c.path)),
        claims,
        'incoming',
      ),
      settings: overlaySettings(base.settings, settings, 'incoming'),
      environment: overlayEnvironment(base.environment, settings, 'incoming'),
    });
  } catch (err) {
    if (!(err instanceof ProjectStateError)) throw err;
    return paths[0]!;
  }
  const modes = await modeChanges(repoPath, paths);
  for (const path of paths) {
    const want = expected.get(path.slice(STATE_PREFIX.length));
    const wantBytes = want === undefined ? null : Buffer.from(want, 'utf8');
    const maxBytes = PROJECT_STATE_LIMITS.maxFileBytes;
    const ok =
      !modes.has(path) &&
      (await holds(repoPath, path, wantBytes, maxBytes)) &&
      (await stagedIsHaives(repoPath, path, maxBytes, (bytes) =>
        bytes === null ? wantBytes === null : wantBytes !== null && bytes.equals(wantBytes),
      ));
    if (!ok) return path;
  }
  return null;
}

/** plan.json must be what the last flush or read-in stamped, and the database must hold a plan to write it
 *  from again; plan.md is rendered from it on every flush and read by nobody, so only its mode is judged. */
async function planOffender(
  db: DbOrTx,
  repositoryId: string,
  repoPath: string,
  paths: readonly string[],
): Promise<string | null> {
  const [moded] = [...(await modeChanges(repoPath, paths)).keys()];
  if (moded !== undefined) return moded;
  if (!paths.includes(HAIVE_DATA_FILES.plan)) {
    if (!paths.includes(HAIVE_DATA_FILES.planMarkdown)) return null;
    const [held] = await db
      .select({ id: schema.planNodes.id })
      .from(schema.planNodes)
      .where(eq(schema.planNodes.repositoryId, repositoryId))
      .limit(1);
    return held ? null : HAIVE_DATA_FILES.planMarkdown;
  }
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
  if (read === null ? stamp !== ABSENT_PLAN_HASH : read.truncated || stamp !== sha256(read.data)) {
    return HAIVE_DATA_FILES.plan;
  }
  const stagedOk = await stagedIsHaives(
    repoPath,
    HAIVE_DATA_FILES.plan,
    PLAN_JSON_MAX_BYTES,
    (bytes) => (bytes === null ? stamp === ABSENT_PLAN_HASH : stamp === sha256(bytes)),
  );
  if (!stagedOk) return HAIVE_DATA_FILES.plan;
  const [held] = await db
    .select({ id: schema.planNodes.id })
    .from(schema.planNodes)
    .where(eq(schema.planNodes.repositoryId, repositoryId))
    .limit(1);
  return held ? null : HAIVE_DATA_FILES.plan;
}

async function planFilePresent(repoPath: string): Promise<boolean> {
  try {
    return (await readFileNoFollow(repoPath, HAIVE_DATA_FILES.plan, { maxBytes: 1 })) !== null;
  } catch {
    return true;
  }
}

/** Test seam: a function here runs at its point of the restore and may throw to stand for a crash. */
export const restoreFaults: {
  afterBase?: () => void | Promise<void>;
  afterRestore?: () => void | Promise<void>;
  beforeResync?: (domain: 'state' | 'plan') => void;
  beforeRestore?: () => void | Promise<void>;
  afterJudgeFence?: () => void | Promise<void>;
  beforeCapture?: () => void | Promise<void>;
  beforePutBack?: () => void | Promise<void>;
  beforeIndexSwap?: () => void | Promise<void>;
  beforeIndexPutBack?: () => void | Promise<void>;
  beforeKeptMetadata?: () => void | Promise<void>;
} = {};

interface RestoreGuard {
  owns: (path: string) => boolean;
  lock: (tx: Tx) => Promise<unknown>;
  judgeLock: (tx: Tx) => Promise<unknown>;
  offender: (tx: Tx) => Promise<string | null>;
  mark: (tx: Tx) => Promise<unknown>;
  base?: (tx: Tx) => Promise<unknown>;
  generation: (tx: Tx) => Promise<string>;
  fence: CheckoutFence | undefined;
}

type Changed = { changed: string };

/** First transaction, with the domain's lock held (not the task-creation lock: it writes no file): the files
 *  judged and the fence read, then the stale mark and the sync base at HEAD's record committed, so a crash
 *  before the files move finds the mark and a base the pending value still merges against. Nothing else is
 *  asked of the pool meanwhile. The generation read last is what the second transaction finds unchanged
 *  unless a sweep took the lock between. */
async function judgeAndMark(
  tx: Tx,
  repoPath: string,
  paths: readonly string[],
  guard: RestoreGuard,
): Promise<{ stopped: SetAsideResult } | { prints: Map<string, string>; generation: string }> {
  await guard.judgeLock(tx);
  const prints = new Map<string, string>();
  for (const path of paths) prints.set(path, await fingerprint(repoPath, path));
  const offender = await guard.offender(tx);
  if (offender) return { stopped: refuse(offender, NOT_HAIVE) };
  const holding = guard.fence ? await guard.fence(tx) : 0;
  await restoreFaults.afterJudgeFence?.();
  if (holding > 0) return { stopped: { outcome: 'held', holding } };
  await guard.mark(tx);
  await guard.base?.(tx);
  return { prints, generation: await guard.generation(tx) };
}

/** Second transaction: the files are still as the first judged them (or already at HEAD) and the base and
 *  mark rows are still as it committed them, then the restore, and `after` in the same transaction. */
async function restoreJudged(
  tx: Tx,
  repoPath: string,
  judged: { prints: Map<string, string>; generation: string },
  guard: RestoreGuard,
  kept: KeptFiles,
  after?: (tx: Tx) => Promise<void>,
): Promise<SetAsideResult | Changed | null> {
  await guard.lock(tx);
  const dirty = await dirtyProjections(repoPath);
  const mine = dirty.paths.filter((path) => guard.owns(path));
  for (const path of new Set([...mine, ...judged.prints.keys()])) {
    if (judged.prints.get(path) !== (await fingerprint(repoPath, path))) return { changed: path };
  }
  if (judged.generation !== (await guard.generation(tx)))
    return { changed: [...judged.prints.keys()][0] ?? '' };
  if (dirty.unmerged || (await gitOperationInProgress(repoPath))) {
    return refuse(
      mine[0] ?? dirty.paths[0] ?? '',
      'is part of a merge or rebase that is still open',
    );
  }
  const holding = guard.fence ? await guard.fence(tx) : 0;
  if (holding > 0) return { outcome: 'held', holding };
  await restoreFaults.beforeCapture?.();
  const captured: KeptFiles = new Map();
  for (const path of mine) {
    const bytes = await keptBytes(repoPath, path);
    const index = await indexEntry(repoPath, path);
    const entry = await lstatNoFollow(repoPath, path).catch(() => null);
    const mode = entry?.kind === 'file' ? Number(entry.stats.mode) & 0o7777 : undefined;
    const owner =
      entry?.kind === 'file' ? { uid: entry.stats.uid, gid: entry.stats.gid } : undefined;
    const untracked = (await headEntry(repoPath, path)) === null;
    captured.set(path, bytes === undefined ? { index } : { bytes, index, mode, owner, untracked });
  }
  // A write landing during the capture would be taken for Haive's: the judged state must still hold.
  for (const path of mine) {
    if (judged.prints.get(path) !== (await fingerprint(repoPath, path))) return { changed: path };
  }
  for (const [path, was] of captured) if (!kept.has(path)) kept.set(path, was);
  await restoreFaults.beforeRestore?.();
  const raced = await restoreFromHead(repoPath, mine, kept);
  if (typeof raced === 'string') return { changed: raced };
  if (raced !== null) return refuse(raced.path, raced.reason);
  await restoreFaults.afterRestore?.();
  await after?.(tx);
  return null;
}

/** The judged bytes of a path about to be restored: null when absent, undefined when they cannot be held. */
async function keptBytes(repoPath: string, rel: string): Promise<Buffer | null | undefined> {
  const maxBytes = projectionCap(rel);
  try {
    const read = await readFileNoFollow(repoPath, rel, { maxBytes, strict: true });
    if (read === null) return null;
    return read.truncated ? undefined : read.data;
  } catch {
    return undefined;
  }
}

/** The restore of one domain, in two transactions; `after` runs in the second once the files are restored. */
async function setAsideDomain(
  db: Database,
  repoPath: string,
  paths: readonly string[],
  guard: RestoreGuard,
  kept: KeptFiles,
  section: RestoreSection | undefined,
  after?: (tx: Tx) => Promise<void>,
): Promise<SetAsideResult | Changed | null> {
  const judged = await db.transaction((tx) => judgeAndMark(tx, repoPath, paths, guard));
  if ('stopped' in judged) return judged.stopped;
  await restoreFaults.afterBase?.();
  const restore = (tx: Tx) => restoreJudged(tx, repoPath, judged, guard, kept, after);
  return section ? section(restore) : db.transaction(restore);
}

/** With a fence the task-creation lock comes first, as in every other mover of the checkout: no task is created after the count. */
const guardLock =
  (
    repositoryId: string,
    fence: CheckoutFence | undefined,
    domain: (tx: Tx) => Promise<unknown>,
  ): RestoreGuard['lock'] =>
  async (tx) => {
    if (fence) await lockRepositoryTasksKey(tx, repositoryId);
    await domain(tx);
  };

const stateGuard = (
  repositoryId: string,
  repoPath: string,
  state: readonly string[],
  fence?: CheckoutFence,
): RestoreGuard => ({
  owns: (path) => path.startsWith(STATE_PREFIX),
  lock: guardLock(repositoryId, fence, (tx) => lockProjectState(tx, repositoryId)),
  judgeLock: (tx) => lockProjectState(tx, repositoryId),
  offender: (tx) => stateOffender(tx, repositoryId, repoPath, state),
  mark: (tx) => markProjectStateDirty(tx, repositoryId),
  base: (tx) => rebaseProjectStateOnHeadLocked(tx, { repositoryId, repoPath }),
  generation: (tx) => readProjectStateBase(tx, repositoryId),
  fence,
});

const planGuard = (
  repositoryId: string,
  repoPath: string,
  plan: readonly string[],
  fence?: CheckoutFence,
): RestoreGuard => ({
  owns: (path) => !path.startsWith(STATE_PREFIX),
  lock: guardLock(repositoryId, fence, (tx) => lockPlanMirror(tx, repositoryId)),
  judgeLock: (tx) => lockPlanMirror(tx, repositoryId),
  offender: (tx) => planOffender(tx, repositoryId, repoPath, plan),
  mark: (tx) => markPlanMirrorDirty(tx, repositoryId),
  generation: async (tx) =>
    JSON.stringify(await readMark(tx, schema.planMirrorState, repositoryId)),
  fence,
});

/** Puts each path back to HEAD, in the file and the index, only while it still holds what the set-aside
 *  captured; returns the first path written by someone else meanwhile, or not captured at all, which
 *  sends the set-aside round again. An intent-to-add entry, which git diff cannot show, comes back with its reason. */
async function restoreFromHead(
  repoPath: string,
  paths: readonly string[],
  kept: KeptFiles,
): Promise<string | { path: string; reason: string } | null> {
  for (const path of paths) {
    const captured = kept.get(path);
    const head = await readBlob(repoPath, `HEAD:${path}`);
    if (captured === undefined || captured.bytes === undefined) return path;
    const was = captured.bytes;
    const maxBytes = Math.max(head?.length ?? 0, was?.length ?? 0) + 1;
    if (head !== null && was === null) {
      const headMode = await headFileMode(repoPath, path);
      try {
        await writeFileNoFollow(repoPath, path, head, {
          mode: 'create-exclusive',
          createParents: true,
          fileMode: headMode,
        });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return path;
        throw err;
      }
    } else if (head !== null && was !== null) {
      const res = await rewriteFileIfNoFollow(
        repoPath,
        path,
        (now, mode) => (now.equals(was) && (mode & 0o7777) === captured.mode ? head : null),
        { maxBytes },
      );
      if (res !== 'rewritten') return path;
    } else if (was !== null) {
      const res = await removeFileIfNoFollow(
        repoPath,
        path,
        (now, mode, owner) =>
          now.equals(was) &&
          (mode & 0o7777) === captured.mode &&
          owner.uid === captured.owner?.uid &&
          owner.gid === captured.owner?.gid,
        {
          maxBytes,
        },
      );
      if (res !== 'removed') return path;
    }
    if ((await indexEntry(repoPath, path)) !== captured.index) return path;
    const headIdx = await headEntry(repoPath, path);
    if (headIdx !== captured.index) {
      const patch = await indexToHeadPatch(repoPath, path);
      if (patch.length === 0) {
        if ((await indexEntry(repoPath, path)) !== captured.index) return path;
        return {
          path,
          reason: `is marked intent-to-add in the index; unstage it (git reset -- ${path}) or stage it fully, then retry`,
        };
      }
      if (patchPreimage(patch) !== captured.index) return path;
      await restoreFaults.beforeIndexSwap?.();
      if (!(await swapIndexEntry(repoPath, path, patch, false, captured.index, headIdx)))
        return path;
      captured.indexPatch ??= patch;
    }
    if (head === null) await pruneEmptyStateDirs(repoPath, path, kept);
  }
  return null;
}

/** A directory left empty under the state directory reads as a record with no format file, not as no record. */
async function pruneEmptyStateDirs(
  repoPath: string,
  removed: string,
  kept: KeptFiles,
): Promise<void> {
  if (!removed.startsWith(STATE_PREFIX)) return;
  const entry = kept.get(removed);
  // Only the first attempt's snapshot: a later attempt finds the directories as the writer re-created them.
  const snapshot = entry !== undefined && entry.parents === undefined ? entry : null;
  for (let dir = posix.dirname(removed); dir.length >= PROJECT_STATE_DIR.length;) {
    if (((await readdirNoFollow(repoPath, dir)) ?? ['.']).length > 0) return;
    if (snapshot) {
      const info = await lstatNoFollow(repoPath, dir);
      if (info?.kind === 'directory') {
        const { uid, gid, mode } = info.stats;
        (snapshot.parents ??= []).push({ path: dir, owner: { uid, gid }, mode: mode & 0o7777 });
      }
    }
    await removeNoFollow(repoPath, dir);
    dir = posix.dirname(dir);
  }
}

/** Puts Haive's own pending projection files (`.haive-data/state/**`, `plan.json`, `plan.md`) aside before
 *  a move of the checkout: the database holds what they say, so each one is returned to HEAD and the
 *  mark that says the files are stale is raised first, which a crash then finds. A file that is not what
 *  Haive last wrote, in the working tree or in the index, refuses the move and is named. After the move,
 *  `resyncHaiveProjections` brings the new head in and writes the pending changes over it. */
export async function setAsideHaiveProjections(
  db: Database,
  repositoryId: string,
  repoPath: string,
  fence?: CheckoutFence,
  sections?: { restore: RestoreSection; putBack: RestoreSection },
): Promise<SetAsideResult> {
  const restored = new Set<string>();
  const kept: KeptFiles = new Map();
  // A stop after anything was captured puts it back, since no move follows; the put-back skips what was not restored.
  const stop = async (result: SetAsideResult): Promise<SetAsideResult> => {
    if (kept.size > 0)
      await putBackProjections(db, repositoryId, repoPath, kept, sections?.putBack);
    return result;
  };
  let busy = '';
  for (let attempt = 1; attempt <= MOVE_ATTEMPTS; attempt++) {
    let result: Awaited<ReturnType<typeof setAsideOnce>>;
    try {
      result = await setAsideOnce(
        db,
        repositoryId,
        repoPath,
        restored,
        kept,
        fence,
        sections?.restore,
      );
    } catch (err) {
      return putBackAfterFailure(db, repositoryId, repoPath, kept, err, sections?.putBack);
    }
    if (!('changed' in result)) {
      if (result.outcome === 'clean' && restored.size > 0) {
        return { outcome: 'set-aside', paths: [...restored].sort(), kept };
      }
      return result.outcome === 'held' || result.outcome === 'refused' ? stop(result) : result;
    }
    busy = result.changed;
  }
  return stop(
    refuse(busy, 'was rewritten again while it was set aside; the move was not attempted, retry'),
  );
}

async function setAsideOnce(
  db: Database,
  repositoryId: string,
  repoPath: string,
  restored: Set<string>,
  kept: KeptFiles,
  fence?: CheckoutFence,
  section?: RestoreSection,
): Promise<SetAsideResult | Changed> {
  const dirty = await dirtyProjections(repoPath);
  if (dirty.paths.length === 0) return { outcome: 'clean' };
  const holdingEarly = fence ? await fence(db) : 0;
  if (holdingEarly > 0) return { outcome: 'held', holding: holdingEarly };
  if (dirty.unmerged || (await gitOperationInProgress(repoPath))) {
    return refuse(dirty.paths[0]!, 'is part of a merge or rebase that is still open');
  }
  const stray = dirty.paths.find(
    (p) =>
      !p.startsWith(STATE_PREFIX) &&
      p !== HAIVE_DATA_FILES.plan &&
      p !== HAIVE_DATA_FILES.planMarkdown,
  );
  if (stray) return refuse(stray, 'is not a file Haive writes there');
  const state = dirty.paths.filter((p) => p.startsWith(STATE_PREFIX));
  const plan = dirty.paths.filter((p) => !p.startsWith(STATE_PREFIX));

  if (state.length > 0) {
    await syncProjectStateFromCheckout(db, {
      repositoryId,
      repoPath,
      refuseDuringGitOperation: true,
    }).catch((err: unknown) =>
      logger.warn({ err, repositoryId }, 'project state not synced before a checkout move'),
    );
  }
  const early =
    (await stateOffender(db, repositoryId, repoPath, state)) ??
    (await planOffender(db, repositoryId, repoPath, plan));
  if (early === HAIVE_DATA_FILES.plan && !(await planFilePresent(repoPath))) {
    return refuse(
      early,
      'was deleted with the plan, and that deletion is not saved yet; save the plan to commit it, then retry',
    );
  }
  if (early) return refuse(early, NOT_HAIVE);

  if (state.length > 0) {
    const stopped = await setAsideDomain(
      db,
      repoPath,
      state,
      stateGuard(repositoryId, repoPath, state, fence),
      kept,
      section,
      (tx) => rebaseProjectStateOnHeadLocked(tx, { repositoryId, repoPath }),
    );
    if (stopped) return stopped;
    for (const path of state) restored.add(path);
    await markProjectStateDirty(db, repositoryId);
  }
  if (plan.length > 0) {
    const stopped = await setAsideDomain(
      db,
      repoPath,
      plan,
      planGuard(repositoryId, repoPath, plan, fence),
      kept,
      section,
    );
    if (stopped) return stopped;
    for (const path of plan) restored.add(path);
    await markPlanMirrorDirty(db, repositoryId);
  }
  return { outcome: 'set-aside', paths: dirty.paths, kept };
}

/** The check again, inside the caller's transaction and under both writers' locks, immediately before
 *  the move: a sweep that rewrote a file after `setAsideHaiveProjections` returned cannot do so again
 *  until the transaction ends. Takes the locks in the documented order, project state then plan mirror.
 *  It writes nothing: a file still pending is `retry`, and the caller ends its transaction without
 *  moving, sets aside again, and tries the move again. Never reads the network. */
export async function restoreProjectionsInTx(
  tx: Tx,
  repositoryId: string,
  repoPath: string,
): Promise<RestoreInTxResult> {
  await lockProjectState(tx, repositoryId);
  await lockPlanMirror(tx, repositoryId);
  const dirty = await dirtyProjections(repoPath);
  if (dirty.paths.length === 0) return { outcome: 'clean' };
  if (dirty.unmerged || (await gitOperationInProgress(repoPath))) {
    return refuse(dirty.paths[0]!, 'is part of a merge or rebase that is still open');
  }
  const stray = dirty.paths.find(
    (p) =>
      !p.startsWith(STATE_PREFIX) &&
      p !== HAIVE_DATA_FILES.plan &&
      p !== HAIVE_DATA_FILES.planMarkdown,
  );
  if (stray) return refuse(stray, 'is not a file Haive writes there');
  return { outcome: 'retry' };
}

async function readMark(
  db: DbOrTx,
  table: typeof schema.projectStateOutbox | typeof schema.planMirrorState,
  repositoryId: string,
) {
  const [row] = await db
    .select({ revision: table.revision, written: table.writtenRevision })
    .from(table)
    .where(eq(table.repositoryId, repositoryId))
    .limit(1);
  return row ?? null;
}

async function isDirty(
  db: Database,
  table: typeof schema.projectStateOutbox | typeof schema.planMirrorState,
  repositoryId: string,
): Promise<boolean> {
  const row = await readMark(db, table, repositoryId);
  return row !== null && row.written < row.revision;
}

/** After a move of the checkout: reads the new head's record and plan in, then writes what this install
 *  still has pending over them. A step that fails here leaves its mark raised, so the sweep retries it.
 *  Whether both halves re-synced: false while a merge or rebase is open, when either threw, or when the
 *  state sync was held, superseded or refused or its pending write did not run. A sync deferred to a
 *  live onboarding or upgrade counts as done: that task re-syncs when it ends. */
export async function resyncHaiveProjections(
  db: Database,
  repositoryId: string,
  repoPath: string,
): Promise<boolean> {
  // A merge or rebase still open holds an intermediate record: nothing is read in until it ends.
  if (await gitOperationInProgress(repoPath)) return false;
  let synced = true;
  try {
    restoreFaults.beforeResync?.('state');
    const { outcome } = await syncProjectStateFromCheckout(db, {
      repositoryId,
      repoPath,
      refuseDuringGitOperation: true,
    });
    if (outcome === 'held' || outcome === 'superseded' || outcome === 'refused') synced = false;
    if (
      (await isDirty(db, schema.projectStateOutbox, repositoryId)) &&
      !(await refreshProjectState(db, repositoryId)) &&
      outcome !== 'deferred'
    ) {
      synced = false;
    }
  } catch (err) {
    synced = false;
    logger.warn({ err, repositoryId }, 'project state not re-synced after a checkout move');
    await raiseMarkAfterFailure(db, schema.projectStateOutbox, repositoryId, markProjectStateDirty);
  }
  try {
    restoreFaults.beforeResync?.('plan');
    await syncPlanFromCheckout(db, repositoryId, repoPath);
    if (await isDirty(db, schema.planMirrorState, repositoryId)) {
      await flushPlanMirrorForRepository(db, repositoryId);
    }
  } catch (err) {
    synced = false;
    logger.warn({ err, repositoryId }, 'plan not re-synced after a checkout move');
    await raiseMarkAfterFailure(db, schema.planMirrorState, repositoryId, markPlanMirrorDirty);
  }
  return synced;
}

/** The re-sync an onboarding or upgrade owes when it ends, since the sync deferred while it held the
 *  checkout. Call it with no transaction open and the status write committed. Never throws. */
export async function resyncAfterTaskEnd(db: Database, taskId: string): Promise<void> {
  try {
    const task = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, taskId),
      columns: { type: true, repositoryId: true },
    });
    if (!task?.repositoryId || (task.type !== 'onboarding' && task.type !== 'onboarding_upgrade')) {
      return;
    }
    const repo = await db.query.repositories.findFirst({
      where: eq(schema.repositories.id, task.repositoryId),
      columns: { storagePath: true, localPath: true },
    });
    const repoPath = repo?.storagePath ?? repo?.localPath;
    if (repoPath) await resyncHaiveProjections(db, task.repositoryId, repoPath);
  } catch (err) {
    logger.warn({ err, taskId }, 'project state not re-synced after a task ended');
  }
}

const metadataWarn = (repoPath: string, path: string) => (err: unknown) =>
  logger.warn({ err, repoPath, path }, 'owner and mode not restored after a checkout move');

/** The mode fs-safe's createExclusive gives a file it creates; a file at any other mode was changed since. */
const WRITER_FILE_MODE = 0o644;

/** After the re-sync: an untracked projection the set-aside removed, and the directories it pruned, are new now and
 *  get back their owner and mode while the writer still owns them; a group or file mode changed meanwhile stays. */
export async function restoreKeptMetadata(repoPath: string, kept: KeptFiles): Promise<void> {
  await restoreFaults.beforeKeptMetadata?.();
  const writer = process.getuid?.();
  for (const [path, { bytes, owner, mode, untracked, parents }] of kept) {
    await restoreKeptParents(repoPath, parents);
    if (!untracked || !Buffer.isBuffer(bytes) || !owner || mode === undefined) continue;
    const warn = metadataWarn(repoPath, path);
    try {
      const now = await lstatNoFollow(repoPath, path);
      if (now?.kind !== 'file' || now.stats.uid !== writer) continue;
      await chownNoFollow(repoPath, path, keptOwner(owner, now.stats.gid)).catch(warn);
      await chmodNoFollow(repoPath, path, (current) =>
        (current & ~0o111) === WRITER_FILE_MODE ? (mode & ~0o111) | (current & 0o111) : current,
      );
    } catch (err) {
      warn(err);
    }
  }
}

/** The captured owner, keeping a group someone set since: the writer's own gid is the only one it gives a new node. */
function keptOwner(
  owner: { uid: number; gid: number },
  gidNow: number,
): { uid: number; gid: number } {
  return { uid: owner.uid, gid: gidNow === process.getgid?.() ? owner.gid : gidNow };
}

/** The directory half of `restoreKeptMetadata`, deepest first, which the put-back shares. Never throws. */
async function restoreKeptParents(repoPath: string, parents: KeptFile['parents']): Promise<void> {
  const writer = process.getuid?.();
  for (const { path, owner, mode } of parents ?? []) {
    const warn = metadataWarn(repoPath, path);
    try {
      const now = await lstatNoFollow(repoPath, path);
      if (now?.kind !== 'directory' || now.stats.uid !== writer) continue;
      await chownNoFollow(repoPath, path, keptOwner(owner, now.stats.gid)).catch(warn);
      await chmodNoFollow(repoPath, path, mode);
    } catch (err) {
      warn(err);
    }
  }
}

/** After a set-aside that ends with no move: writes each kept file back as the set-aside found it, unless
 *  someone has written it since. The marks stay raised, so the sweep reconciles the rest later. A failure
 *  is thrown: a staged entry it could not put back is the person's, and no sweep can rebuild it. */
export async function putBackProjections(
  db: Database,
  repositoryId: string,
  repoPath: string,
  kept: KeptFiles,
  section?: RestoreSection,
): Promise<void> {
  if (kept.size === 0) return;
  await restoreFaults.beforePutBack?.();
  await (section ?? ((fn) => db.transaction(fn)))(async (tx) => {
    await lockProjectState(tx, repositoryId);
    await lockPlanMirror(tx, repositoryId);
    // Each path is swapped only while it still holds what the restore left (HEAD's blob, or nothing).
    for (const [path, { bytes, index, indexPatch, mode, owner, parents }] of kept) {
      await putBackIndex(repoPath, path, index, indexPatch);
      if (bytes === undefined) continue;
      const head = await readBlob(repoPath, `HEAD:${path}`);
      const maxBytes = Math.max(head?.length ?? 0, bytes?.length ?? 0) + 1;
      if (head === null) {
        if (bytes === null) continue;
        try {
          await writeFileNoFollow(repoPath, path, bytes, {
            mode: 'create-exclusive',
            createParents: true,
            fileMode: mode,
          });
          if (owner) await chownNoFollow(repoPath, path, owner).catch(() => undefined);
          await restoreKeptParents(repoPath, parents);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        }
      } else if (bytes === null) {
        const headMode = await headFileMode(repoPath, path);
        await removeFileIfNoFollow(
          repoPath,
          path,
          (now, onDisk, owner) =>
            now.equals(head) && (onDisk & 0o7777) === headMode && owner.uid === process.getuid?.(),
          { maxBytes },
        );
      } else {
        await rewriteFileIfNoFollow(repoPath, path, (now) => (now.equals(head) ? bytes : null), {
          maxBytes,
        });
      }
    }
  });
}

/** The put-back when the caller is failing: the snapshot dies with the call, so a put-back that fails too
 *  is thrown with the first error and names the files, rather than dropped. */
export async function putBackAfterFailure(
  db: Database,
  repositoryId: string,
  repoPath: string,
  kept: KeptFiles,
  err: unknown,
  section?: RestoreSection,
): Promise<never> {
  try {
    await putBackProjections(db, repositoryId, repoPath, kept, section);
  } catch (putErr) {
    const paths = [...kept.keys()].sort();
    logger.error(
      {
        err: putErr,
        failure: err instanceof Error ? err.message : String(err),
        repositoryId,
        paths,
      },
      'set-aside files not put back',
    );
    throw new AggregateError(
      [err, putErr],
      `${err instanceof Error ? err.message : String(err)}; Haive's set-aside files (${paths.join(', ')}) could not be put back: ${putErr instanceof Error ? putErr.message : String(putErr)}`,
    );
  }
  throw err;
}

/** A throw around the move: while HEAD is still `before` the files go back as the set-aside found them;
 *  once the move landed, the old bytes would hide the incoming change, so the re-sync brings them over. */
export async function recoverAfterMoveFailure(
  db: Database,
  repositoryId: string,
  repoPath: string,
  kept: KeptFiles,
  before: string,
  err: unknown,
  section?: RestoreSection,
): Promise<never> {
  const head = await gitRun(repoPath, ['rev-parse', 'HEAD']);
  if (head.code === 0 && head.stdout.trim() !== before) {
    await resyncHaiveProjections(db, repositoryId, repoPath).catch((resyncErr: unknown) =>
      logger.error(
        { err: resyncErr, repositoryId },
        'projections not re-synced after a failed move',
      ),
    );
    await restoreKeptMetadata(repoPath, kept);
    throw err;
  }
  return putBackAfterFailure(db, repositoryId, repoPath, kept, err, section);
}

/** The mode the restore gives a file it recreates from HEAD. */
async function headFileMode(repoPath: string, path: string): Promise<number> {
  return (await headEntry(repoPath, path))?.startsWith('100755') ? 0o755 : 0o644;
}

/** A path's index entry as `mode sha`, or null when nothing is staged there. */
async function indexEntry(repoPath: string, path: string): Promise<string | null> {
  const res = await gitRun(repoPath, ['ls-files', '-s', '-z', '--', literal(path)]);
  if (res.code !== 0) throw new Error(`git ls-files failed: ${res.stderr.trim().slice(0, 300)}`);
  const m = /^(\d+) ([0-9a-f]+) 0\t/.exec(res.stdout);
  return m ? `${m[1]} ${m[2]}` : null;
}

async function headEntry(repoPath: string, path: string): Promise<string | null> {
  const res = await gitRun(repoPath, ['ls-tree', '-z', 'HEAD', '--', literal(path)]);
  if (res.code !== 0) return null;
  const m = /^(\d+) blob ([0-9a-f]+)\t/.exec(res.stdout);
  return m ? `${m[1]} ${m[2]}` : null;
}

/** The patch that turns the index entry of `path` into HEAD's; latin1 keeps every byte of a non-UTF-8 blob. */
async function indexToHeadPatch(repoPath: string, path: string): Promise<Buffer> {
  const res = await gitRun(
    repoPath,
    [
      '--no-optional-locks',
      'diff',
      '--cached',
      '-R',
      '--no-color',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '-U2147483647',
      '--binary',
      '--full-index',
      '--no-textconv',
      '--no-ext-diff',
      '--',
      literal(path),
    ],
    undefined,
    // The patch holds both images in full context, a binary one a quarter larger each.
    { encoding: 'latin1', maxBuffer: 3 * projectionCap(path) + 2 ** 20 },
  );
  if (res.code !== 0) {
    const why = res.stderr.trim().slice(0, 300);
    throw new Error(
      why === ''
        ? `the staged copy of ${path} is too large to set aside`
        : `git diff failed: ${why}`,
    );
  }
  return Buffer.from(res.stdout, 'latin1');
}

const PATCH_HEADER =
  /^(?:diff --git .*|(new file mode|deleted file mode|old mode|new mode) (\d+)|index ([0-9a-f]+)\.\.[0-9a-f]+(?: (\d+))?)$/;

/** The index entry (`mode sha`, null for none) the patch expects; undefined where its header names none. */
function patchPreimage(patch: Buffer): string | null | undefined {
  let created = false;
  let mode: string | undefined;
  let blob: string | undefined;
  for (const line of patch.toString('latin1', 0, 4096).split('\n')) {
    const m = PATCH_HEADER.exec(line);
    if (!m) break;
    if (m[1] === 'new file mode') created = true;
    else if (m[1] === 'deleted file mode' || m[1] === 'old mode') mode = m[2];
    else if (m[3] !== undefined) {
      blob = m[3];
      mode ??= m[4];
    }
  }
  if (created) return null;
  return blob !== undefined && mode !== undefined ? `${mode} ${blob}` : undefined;
}

/** git checks the patch against the index entry and writes the result under one index lock, so no writer lands between. */
function applyIndexPatch(repoPath: string, patch: Buffer, reverse: boolean) {
  const flags = ['--cached', '--whitespace=nowarn', ...(reverse ? ['-R'] : [])];
  return gitRun(repoPath, ['-c', 'apply.ignoreWhitespace=no', 'apply', ...flags, '-'], undefined, {
    input: patch,
  });
}

/** git matches hunk context only, so a result other than `to` is a blend with a concurrent blob and is undone. */
async function swapIndexEntry(
  repoPath: string,
  path: string,
  patch: Buffer,
  reverse: boolean,
  from: string | null,
  to: string | null,
): Promise<boolean> {
  const res = await applyIndexPatch(repoPath, patch, reverse);
  const now = await indexEntry(repoPath, path);
  if (res.code !== 0) {
    if (now === from) throw new Error(`git apply failed: ${res.stderr.trim().slice(0, 300)}`);
    return false;
  }
  if (now === to) return true;
  const undo = await applyIndexPatch(repoPath, patch, !reverse);
  if (undo.code !== 0 && (await indexEntry(repoPath, path)) === now) {
    throw new Error(
      `git apply could not undo a blended index entry: ${undo.stderr.trim().slice(0, 300)}`,
    );
  }
  return false;
}

/** Stages the entry the set-aside found again, only while the index still holds what the restore left. */
async function putBackIndex(
  repoPath: string,
  path: string,
  original: string | null,
  patch: Buffer | undefined,
): Promise<void> {
  const left = await headEntry(repoPath, path);
  if (original === left || (await indexEntry(repoPath, path)) !== left) return;
  // No patch means the restore never swapped this entry, so whatever sits there now is someone else's.
  if (patch === undefined) return;
  await restoreFaults.beforeIndexPutBack?.();
  await swapIndexEntry(repoPath, path, patch, true, left, original);
}

/** A failed re-sync leaves the domain's mark raised so the sweep retries it; a repository with no row
 *  has nothing Haive writes there yet, and gets none. */
async function raiseMarkAfterFailure(
  db: Database,
  table: typeof schema.projectStateOutbox | typeof schema.planMirrorState,
  repositoryId: string,
  mark: (db: Database, repositoryId: string) => Promise<void>,
): Promise<void> {
  try {
    if ((await readMark(db, table, repositoryId)) !== null) await mark(db, repositoryId);
  } catch (err) {
    logger.warn({ err, repositoryId }, 'stale mark not raised after a failed re-sync');
  }
}
