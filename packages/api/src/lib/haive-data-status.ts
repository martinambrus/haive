import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { isRootClaimLive, schema, type Database } from '@haive/database';
import {
  CHECKOUT_HOLDING_TASK_STATUSES,
  HAIVE_DATA_FILES,
  logger,
  PLAN_MERGE_LIVE_STATUSES,
} from '@haive/shared';
import { lstatNoFollow } from '@haive/shared/fs-safe';
import { GIT_OPERATION_STATE_ENTRIES, hardenGitArgs } from '@haive/shared/git-args';
import {
  holdsFor,
  type HaiveDataFacts,
  type HaiveDataFile,
  type HaiveDataReadHold,
  type HaiveDataStatus,
} from '@haive/shared/haive-data';
import { scrubErrorPaths } from '@haive/shared/logger';
import { PROJECT_STATE_DIR } from '@haive/shared/project-state';
import { isAllowedGitRemoteUrl, redactGitText } from '@haive/shared/schemas';

/* The facts below are the ones the worker's locked check builds (`factsAt`,
 * worker/src/project-state/save.ts), read without its locks and re-implemented here because the api
 * must not import worker code. Both end in `holdsFor`, so a hold the page shows is a hold the Save
 * answers; a read that fails is a read hold, never "no hold". */

const exec = promisify(execFile);

/** A listing that outgrows this is no answer: execFile kills git and the read reads as failed. */
const GIT_READ_MAX_BUFFER = 1024 * 1024;

const RECORD_PATHSPECS = [
  HAIVE_DATA_FILES.plan,
  HAIVE_DATA_FILES.planMarkdown,
  `${PROJECT_STATE_DIR}/`,
].map((rel) => `:(literal)${rel}`);

/** The hardened read of `gitRead` (routes/plan.ts), with the output left as git wrote it: a `-z`
 *  record can start or end with a space, and a trimmed read would shift it. */
async function gitRaw(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: Buffer; code: number | null }> {
  try {
    const { stdout } = await exec('git', hardenGitArgs(args), {
      cwd,
      encoding: 'buffer',
      timeout: 5_000,
      maxBuffer: GIT_READ_MAX_BUFFER,
      env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(cwd) },
    });
    return { ok: true, stdout, code: 0 };
  } catch (err) {
    const e = err as { stdout?: Buffer; code?: unknown };
    return {
      ok: false,
      stdout: e.stdout ?? Buffer.alloc(0),
      code: typeof e.code === 'number' ? e.code : null,
    };
  }
}

/** `requireUsableGit` (worker repo/git-workspace.ts): false for a checkout with no `.git`, true for
 *  one git accepts as a work tree, and a throw for a `.git` that is a link, sits behind one, or that
 *  git refuses, none of which says "no git". */
async function hasUsableGit(repoPath: string): Promise<boolean> {
  const entry = await lstatNoFollow(repoPath, '.git', { strict: true });
  if (entry === null) return false;
  if (entry.kind === 'symlink') throw new Error('.git is a symbolic link');
  const inside = await gitRaw(repoPath, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout.toString().trim() !== 'true')
    throw new Error('git does not accept .git');
  return true;
}

/** `gitOperationInProgress` (worker repo/git-operation.ts): an entry of the git dir exists. A read
 *  that fails throws, and a git dir outside the checkout counts as open. */
async function gitOperationOpen(repoPath: string): Promise<boolean> {
  for (const entry of GIT_OPERATION_STATE_ENTRIES) {
    const located = await gitRaw(repoPath, ['rev-parse', '--git-path', entry]);
    if (!located.ok) throw new Error(`git rev-parse --git-path ${entry} failed`);
    const where = located.stdout.toString().trim();
    if (!where) continue;
    const rel = path.isAbsolute(where) ? path.relative(repoPath, where) : where;
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return true;
    if ((await lstatNoFollow(repoPath, rel, { strict: true })) !== null) return true;
  }
  return false;
}

async function currentBranch(repoPath: string): Promise<string | null> {
  const branch = await gitRaw(repoPath, ['branch', '--show-current']);
  if (!branch.ok) throw new Error('could not read the checkout branch');
  return branch.stdout.toString().trim() || null;
}

/** `detectOrigin` (worker repo/git-push.ts): exit 2 on the fetch read alone is "no origin", and
 *  any other failure or an address the remote rule refuses is unknown. */
async function hasOrigin(repoPath: string): Promise<boolean> {
  for (const push of [false, true]) {
    const read = await gitRaw(repoPath, [
      'remote',
      'get-url',
      ...(push ? ['--push'] : []),
      '--all',
      'origin',
    ]);
    if (!push && read.code === 2) return false;
    if (!read.ok) throw new Error('could not read the origin');
    for (const url of read.stdout.toString().trim().split('\n')) {
      if (!isAllowedGitRemoteUrl(url)) throw new Error('the origin address is not allowed');
    }
  }
  return true;
}

function describeChange(xy: string): Pick<HaiveDataFile, 'change' | 'staged'> {
  if (xy === '??') return { change: 'untracked', staged: false };
  const x = xy[0];
  const y = xy[1];
  // An unmerged path holds the sides of a conflict in the index, not a change anyone staged.
  if (x === 'U' || y === 'U' || xy === 'AA' || xy === 'DD')
    return { change: 'modified', staged: false };
  const staged = x !== ' ';
  if (x === 'A' || y === 'A') return { change: 'added', staged };
  if (x === 'D' || y === 'D') return { change: 'deleted', staged };
  return { change: 'modified', staged };
}

/** Split before decoding: invalid filename bytes would otherwise collapse distinct names onto
 *  the same replacement character and Map key. Refuse the whole listing rather than invent names. */
function listingEntries(output: Buffer): string[] | null {
  const entries: string[] = [];
  let start = 0;
  while (start < output.length) {
    const end = output.indexOf(0, start);
    if (end === -1) return null;
    const bytes = output.subarray(start, end);
    const entry = bytes.toString('utf8');
    if (!Buffer.from(entry, 'utf8').equals(bytes)) return null;
    if (entry) entries.push(entry);
    start = end + 1;
  }
  return entries;
}

/** One entry per path under the plan files and the state directory, from the index (`ls-files`)
 *  and the working copy (`status`), or null when git could not list them. */
async function readFiles(repoPath: string): Promise<HaiveDataFile[] | null> {
  const [tracked, changed] = await Promise.all([
    gitRaw(repoPath, ['ls-files', '-z', '--', ...RECORD_PATHSPECS]),
    gitRaw(repoPath, [
      '--no-optional-locks',
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--no-renames',
      '--',
      ...RECORD_PATHSPECS,
    ]),
  ]);
  if (!tracked.ok || !changed.ok) return null;
  const trackedEntries = listingEntries(tracked.stdout);
  const changedEntries = listingEntries(changed.stdout);
  if (trackedEntries === null || changedEntries === null) return null;
  const files = new Map<string, HaiveDataFile>();
  for (const rel of trackedEntries) {
    if (rel) files.set(rel, { path: rel, change: 'unchanged', staged: false });
  }
  for (const entry of changedEntries) {
    // `XY path`: a staged deletion whose file is back on disk is listed twice. Together they
    // describe a present, modified file with an index change, whichever git prints first.
    if (!entry) continue;
    const rel = entry.slice(3);
    const xy = entry.slice(0, 2);
    const prior = files.get(rel);
    if (xy === '??' && prior) {
      if (prior.change === 'deleted' && prior.staged) prior.change = 'modified';
      continue;
    }
    if (xy === 'D ' && prior?.change === 'untracked') {
      files.set(rel, { path: rel, change: 'modified', staged: true });
      continue;
    }
    files.set(rel, { path: rel, ...describeChange(xy) });
  }
  return [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const scrub = (text: string | null | undefined): string | null =>
  text ? redactGitText(scrubErrorPaths(text)) : null;

export interface HaiveDataRepo {
  id: string;
  storagePath: string | null;
  localPath: string | null;
  rootClaimedAt: Date | null;
}

// Polls retain full diagnostics at debug after the first warning. Bound the process-local memo
// so visiting many repositories cannot retain their keys forever; evicted keys may warn again.
const warnedReads = new Set<string>();
const WARNED_READ_LIMIT = 256;

function logReadFailure(repositoryId: string, what: string, err: unknown): void {
  const code = err && typeof err === 'object' && 'code' in err ? err.code : null;
  const key = JSON.stringify([
    repositoryId,
    what,
    typeof code === 'string' || typeof code === 'number' ? code : null,
  ]);
  const message = `Haive data status ${what} read failed`;
  if (warnedReads.has(key)) {
    logger.debug({ err, repositoryId }, message);
    return;
  }
  if (warnedReads.size >= WARNED_READ_LIMIT) warnedReads.delete(warnedReads.values().next().value!);
  warnedReads.add(key);
  logger.warn({ err, repositoryId }, message);
}

export async function readHaiveDataStatus(
  db: Pick<Database, 'select'>,
  repo: HaiveDataRepo,
): Promise<HaiveDataStatus> {
  const repoPath = repo.storagePath ?? repo.localPath;
  const warn = (err: unknown, what: string) => logReadFailure(repo.id, what, err);
  const readHolds: HaiveDataReadHold[] = [];
  let missing = !repoPath;
  if (repoPath) {
    try {
      missing = (await lstatNoFollow(repoPath, '', { strict: true })) === null;
    } catch (err) {
      warn(err, 'checkout');
      readHolds.push({ code: 'checkout_unreadable' });
    }
  }
  let checkout: HaiveDataFacts['checkout'] = missing ? 'missing' : 'not_git';
  if (repoPath && !missing && readHolds.length === 0) {
    try {
      checkout = (await hasUsableGit(repoPath)) ? 'ready' : 'not_git';
    } catch (err) {
      warn(err, 'checkout');
      readHolds.push({ code: 'checkout_unreadable' });
    }
  }

  const [tasks, [merge], questions, [outbox], [mirror], [sync]] = await Promise.all([
    db
      .select({ id: schema.tasks.id, type: schema.tasks.type })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.repositoryId, repo.id),
          inArray(schema.tasks.status, [...CHECKOUT_HOLDING_TASK_STATUSES]),
          isNull(schema.tasks.deadAt),
        ),
      )
      .orderBy(asc(schema.tasks.id)),
    db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.repositoryId, repo.id),
          eq(schema.tasks.type, 'plan_merge'),
          inArray(schema.tasks.status, [...PLAN_MERGE_LIVE_STATUSES]),
        ),
      )
      .limit(1),
    db
      .select({ unit: schema.projectStateConflicts.unit })
      .from(schema.projectStateConflicts)
      .where(
        and(
          eq(schema.projectStateConflicts.repositoryId, repo.id),
          isNull(schema.projectStateConflicts.resolvedAt),
        ),
      ),
    db
      .select({
        writeIntent: schema.projectStateOutbox.writeIntent,
        revision: schema.projectStateOutbox.revision,
        writtenRevision: schema.projectStateOutbox.writtenRevision,
        lastError: schema.projectStateOutbox.lastError,
      })
      .from(schema.projectStateOutbox)
      .where(eq(schema.projectStateOutbox.repositoryId, repo.id)),
    db
      .select({
        revision: schema.planMirrorState.revision,
        writtenRevision: schema.planMirrorState.writtenRevision,
        lastError: schema.planMirrorState.lastError,
      })
      .from(schema.planMirrorState)
      .where(eq(schema.planMirrorState.repositoryId, repo.id)),
    db
      .select({
        lastError: schema.projectStateSync.lastError,
        syncedHead: schema.projectStateSync.syncedHead,
      })
      .from(schema.projectStateSync)
      .where(eq(schema.projectStateSync.repositoryId, repo.id)),
  ]);

  let gitOperation = false;
  let branch: string | null = null;
  let origin = true;
  const pushReadHolds: HaiveDataReadHold[] = [];
  let files: HaiveDataFile[] | null = null;
  if (checkout === 'ready') {
    try {
      gitOperation = await gitOperationOpen(repoPath!);
    } catch (err) {
      warn(err, 'operation');
      readHolds.push({ code: 'git_operation_unreadable' });
    }
    try {
      branch = await currentBranch(repoPath!);
    } catch (err) {
      warn(err, 'branch');
      pushReadHolds.push({ code: 'branch_unreadable' });
    }
    try {
      origin = await hasOrigin(repoPath!);
    } catch (err) {
      warn(err, 'origin');
      pushReadHolds.push({ code: 'origin_unreadable' });
    }
    files = await readFiles(repoPath!);
  }

  const stateDirty = outbox !== undefined && outbox.writtenRevision < outbox.revision;
  const mirrorDirty = mirror !== undefined && mirror.writtenRevision < mirror.revision;
  const writeIntent = outbox?.writeIntent != null;
  const facts: HaiveDataFacts = {
    readHolds,
    checkout,
    rootClaimLive: isRootClaimLive(repo.rootClaimedAt),
    holdingTaskIds: tasks
      .filter((task) => task.type === 'onboarding' || task.type === 'onboarding_upgrade')
      .map((task) => task.id),
    writeIntent,
    gitOperation,
    planMergeTaskId: merge?.id ?? null,
    pendingUnits: questions.map((question) => question.unit),
    stateDirty,
    mirrorDirty,
    // A Save that does not push reads neither the branch nor the origin.
    push: false,
    branch: null,
    origin: true,
  };
  return {
    checkout: readHolds.some((hold) => hold.code === 'checkout_unreadable')
      ? 'unreadable'
      : checkout,
    branch,
    files,
    record: {
      dirty: stateDirty,
      writePending: writeIntent,
      lastError: scrub(outbox?.lastError),
      syncError: scrub(sync?.lastError),
      syncedHead: sync?.syncedHead ?? null,
    },
    snapshot: { dirty: mirrorDirty, lastError: scrub(mirror?.lastError) },
    holds: {
      save: holdsFor(facts),
      push: holdsFor({
        ...facts,
        readHolds: [...readHolds, ...pushReadHolds],
        push: true,
        branch,
        origin,
      }),
    },
  };
}
