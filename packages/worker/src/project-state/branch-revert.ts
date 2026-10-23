import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { and, asc, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { HAIVE_DATA_DIR, HAIVE_DATA_FILES } from '@haive/shared';
import { lstatNoFollow, removeNoFollow, type EntryKind } from '@haive/shared/fs-safe';
import { isBranchName } from '@haive/shared/git-args';
import { PROJECT_STATE_DIR } from '@haive/shared/project-state';
import { GIT_MAX_BUFFER, gitRun, type GitRunResult } from '../repo/git-exec.js';
import { workspaceAnchor } from '../repo/worktree-paths.js';
import { resolveGitEnv } from '../secrets/user-git-identity.js';
import { handBackAfterMove, isHaiveProjection, revParse } from '../step-engine/git-merge.js';
import type { StepContext } from '../step-engine/step-definition.js';
import { addStepWarning } from '../step-engine/step-ownership.js';

/** The task event recorded each time a branch had its Haive files put back. */
export const PROJECTIONS_PUT_BACK_EVENT = 'branch.projections_put_back';

type RevertCtx = Pick<
  StepContext,
  'db' | 'userId' | 'taskId' | 'taskStepId' | 'repoPath' | 'logger'
>;

/** What a put-back did: the paths, its commit, the branch tip it replaced and the fork point. */
export interface ProjectionRevert {
  paths: string[];
  commit: string;
  preRevertSha: string;
  mergeBase: string;
}

const PROJECTION_PATHSPECS = [
  PROJECT_STATE_DIR,
  HAIVE_DATA_FILES.plan,
  HAIVE_DATA_FILES.planMarkdown,
] as const;
const LITERAL = { GIT_LITERAL_PATHSPECS: '1' };
// latin1 keeps each byte of a name as one character, so a name that is not UTF-8 goes back to git as read.
const LISTING = { maxBuffer: GIT_MAX_BUFFER, encoding: 'latin1' } as const;
const FALLBACK_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Haive',
  GIT_AUTHOR_EMAIL: 'worker@haive.local',
  GIT_COMMITTER_NAME: 'Haive',
  GIT_COMMITTER_EMAIL: 'worker@haive.local',
};
const SUBJECT = "Put back Haive's project files to where this branch forked";
const ZERO_MODE = '000000';
const MESSAGE_PATHS = 50;
const EVENT_PATHS = 100;
const NOTE_PATHS = 10;

interface Change {
  path: string;
  srcMode: string;
  srcSha: string;
}

interface Edits {
  mergeBase: string;
  tip: string;
  changes: Change[];
}

const display = (name: string): string => Buffer.from(name, 'latin1').toString('utf8');

function detail(res: GitRunResult): string {
  return (res.stderr || res.stdout).trim().split('\n').slice(0, 3).join(' ').slice(0, 300);
}

function parseRaw(out: string): Change[] {
  const parts = out.split('\0');
  const found: Change[] = [];
  for (let i = 0; i + 1 < parts.length && parts[i]!.startsWith(':'); i += 2) {
    const [srcMode = '', , srcSha = ''] = parts[i]!.slice(1).split(' ');
    found.push({ path: parts[i + 1]!, srcMode, srcSha });
  }
  return found;
}

async function resolveTarget(
  repoPath: string,
  names: string | readonly string[],
): Promise<string | null> {
  for (const name of typeof names === 'string' ? [names] : names) {
    if (!isBranchName(name)) continue;
    for (const ref of [`refs/heads/${name}`, `refs/remotes/${name}`]) {
      const sha = await revParse(repoPath, `${ref}^{commit}`);
      if (sha !== null) return sha;
    }
  }
  return null;
}

async function changesBetween(repoPath: string, mergeBase: string, tip: string): Promise<Change[]> {
  const diff = await gitRun(
    repoPath,
    ['diff-tree', '-r', '-z', '--no-renames', mergeBase, tip, '--', ...PROJECTION_PATHSPECS],
    LITERAL,
    LISTING,
  );
  if (diff.code !== 0) throw new Error(`git diff-tree failed: ${detail(diff)}`);
  return parseRaw(diff.stdout).filter((c) => isHaiveProjection(c.path));
}

// Null when the branch changed none of them, shares no history with the target, or either is not here.
async function readEdits(
  repoPath: string,
  branch: string,
  target: string | readonly string[],
): Promise<Edits | null> {
  if (!isBranchName(branch)) return null;
  const tip = await revParse(repoPath, `refs/heads/${branch}^{commit}`);
  const base = tip === null ? null : await resolveTarget(repoPath, target);
  if (tip === null || base === null) return null;
  const found = await gitRun(repoPath, ['merge-base', base, tip]);
  if (found.code === 1) return null;
  if (found.code !== 0) throw new Error(`git merge-base failed: ${detail(found)}`);
  const mergeBase = found.stdout.trim();
  const changes = await changesBetween(repoPath, mergeBase, tip);
  return changes.length === 0 ? null : { mergeBase, tip, changes };
}

const KIND_TEXT: Record<EntryKind, string> = {
  file: 'a file',
  directory: 'a directory',
  symlink: 'a link',
  other: 'not a directory',
};

async function refuseLinkedDataDir(
  repoPath: string,
  worktree: string | null,
  branch: string,
  tip: string,
): Promise<void> {
  if (worktree !== null) {
    const { anchor, prefix } = workspaceAnchor(worktree);
    const entry = await lstatNoFollow(anchor, `${prefix}${HAIVE_DATA_DIR}`);
    if (entry !== null && entry.kind !== 'directory') {
      throw new Error(
        `${HAIVE_DATA_DIR} is ${KIND_TEXT[entry.kind]} in the worktree ${worktree}, so Haive's project files on ${branch} cannot be put back; make it the directory it should be, then retry`,
      );
    }
  }
  const listed = await gitRun(repoPath, ['ls-tree', '-z', tip, '--', HAIVE_DATA_DIR], LITERAL);
  if (listed.code !== 0) throw new Error(`git ls-tree failed: ${detail(listed)}`);
  const mode = listed.stdout.split(' ', 1)[0] ?? '';
  if (mode !== '' && mode !== '040000') {
    throw new Error(
      `${HAIVE_DATA_DIR} is not a directory at the tip of ${branch}, so Haive's project files on it cannot be put back; commit it as the directory it should be, then retry`,
    );
  }
}

// Removals go first: a path that became a directory (or a file) cannot be added beside the one it replaces.
function indexRecords(changes: readonly Change[]): Buffer {
  const records = [...changes]
    .sort((a, b) => Number(b.srcMode === ZERO_MODE) - Number(a.srcMode === ZERO_MODE))
    // An absent side's id is diff-tree's null id, as long as the repository's object format needs.
    .map((c) => `${c.srcMode} ${c.srcSha}\t${c.path}\0`);
  return Buffer.from(records.join(''), 'latin1');
}

async function buildTree(repoPath: string, edits: Edits): Promise<string> {
  const name = `branch-revert-index-${randomUUID()}`;
  const env = { GIT_INDEX_FILE: path.join(os.tmpdir(), name) };
  try {
    const read = await gitRun(repoPath, ['read-tree', edits.tip], env);
    if (read.code !== 0) throw new Error(`git read-tree failed: ${detail(read)}`);
    const update = await gitRun(repoPath, ['update-index', '--add', '-z', '--index-info'], env, {
      input: indexRecords(edits.changes),
    });
    if (update.code !== 0) throw new Error(`git update-index failed: ${detail(update)}`);
    const tree = await gitRun(repoPath, ['write-tree'], env);
    if (tree.code !== 0) throw new Error(`git write-tree failed: ${detail(tree)}`);
    return tree.stdout.trim();
  } finally {
    await removeNoFollow(os.tmpdir(), name).catch(() => false);
  }
}

interface WorktreeSync {
  dir: string;
  clean: Change[];
  edited: Change[];
}

// What a sync cut short has not reached: the changes whose index entry is still the one `tip` held.
async function stillOnTip(
  worktree: string,
  tip: string,
  changes: readonly Change[],
): Promise<Change[]> {
  const res = await gitRun(
    worktree,
    ['diff-index', '--cached', '-r', '-z', '--no-renames', tip, '--', ...PROJECTION_PATHSPECS],
    LITERAL,
    LISTING,
  );
  if (res.code !== 0) throw new Error(`git diff-index failed: ${detail(res)}`);
  const moved = new Set(parseRaw(res.stdout).map((c) => c.path));
  return changes.filter((c) => !moved.has(c.path));
}

async function syncable(worktree: string, branch: string): Promise<boolean> {
  const { anchor, prefix } = workspaceAnchor(worktree);
  const held = await lstatNoFollow(anchor, prefix.replace(/\/$/, ''));
  if (held?.kind !== 'directory') return false;
  const head = await gitRun(worktree, ['symbolic-ref', '-q', 'HEAD']);
  // With -q only a detached HEAD exits 1; any other failure is git unable to read the worktree.
  if (head.code !== 0 && head.code !== 1)
    throw new Error(`git symbolic-ref failed: ${detail(head)}`);
  return head.code === 0 && head.stdout.trim() === `refs/heads/${branch}`;
}

// Read while HEAD is still the old tip: a path beside an edit keeps its file, and only its index moves.
// With `movedFrom` the branch is past that tip already, so it plans what the index still holds of it.
async function planSync(
  worktree: string | null,
  branch: string,
  changes: readonly Change[],
  movedFrom: string | null = null,
): Promise<WorktreeSync | null> {
  if (worktree === null || !(await syncable(worktree, branch))) return null;
  const pending = movedFrom === null ? changes : await stillOnTip(worktree, movedFrom, changes);
  if (pending.length === 0) return null;
  const status = await gitRun(
    worktree,
    [
      '--no-optional-locks',
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--ignored=matching',
      '--no-renames',
      '--',
      ...PROJECTION_PATHSPECS,
    ],
    LITERAL,
    LISTING,
  );
  if (status.code !== 0) throw new Error(`git status failed: ${detail(status)}`);
  // Past the move the index differs from HEAD by design, so only an entry's worktree column marks an edit.
  const dirty = status.stdout
    .split('\0')
    .filter((entry) => entry.length > 3 && (movedFrom === null || entry[1] !== ' '))
    .map((entry) => entry.slice(3).replace(/\/$/, ''));
  const beside = (p: string) =>
    dirty.some((d) => d === p || d.startsWith(`${p}/`) || p.startsWith(`${d}/`));
  return {
    dir: worktree,
    clean: pending.filter((c) => !beside(c.path)),
    edited: pending.filter((c) => beside(c.path)),
  };
}

async function syncWorktree(plan: WorktreeSync, commit: string, preRevert: string): Promise<void> {
  // One restore cannot both remove `a/b` and write `a` over its directory, so removals go first.
  const removed = plan.clean.filter((c) => c.srcMode === ZERO_MODE);
  const restored = plan.clean.filter((c) => c.srcMode !== ZERO_MODE);
  for (const group of [removed, restored]) {
    if (group.length === 0) continue;
    const res = await gitRun(
      plan.dir,
      [
        'restore',
        `--source=${commit}`,
        '--staged',
        '--worktree',
        '--pathspec-from-file=-',
        '--pathspec-file-nul',
      ],
      LITERAL,
      { input: Buffer.from(group.map((c) => c.path).join('\0'), 'latin1') },
    );
    if (res.code !== 0) {
      throw new Error(`the worktree could not be brought to the new tip: ${detail(res)}`);
    }
  }
  if (plan.clean.length > 0) await handBackAfterMove(plan.dir, preRevert, true);
  if (plan.edited.length > 0) {
    const realigned = await gitRun(
      plan.dir,
      ['update-index', '--add', '-z', '--index-info'],
      {},
      {
        input: indexRecords(plan.edited),
      },
    );
    if (realigned.code !== 0) {
      throw new Error(
        `the worktree's index could not be moved to the new tip: ${detail(realigned)}`,
      );
    }
  }
}

function messageFor(mergeBase: string, names: readonly string[]): string {
  const listed = names.slice(0, MESSAGE_PATHS).map((n) => `- ${JSON.stringify(n)}`);
  if (names.length > MESSAGE_PATHS) listed.push(`- and ${names.length - MESSAGE_PATHS} more`);
  return [
    SUBJECT,
    '',
    `Haive owns these files and a task branch does not change them. They are back as they were at ${mergeBase.slice(0, 12)}:`,
    '',
    ...listed,
  ].join('\n');
}

interface Recorded {
  branch: string;
  commit: string;
  preRevertSha: string;
  mergeBase: string;
  synced: boolean;
}

const isSha = (v: unknown): v is string =>
  typeof v === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(v);

function recordedOf(payload: unknown): Recorded | null {
  const { branch, commit, preRevertSha, mergeBase, synced } = (payload ?? {}) as Record<
    string,
    unknown
  >;
  if (typeof branch !== 'string' || !isSha(commit) || !isSha(preRevertSha) || !isSha(mergeBase)) {
    return null;
  }
  return { branch, commit, preRevertSha, mergeBase, synced: synced === true };
}

async function putBackPayloads(db: Database, taskId: string): Promise<unknown[]> {
  const rows = await db
    .select({ payload: schema.taskEvents.payload })
    .from(schema.taskEvents)
    .where(
      and(
        eq(schema.taskEvents.taskId, taskId),
        eq(schema.taskEvents.eventType, PROJECTIONS_PUT_BACK_EVENT),
      ),
    )
    .orderBy(asc(schema.taskEvents.createdAt));
  return rows.map((row) => row.payload);
}

async function record(ctx: RevertCtx, branch: string, revert: ProjectionRevert): Promise<void> {
  await ctx.db.insert(schema.taskEvents).values({
    taskId: ctx.taskId,
    taskStepId: ctx.taskStepId,
    eventType: PROJECTIONS_PUT_BACK_EVENT,
    payload: {
      branch,
      ...revert,
      paths: revert.paths.slice(0, EVENT_PATHS),
      pathCount: revert.paths.length,
    },
  });
}

async function dropRecord(ctx: RevertCtx, commit: string): Promise<void> {
  await ctx.db
    .delete(schema.taskEvents)
    .where(
      and(
        eq(schema.taskEvents.taskId, ctx.taskId),
        eq(schema.taskEvents.eventType, PROJECTIONS_PUT_BACK_EVENT),
        sql`${schema.taskEvents.payload}->>'commit' = ${commit}`,
      ),
    );
}

// The worktree has the put-back too, its hand-back included, so a later pass has nothing to finish.
async function markSynced(ctx: RevertCtx, commit: string): Promise<void> {
  await ctx.db
    .update(schema.taskEvents)
    .set({
      payload: sql`${schema.taskEvents.payload} || ${JSON.stringify({ synced: true })}::jsonb`,
    })
    .where(
      and(
        eq(schema.taskEvents.taskId, ctx.taskId),
        eq(schema.taskEvents.eventType, PROJECTIONS_PUT_BACK_EVENT),
        sql`${schema.taskEvents.payload}->>'commit' = ${commit}`,
      ),
    );
}

// The record is written first, so a refusal here is the one case that takes it back.
async function moveBranch(ctx: RevertCtx, branch: string, revert: ProjectionRevert): Promise<void> {
  const moved = await gitRun(ctx.repoPath, [
    'update-ref',
    '-m',
    'put back Haive project files',
    `refs/heads/${branch}`,
    revert.commit,
    revert.preRevertSha,
  ]);
  if (moved.code !== 0) {
    await dropRecord(ctx, revert.commit);
    throw new Error(`${branch} moved while its Haive files were being put back: ${detail(moved)}`);
  }
}

// A commit gone from the repository is in no history; git's other failures stop the pass, as in `readEdits`.
async function isAncestor(repoPath: string, commit: string, tip: string): Promise<boolean> {
  if ((await revParse(repoPath, `${commit}^{commit}`)) === null) return false;
  const res = await gitRun(repoPath, ['merge-base', '--is-ancestor', commit, tip]);
  if (res.code !== 0 && res.code !== 1) throw new Error(`git merge-base failed: ${detail(res)}`);
  return res.code === 0;
}

function logPutBack(ctx: RevertCtx, branch: string, revert: ProjectionRevert): void {
  ctx.logger.info(
    {
      branch,
      commit: revert.commit,
      preRevertSha: revert.preRevertSha,
      paths: revert.paths.length,
    },
    "Haive's project files put back on the task branch",
  );
}

/** Ends the put-back this task last recorded for `branch` if a pass was cut short in it, and drops
 *  the record of one that never landed; null when this pass has a put-back of its own to make. */
async function resumePutBack(args: {
  ctx: RevertCtx;
  worktree: string | null;
  branch: string;
}): Promise<ProjectionRevert | null> {
  const { ctx, worktree, branch } = args;
  if (!isBranchName(branch)) return null;
  const recorded = (await putBackPayloads(ctx.db, ctx.taskId))
    .map(recordedOf)
    .filter((r): r is Recorded => r !== null && r.branch === branch)
    .at(-1);
  if (recorded === undefined) return null;
  const tip = await revParse(ctx.repoPath, `refs/heads/${branch}^{commit}`);
  if (tip === null) return null;
  const { commit, preRevertSha, mergeBase } = recorded;
  const landed = tip === commit;
  const unmoved =
    tip === preRevertSha && (await revParse(ctx.repoPath, `${commit}^`)) === preRevertSha;
  if (!landed && !unmoved) {
    if (!(await isAncestor(ctx.repoPath, commit, tip))) await dropRecord(ctx, commit);
    return null;
  }
  const changes = await changesBetween(ctx.repoPath, mergeBase, preRevertSha);
  const result = {
    paths: changes.map((c) => display(c.path)).sort(),
    commit,
    preRevertSha,
    mergeBase,
  };
  if (landed) {
    if (recorded.synced) return result;
    const sync = await planSync(worktree, branch, changes, preRevertSha);
    const pending = sync === null ? 0 : sync.clean.length + sync.edited.length;
    // An earlier pass restored what is no longer pending and may have died before handing it back.
    const handBackOnly =
      pending < changes.length &&
      (sync === null || sync.clean.length === 0) &&
      worktree !== null &&
      (await syncable(worktree, branch));
    if (sync !== null || handBackOnly) {
      await refuseLinkedDataDir(ctx.repoPath, worktree, branch, tip);
    }
    if (sync !== null) await syncWorktree(sync, commit, preRevertSha);
    if (handBackOnly) await handBackAfterMove(worktree!, preRevertSha, true);
    await markSynced(ctx, commit);
    if (sync !== null) logPutBack(ctx, branch, result);
    return result;
  }
  await refuseLinkedDataDir(ctx.repoPath, worktree, branch, tip);
  const sync = await planSync(worktree, branch, changes);
  await moveBranch(ctx, branch, result);
  if (sync) await syncWorktree(sync, commit, preRevertSha);
  await markSynced(ctx, commit);
  logPutBack(ctx, branch, result);
  return result;
}

/** Puts every Haive file `branch` changed since it forked from `target` back, in one commit; null if none. */
export async function revertHaiveProjectionsOnBranch(args: {
  ctx: RevertCtx;
  worktree: string | null;
  branch: string;
  target: string | readonly string[];
}): Promise<ProjectionRevert | null> {
  const { ctx, worktree, branch } = args;
  const resumed = await resumePutBack({ ctx, worktree, branch });
  if (resumed !== null) return resumed;
  const edits = await readEdits(ctx.repoPath, branch, args.target);
  if (edits === null) return null;
  await refuseLinkedDataDir(ctx.repoPath, worktree, branch, edits.tip);
  const sync = await planSync(worktree, branch, edits.changes);
  const tree = await buildTree(ctx.repoPath, edits);
  const names = edits.changes.map((c) => display(c.path)).sort();
  const userEnv = await resolveGitEnv(ctx.db, { userId: ctx.userId, taskId: ctx.taskId });
  const made = await gitRun(
    ctx.repoPath,
    ['commit-tree', tree, '-p', edits.tip, '-m', messageFor(edits.mergeBase, names)],
    Object.keys(userEnv).length > 0 ? userEnv : FALLBACK_GIT_IDENTITY,
  );
  if (made.code !== 0) throw new Error(`git commit-tree failed: ${detail(made)}`);
  const commit = made.stdout.trim();
  const result = { paths: names, commit, preRevertSha: edits.tip, mergeBase: edits.mergeBase };
  await record(ctx, branch, result);
  await moveBranch(ctx, branch, result);
  if (sync) await syncWorktree(sync, commit, edits.tip);
  await markSynced(ctx, commit);
  logPutBack(ctx, branch, result);
  return result;
}

/** The Haive files `branch` changed since it forked from `target`, for a form to show; writes nothing. */
export async function listBranchProjectionEdits(args: {
  repoPath: string;
  branch: string;
  target: string | readonly string[];
}): Promise<string[]> {
  const edits = await readEdits(args.repoPath, args.branch, args.target);
  return edits === null ? [] : edits.changes.map((c) => display(c.path)).sort();
}

function noteOf(payload: unknown): string | null {
  const p = payload as {
    branch?: unknown;
    paths?: unknown;
    pathCount?: unknown;
    commit?: unknown;
    preRevertSha?: unknown;
    mergeBase?: unknown;
  } | null;
  if (
    !p ||
    typeof p.branch !== 'string' ||
    typeof p.commit !== 'string' ||
    typeof p.preRevertSha !== 'string' ||
    typeof p.mergeBase !== 'string' ||
    !Array.isArray(p.paths)
  ) {
    return null;
  }
  const paths = p.paths.filter((x): x is string => typeof x === 'string');
  const count = typeof p.pathCount === 'number' ? p.pathCount : paths.length;
  const listed = paths.slice(0, NOTE_PATHS).map((x) => JSON.stringify(x));
  const more = count - listed.length;
  return `Haive put back ${count} of its own project files on ${p.branch}, since a task branch must not change them: ${listed.join(', ')}${more > 0 ? ` and ${more} more` : ''}. They are as they were where the branch forked (${p.mergeBase.slice(0, 7)}), in commit ${p.commit.slice(0, 7)}; the branch's own version stays in commit ${p.preRevertSha.slice(0, 7)} until git removes it. To change one, use the repository's settings.`;
}

/** One warning note per time this task had Haive files put back, oldest first. */
export async function projectionRevertNotes(db: Database, taskId: string): Promise<string[]> {
  return (await putBackPayloads(db, taskId)).flatMap((payload) => {
    const note = noteOf(payload);
    return note === null ? [] : [note];
  });
}

/** Puts the branch's Haive files back and returns every warning note this task has for them. */
export async function putBackProjections(args: {
  ctx: RevertCtx;
  worktree: string | null;
  branch: string;
  target: string | readonly string[];
}): Promise<string[]> {
  await revertHaiveProjectionsOnBranch(args);
  return projectionRevertNotes(args.ctx.db, args.ctx.taskId);
}

/** Adds each note to the step's warning once. */
export async function warnStep(
  ctx: Pick<StepContext, 'db' | 'taskStepId'>,
  notes: readonly string[],
): Promise<void> {
  if (notes.length === 0) return;
  let row = await ctx.db.query.taskSteps.findFirst({
    where: eq(schema.taskSteps.id, ctx.taskStepId),
  });
  if (!row) return;
  for (const note of notes) row = await addStepWarning(ctx.db, row, note);
}
