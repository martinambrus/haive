import { GIT_OPERATION_STATE_ENTRIES } from '@haive/shared/git-args';
import { gitRun } from '../repo/git-exec.js';
import { CHECKOUT_HOLDING_TASK_STATUSES } from '@haive/shared';
import { and, eq, isNull, inArray, ne } from 'drizzle-orm';
import { isRootClaimLive, lockRepositoryTasksKey, schema, type Database } from '@haive/database';
import {
  parseProjectState,
  PROJECT_STATE_DIR,
  PROJECT_STATE_LIMITS,
  readRenderContextColumn,
  sameValue,
  emptyProjectState,
  mergeProjectState,
  renderProjectState,
} from '@haive/shared/project-state';
import {
  removeFileIfNoFollow,
  rewriteFileIfNoFollow,
  writeFileNoFollow,
  relUnder,
  lstatNoFollow,
  openDirNoFollow,
} from '@haive/shared/fs-safe';
import { lockPlanMirror } from '../plan/mirror.js';
import { readStateTree } from '../plan/projection-merge.js';
import { gitOperationInProgress } from '../repo/git-operation.js';
import { resolveGitEnv } from '../secrets/user-git-identity.js';
import { commitHaiveProjections, type HaiveProjectionCommit } from './commit.js';
import { readStateFiles } from './sync.js';
import { reviewWatermarkOrder } from './review-watermarks.js';
import { lockProjectState, writeProjectStateColumn, refuseReleasedCheckout } from './write.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
const FALLBACK_IDENTITY = {
  GIT_AUTHOR_NAME: 'Haive',
  GIT_AUTHOR_EMAIL: 'worker@haive.local',
  GIT_COMMITTER_NAME: 'Haive',
  GIT_COMMITTER_EMAIL: 'worker@haive.local',
};

/** Only push boundaries call this. The ordinary observer still writes without committing.
 * The journaled writer imports unseen source bytes and retains its column/task/reset fences. */
export async function prepareProjectStatePush(
  db: Database,
  args: {
    repositoryId: string | null;
    sourcePath: string;
    taskId?: string;
  },
): Promise<void> {
  if (!args.repositoryId) return;
  const [repo] = await db
    .select()
    .from(schema.repositories)
    .where(eq(schema.repositories.id, args.repositoryId))
    .limit(1);
  if (!repo || (repo.storagePath ?? repo.localPath) !== args.sourcePath)
    throw new Error('project state push checkout changed');
  const read = readRenderContextColumn(repo.renderContext);
  if (read.kind === 'absent') return;
  if (read.kind !== 'column') throw new Error('project state render context is refused');
  const result = await writeProjectStateColumn(db, {
    repositoryId: args.repositoryId,
    repoPath: args.sourcePath,
    column: read.column,
    expectedColumns: [repo.renderContext],
    expectedResetAt: repo.onboardingResetAt,
    holdingTaskId: args.taskId,
    refuseWhileHeld: !args.taskId,
    keepColumnOnFailure: true,
    refuseDuringGitOperation: true,
  }).catch((err: unknown) => {
    throw new Error(
      `Could not prepare ${PROJECT_STATE_DIR} for push; nothing was pushed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  });
  if (result.blocked) throw new Error(`project state push held: ${result.blocked.code}`);
}

export async function projectionPushIdentity(
  db: Database,
  userId: string,
  repositoryId: string | null,
) {
  const identity = await resolveGitEnv(db, { userId, ...(repositoryId ? { repositoryId } : {}) });
  return Object.keys(identity).length ? identity : FALLBACK_IDENTITY;
}

/** Worktree Git state lives in the repository's .git/worktrees directory. Inspect it from
 * the repository anchor; an external/poisoned gitfile is refused by relUnder/no-follow. */
async function targetOperationOpen(
  sourcePath: string,
  targetPath: string,
  gitCwd: string,
): Promise<boolean> {
  if (sourcePath === targetPath) return gitOperationInProgress(sourcePath);
  for (const mark of GIT_OPERATION_STATE_ENTRIES) {
    const located = await gitRun(gitCwd, [
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      mark,
    ]);
    if (located.code !== 0 || !located.stdout.trim())
      throw new Error('feature Git operation state is unreadable');
    if (
      await lstatNoFollow(sourcePath, relUnder(sourcePath, located.stdout.trim()), { strict: true })
    )
      return true;
  }
  return false;
}

/** Called inside the caller's checkout/merge section. Take the projection locks before reading
 * either tree, and hold them through the scoped commit. No pool queries occur in this section.
 * A feature worktree has already had agent projection edits put back to its fork point. Only a
 * target file still equal to that worktree's HEAD (or the three-way merged desired bytes, for
 * retries) may be replaced. Target-only state survives; divergent units refuse before copying.
 * Unknown names and uncommitted feature edits are never copied over. */
export async function commitProjectStatePush(
  tx: Tx,
  args: {
    repositoryId: string | null;
    sourcePath: string;
    targetPath: string;
    identity: Record<string, string>;
    taskId?: string;
  },
): Promise<HaiveProjectionCommit | null> {
  const { repositoryId, sourcePath, targetPath, identity } = args;
  if (repositoryId) {
    await lockRepositoryTasksKey(tx, repositoryId);
    await lockProjectState(tx, repositoryId);
    await lockPlanMirror(tx, repositoryId);
    const [repo] = await tx
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.id, repositoryId))
      .for('update');
    if (!repo || (repo.storagePath ?? repo.localPath) !== sourcePath)
      throw new Error('project state push checkout changed');
    if (isRootClaimLive(repo.rootClaimedAt))
      throw new Error('project state push held by root claim');
    if (args.taskId) await refuseReleasedCheckout(tx, args.taskId, repositoryId);
    const holders = await tx
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.repositoryId, repositoryId),
          inArray(schema.tasks.status, [...CHECKOUT_HOLDING_TASK_STATUSES]),
          isNull(schema.tasks.deadAt),
          inArray(schema.tasks.type, ['onboarding', 'onboarding_upgrade']),
          args.taskId ? ne(schema.tasks.id, args.taskId) : undefined,
        ),
      )
      .limit(1);
    if (holders.length) throw new Error('project state push held by another checkout task');
    const [outbox] = await tx
      .select()
      .from(schema.projectStateOutbox)
      .where(eq(schema.projectStateOutbox.repositoryId, repositoryId));
    if (
      outbox?.writeIntent ||
      (repo.renderContext != null && outbox && outbox.writtenRevision < outbox.revision)
    )
      throw new Error('project state push held by pending write');
    const questions = await tx
      .select()
      .from(schema.projectStateConflicts)
      .where(
        and(
          eq(schema.projectStateConflicts.repositoryId, repositoryId),
          isNull(schema.projectStateConflicts.resolvedAt),
        ),
      );
    if (questions.some((row) => !row.unit.startsWith('plan/')))
      throw new Error('project state push held by unanswered question');
  }
  // Open the worktree from the trusted root before any target Git/read operation. Git uses
  // this held directory too, so replacing its name cannot redirect a later subprocess cwd.
  const held =
    sourcePath === targetPath
      ? null
      : await openDirNoFollow(sourcePath, relUnder(sourcePath, targetPath));
  let expectedTargetHead: string | undefined;
  const gitTarget = held ? `/proc/${process.pid}/fd/${held.fd}` : targetPath;
  try {
    if (
      (await gitOperationInProgress(sourcePath)) ||
      (await targetOperationOpen(sourcePath, targetPath, gitTarget))
    )
      throw new Error('project state push held by open git operation');
    const source = await readStateFiles(sourcePath, { boundedDirectoryReads: true });
    if (!source?.size) return null; // Older/no-record repositories retain their existing push behavior.
    const parsed = parseProjectState(source);
    if (!parsed.ok) throw new Error('project state push refused an invalid record');
    if (sourcePath !== targetPath) {
      const sourceTip = await sourceHead(sourcePath);
      const targetTip = await sourceHead(gitTarget);
      const previous = await readStateTree(gitTarget, targetTip);
      const target =
        (await readStateFiles(targetPath, {
          boundedDirectoryReads: true,
          filesystemAnchor: sourcePath,
        })) ?? new Map<string, string>();
      const actualRecord = target.size ? parseProjectState(target) : null;
      if (actualRecord && !actualRecord.ok)
        throw new Error('feature project state record is refused');
      const old = previous.size ? parseProjectState(previous) : null;
      if (old && !old.ok) throw new Error('feature project state record is refused');
      // The root is the pending local side, not an unconditional replacement for another
      // branch's landed record. Merge at the actual Git ancestor; an absent ancestor record
      // is an empty common record, never first-import permission to overwrite either side.
      const common = await gitRun(gitTarget, ['merge-base', targetTip, sourceTip]);
      if (common.code !== 0 || !common.stdout.trim())
        throw new Error(
          'project state push cannot read a common history; repair the checkout before retrying',
        );
      const baseFiles = await readStateTree(gitTarget, common.stdout.trim());
      const base = baseFiles.size ? parseProjectState(baseFiles) : null;
      if (base && !base.ok) throw new Error('project state push base record is refused');
      const incoming = old?.ok ? old.record : emptyProjectState();
      const watermarkOrder = await reviewWatermarkOrder(
        gitTarget,
        parsed.record.settings['review-watermarks'],
        incoming.settings['review-watermarks'],
      );
      const merged = mergeProjectState({
        base: base?.ok ? base.record : emptyProjectState(),
        local: parsed.record,
        incoming,
        watermarkOrder,
      });
      if (merged.conflicts.length)
        throw new Error(
          `project state push conflict; reconcile the branch record before retrying: ${merged.conflicts.map((c) => c.unit).join(', ')}`,
        );
      const desiredFiles = renderProjectState(merged.merged);
      const oldIgnored = new Set(old?.ok ? old.ignored : []);
      const names = new Set(desiredFiles.keys());
      for (const rel of previous.keys()) if (!oldIgnored.has(rel)) names.add(rel);
      const actualIgnored = new Set(actualRecord?.ok ? actualRecord.ignored : []);
      for (const rel of target.keys()) if (!actualIgnored.has(rel)) names.add(rel);
      if (
        (await sourceHead(sourcePath)) !== sourceTip ||
        (await sourceHead(gitTarget)) !== targetTip
      )
        throw new Error('project state push HEAD changed before its copy');
      // Preflight all known units before the first target mutation. Partial copies after a crash
      // are retried at the desired bytes; the source journal/base remains attached to the root.
      for (const rel of names) {
        const actual = target.get(rel);
        if (actual !== previous.get(rel) && actual !== desiredFiles.get(rel))
          throw new Error(`feature project state changed: ${rel}`);
      }
      for (const rel of names) {
        const before = target.get(rel);
        const desired = desiredFiles.get(rel);
        if (before === desired) continue;
        const path = relUnder(sourcePath, `${targetPath}/${PROJECT_STATE_DIR}/${rel}`);
        const cap = { maxBytes: PROJECT_STATE_LIMITS.maxFileBytes };
        if (desired === undefined) {
          if (
            (await removeFileIfNoFollow(
              sourcePath,
              path,
              (bytes) => bytes.equals(Buffer.from(before!)),
              cap,
            )) !== 'removed'
          )
            throw new Error(`feature project state changed: ${rel}`);
        } else if (before === undefined) {
          await writeFileNoFollow(sourcePath, path, desired, {
            mode: 'create-exclusive',
            createParents: true,
          });
        } else if (
          (await rewriteFileIfNoFollow(
            sourcePath,
            path,
            (bytes) => (bytes.equals(Buffer.from(before)) ? Buffer.from(desired) : null),
            cap,
          )) !== 'rewritten'
        ) {
          throw new Error(`feature project state changed: ${rel}`);
        }
      }
      if (
        !sameValue(
          [...source].sort(),
          [...((await readStateFiles(sourcePath, { boundedDirectoryReads: true })) ?? [])].sort(),
        )
      )
        throw new Error('source project state changed before its push');
      if (
        (await sourceHead(sourcePath)) !== sourceTip ||
        (await sourceHead(gitTarget)) !== targetTip
      )
        throw new Error('project state push HEAD changed before its commit');
      expectedTargetHead = targetTip;
    }
    return await commitHaiveProjections({
      repositoryId: repositoryId ?? '',
      repoPath: targetPath,
      filesystemAnchor: sourcePath,
      gitCwd: gitTarget,
      expectedHead: expectedTargetHead,
      identity,
      message: 'chore(haive): sync project state',
      includePlan: false,
    });
  } finally {
    await held?.close();
  }
}

async function sourceHead(sourcePath: string): Promise<string> {
  const head = await gitRun(sourcePath, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (head.code !== 0 || !head.stdout.trim())
    throw new Error('source project state HEAD is unreadable');
  return head.stdout.trim();
}
