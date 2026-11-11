import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  acquireRootClaim,
  lockRepositoryTasksKey,
  schema,
  type Database,
  type RootClaimHandle,
} from '@haive/database';
import type { UndoLeftMergePayload } from '@haive/shared';
import {
  leftCommittedMerges,
  MERGE_LANDED_EVENT,
  MERGE_LEFT_COMMITTED_EVENT,
  MERGE_LEFT_COMMITTED_SETTLED_EVENT,
  type LeftCommittedMerge,
  type MergeLeftCommittedOutcome,
} from '@haive/shared/merge-left-open';
import { lstatNoFollow, relUnder } from '@haive/shared/fs-safe';
import { detectOrigin, gitRun, originGitRun, buildCredentialHelper } from '../repo/git-push.js';
import { worktreeDirPaths, worktreeDirName } from '../repo/worktree-paths.js';
import { checkoutHoldingTasks } from '../repo/refresh.js';
import { findWorktreePathClaimant } from '../repo/worktree-claims.js';
import {
  resyncHaiveProjections,
  setAsideHaiveProjections,
  putBackProjections,
  restoreProjectionsInTx,
  type KeptFiles,
  type RestoreSection,
} from '../project-state/set-aside.js';
import { withProjectionMove } from '../project-state/projection-move.js';
import { handBackAfterMove, isHostCheckout, revParse } from './git-merge.js';
import {
  inMergeDirLock,
  liveClaimHolder,
  otherLiveClaim,
  type DbHandle,
} from './merge-dir-claim.js';

const records = (db: DbHandle, taskId: string) =>
  db
    .select({ eventType: schema.taskEvents.eventType, payload: schema.taskEvents.payload })
    .from(schema.taskEvents)
    .where(
      and(
        eq(schema.taskEvents.taskId, taskId),
        inArray(schema.taskEvents.eventType, [
          MERGE_LANDED_EVENT,
          MERGE_LEFT_COMMITTED_EVENT,
          MERGE_LEFT_COMMITTED_SETTLED_EVENT,
        ]),
      ),
    )
    .orderBy(asc(schema.taskEvents.createdAt));

const sha = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);

/** Never infer ownership from containment alone. A re-entry's later tip fails these parent
 * checks; a base-sync round is excluded even when it happens to look like a feature merge.
 * A replacement squash needs the original two-parent merge and its identical tree as proof. */
async function ownMerge(dir: string, m: LeftCommittedMerge): Promise<boolean> {
  if (m.mergeStage !== 'feature' || !sha(m.featureSha) || typeof m.featureBranch !== 'string')
    return false;
  if (
    (await gitRun(dir, ['check-ref-format', `refs/heads/${m.featureBranch}`])).code !== 0 ||
    m.featureBranch === m.landedOn
  )
    return false;
  const parents = async (commit: string) => {
    const result = await gitRun(dir, ['rev-list', '--parents', '-n', '1', commit]);
    if (result.code !== 0) throw new Error('Cannot read the merge parents');
    return result.stdout.trim().split(/\s+/);
  };
  const p = await parents(m.baseShaAfter);
  if (p.length === 3) return p[1] === m.baseShaBefore && p[2] === m.featureSha;
  if (p.length !== 2 || p[1] !== m.baseShaBefore || !sha(m.squashMergeSha)) return false;
  const original = await parents(m.squashMergeSha);
  return (
    original.length === 3 &&
    original[1] === m.baseShaBefore &&
    original[2] === m.featureSha &&
    (await revParse(dir, `${m.baseShaAfter}^{tree}`)) ===
      (await revParse(dir, `${m.squashMergeSha}^{tree}`))
  );
}

/** Fetch only this attempt's private ref, without holding a main-db transaction or changing a
 * shared tracking ref. Unknown remote state refuses Undo; a stale tracking ref proves nothing. */
async function remoteRefusal(
  db: Database,
  userId: string,
  m: LeftCommittedMerge,
  credentialId?: string,
): Promise<{ reason: string; permanent?: boolean } | null> {
  const ref = `refs/haive/undo-check/${randomUUID()}`;
  try {
    if ((await gitRun(m.repoPath, ['check-ref-format', `refs/heads/${m.landedOn}`])).code !== 0)
      return { reason: 'The recorded base branch is invalid; the merge was left committed.' };
    if (!(await detectOrigin(m.repoPath))) return null;
    const fetchUrl = await gitRun(m.repoPath, ['remote', 'get-url', '--all', 'origin']);
    const pushUrl = await gitRun(m.repoPath, ['remote', 'get-url', '--push', '--all', 'origin']);
    if (fetchUrl.code !== 0 || pushUrl.code !== 0 || fetchUrl.stdout !== pushUrl.stdout)
      return {
        reason:
          'The remote push destination cannot be checked safely; the merge was left committed.',
      };
    const helper = credentialId
      ? await buildCredentialHelper(db, credentialId, userId, fetchUrl.stdout.trim())
      : null;
    const listed = await originGitRun(
      m.repoPath,
      [
        ...(helper?.argv ?? []),
        'ls-remote',
        '--exit-code',
        '--heads',
        'origin',
        `refs/heads/${m.landedOn}`,
      ],
      { db, userId },
      helper?.env,
    );
    if (listed.code === 2) return null; // The remote has no such branch: it cannot contain the merge.
    if (listed.code !== 0)
      return { reason: 'The remote branch could not be checked; the merge was left committed.' };
    const fetched = await originGitRun(
      m.repoPath,
      [
        ...(helper?.argv ?? []),
        'fetch',
        '--no-write-fetch-head',
        '--refmap=',
        '--no-tags',
        '--end-of-options',
        'origin',
        `refs/heads/${m.landedOn}:${ref}`,
      ],
      { db, userId },
      helper?.env,
    );
    if (fetched.code !== 0)
      return { reason: 'The remote branch could not be checked; the merge was left committed.' };
    const contains = await gitRun(m.repoPath, ['merge-base', '--is-ancestor', m.baseShaAfter, ref]);
    if (contains.code === 0)
      return {
        reason: 'The remote branch contains this merge; a pushed merge cannot be undone here.',
        permanent: true,
      };
    return contains.code === 1
      ? null
      : { reason: 'The remote history could not be checked; the merge was left committed.' };
  } catch {
    return { reason: 'The remote branch could not be checked; the merge was left committed.' };
  } finally {
    await gitRun(m.repoPath, ['update-ref', '-d', ref]);
  }
}

/** One confirmed click, one outcome under the same directory lock as every landing writer.
 * Retryable refusals record the click without closing the report. Re-delivery repairs post-move work without moving git again. */
export const undoLeftMerge: typeof undoLeftMergeInMove = (...args) =>
  withProjectionMove(() => undoLeftMergeInMove(...args));

async function undoLeftMergeInMove(db: Database, payload: UndoLeftMergePayload): Promise<void> {
  const { taskId, userId, dir, baseShaAfter } = payload;
  const task = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, taskId), eq(schema.tasks.userId, userId)),
  });
  if (task?.status !== 'cancelled') return;
  const initial = leftCommittedMerges(await records(db, taskId)).find(
    (m) => m.dir === dir && m.baseShaAfter === baseShaAfter,
  );
  if (!initial) return;
  const repo = task.repositoryId
    ? await db.query.repositories.findFirst({
        where: eq(schema.repositories.id, task.repositoryId),
      })
    : null;
  if (!repo || !task.repositoryId) {
    await inMergeDirLock(db, dir, async (tx) => {
      const m = leftCommittedMerges(await records(tx, taskId)).find(
        (m) => m.dir === dir && m.baseShaAfter === baseShaAfter,
      );
      if (!m || m.settled) return;
      await tx.insert(schema.taskEvents).values({
        taskId,
        taskStepId: null,
        eventType: MERGE_LEFT_COMMITTED_SETTLED_EVENT,
        payload: {
          dir,
          baseShaAfter,
          outcome: 'refused',
          reason: 'The repository is no longer available; the merge was left committed.',
        },
      });
    });
    return;
  }
  const contained = initial.repoPath === (repo.storagePath ?? repo.localPath);
  let remote: Awaited<ReturnType<typeof remoteRefusal>> = null;
  if (
    contained &&
    !isHostCheckout(initial.repoPath) &&
    !initial.hostCheckout &&
    !initial.pushed &&
    !initial.settled
  ) {
    const step = await db.query.taskSteps.findFirst({
      where: and(
        eq(schema.taskSteps.taskId, taskId),
        eq(schema.taskSteps.stepId, '12-worktree-cleanup'),
      ),
    });
    const credentialId = (step?.formValues as { credentialId?: string } | null)?.credentialId;
    remote = await remoteRefusal(db, userId, initial, credentialId);
  }
  let root: RootClaimHandle | null = null;
  let needsSync = false;
  let movedCheckout: string | null = null;
  let prepared = false;
  let preparationRefusal: string | null = null;
  let kept: KeptFiles | null = null;
  const fence = async (conn: Parameters<typeof checkoutHoldingTasks>[0]) =>
    (await checkoutHoldingTasks(conn, task.repositoryId!, {
      rootOnly: true,
      excludeTaskId: taskId,
    })) + ((await otherLiveClaim(conn as DbHandle, dir, taskId)) ? 1 : 0);
  const section: RestoreSection = (fn) =>
    inMergeDirLock(db, dir, async (tx) => {
      await lockRepositoryTasksKey(tx, task.repositoryId!);
      if (await fence(tx)) throw new Error('Checkout held while putting project files back');
      return fn(tx);
    });
  try {
    const attempt = () =>
      inMergeDirLock(db, dir, async (tx) => {
        const m = leftCommittedMerges(await records(tx, taskId)).find(
          (m) => m.dir === dir && m.baseShaAfter === baseShaAfter,
        );
        if (!m) return;
        needsSync = m.settled?.outcome === 'undone' || m.settled?.resyncRequired === true;
        if (m.settled && !needsSync) return;
        const settle = async (
          outcome: MergeLeftCommittedOutcome,
          reason: string,
          permanent = false,
        ) => {
          if (m.settled) throw new Error('Undo recovery cannot settle an already settled report');
          await tx.insert(schema.taskEvents).values({
            taskId,
            taskStepId: null,
            eventType: MERGE_LEFT_COMMITTED_SETTLED_EVENT,
            payload: {
              dir,
              baseShaAfter,
              baseShaBefore: m.baseShaBefore,
              landedOn: m.landedOn,
              outcome,
              reason,
              ...(permanent ? { permanent: true } : {}),
              ...(needsSync ? { resyncRequired: true } : {}),
            },
          });
        };
        if (!contained || isHostCheckout(m.repoPath) || isHostCheckout(dir)) {
          await settle(
            'refused',
            'This is not a writable Haive repository checkout; the merge was left committed.',
            true,
          );
          return;
        }
        if (m.pushed || m.hostCheckout) {
          await settle(
            'refused',
            'A pushed merge or a host checkout gets a report only; the merge was left committed.',
            true,
          );
          return;
        }
        const currentTask = await tx.query.tasks.findFirst({
          where: and(eq(schema.tasks.id, taskId), eq(schema.tasks.userId, userId)),
        });
        if (currentTask?.status !== 'cancelled') return;
        const [claim] = await tx
          .select()
          .from(schema.mergeDirClaims)
          .where(eq(schema.mergeDirClaims.mergeDir, dir))
          .for('update');
        const holder = claim ? await liveClaimHolder(tx, claim) : null;
        if (holder) {
          if (m.settled) throw new Error('Checkout held while Undo recovery is pending');
          await settle(
            'refused',
            `Task "${holder.title}" (${holder.id}) is working in this directory.`,
          );
          return;
        }
        root ??= await acquireRootClaim(db, task.repositoryId!, 'edit', userId);
        if (!root) {
          if (m.settled) throw new Error('Root claimed while Undo recovery is pending');
          await settle('refused', 'The repository root is claimed by another operation.');
          return;
        }
        await lockRepositoryTasksKey(tx, task.repositoryId!);
        if (
          (await findWorktreePathClaimant(tx, { worktreePath: dir, taskId })) ||
          (await checkoutHoldingTasks(tx, task.repositoryId!, {
            rootOnly: true,
            excludeTaskId: taskId,
          }))
        ) {
          if (m.settled) throw new Error('Checkout held while Undo recovery is pending');
          await settle('refused', 'Another task is working in this checkout.');
          return;
        }
        // The repository row is the anchor; never promote the event's merge directory to one.
        let directoryReadable = false;
        try {
          const rootStat = await lstatNoFollow(m.repoPath, '', { strict: true });
          const mergeStat = await lstatNoFollow(m.repoPath, relUnder(m.repoPath, dir), {
            strict: true,
          });
          directoryReadable =
            rootStat?.kind === 'directory' && (!mergeStat || mergeStat.kind === 'directory');
        } catch {
          // A link, escape or IO failure is unknown. None permits a ref write.
        }
        if (!directoryReadable) {
          await settle('refused', 'The recorded directory could not be read safely.');
          return;
        }
        {
          const cwd = m.repoPath;
          const restoreFeature = async () => {
            if (typeof m.featureBranch !== 'string' || !sha(m.featureSha)) return;
            const ref = `refs/heads/${m.featureBranch}`;
            if ((await revParse(cwd, ref)) === null) {
              const created = await gitRun(cwd, ['update-ref', ref, m.featureSha, '0'.repeat(40)]);
              if (created.code !== 0 && (await revParse(cwd, ref)) === null)
                throw new Error('Feature branch could not be restored');
            }
          };
          if (m.settled) {
            await restoreFeature();
            const symbolic = await gitRun(m.dir, ['symbolic-ref', '-q', 'HEAD']);
            if (
              symbolic.code === 0 &&
              symbolic.stdout.trim() === `refs/heads/${m.landedOn}` &&
              (await revParse(m.dir, 'HEAD')) === m.baseShaBefore
            )
              movedCheckout = m.dir;
            return;
          }
          if (
            (await gitRun(cwd, ['check-ref-format', `refs/heads/${m.landedOn}`])).code !== 0 ||
            !(await ownMerge(cwd, m))
          ) {
            await settle(
              'refused',
              "The recorded landing cannot be proved to be this task's own feature merge.",
              true,
            );
            return;
          }
          const branch = `refs/heads/${m.landedOn}`;
          // Preserve the moved-away commit as a git root too: a JSON sha alone cannot stop gc.
          // This create-only ref also identifies an admitted attempt if SQL fails after git moved.
          const undoRef = `refs/haive/undo-left-merge/${taskId}/${baseShaAfter}`;
          // Porcelain -z keeps paths literal, including spaces, quotes and newlines. Git's
          // update-ref does not protect a branch checked out in another worktree.
          const listed = await gitRun(cwd, ['worktree', 'list', '--porcelain', '-z']);
          if (listed.code !== 0) throw new Error('Cannot read the repository worktrees');
          const holders: string[] = [];
          let worktree = '';
          for (const field of listed.stdout.split('\0')) {
            if (field.startsWith('worktree ')) worktree = field.slice(9);
            if (field === `branch ${branch}`) holders.push(worktree);
          }
          const transient = worktreeDirPaths(
            cwd,
            '',
            `${worktreeDirName(m.landedOn)}--base`,
          ).worktreePath;
          if (
            holders.length > 1 ||
            holders.some((p) => p !== cwd && (p !== m.dir || p !== transient))
          ) {
            await settle(
              'refused',
              'The base branch is checked out in another worktree. Release that checkout before trying Undo again.',
            );
            return;
          }
          movedCheckout = holders[0] ?? null;
          const prior = await revParse(cwd, undoRef);
          const tip = await revParse(cwd, branch);
          if (tip !== m.baseShaAfter) {
            if (tip === m.baseShaBefore && prior === m.baseShaAfter) {
              needsSync = true;
              await restoreFeature();
              await settle(
                'moved',
                'The base is already at the pre-merge commit after an earlier Undo attempt; recovery will re-sync the project files.',
              );
              return;
            }
            await settle('moved', 'The base branch moved since this merge; nothing was changed.');
            return;
          }
          if (remote) {
            await settle('refused', remote.reason, remote.permanent);
            return;
          }
          if (movedCheckout && (await revParse(movedCheckout, 'HEAD')) !== m.baseShaAfter) {
            await settle('moved', 'The checkout moved since this merge; nothing was changed.');
            return;
          }
          if (prior !== m.baseShaAfter) {
            const keep = await gitRun(cwd, ['update-ref', undoRef, m.baseShaAfter, '0'.repeat(40)]);
            if (keep.code !== 0)
              throw new Error('The merge commit could not be preserved for recovery');
          }
          if (movedCheckout === m.repoPath) {
            if (!prepared) return true;
            if (preparationRefusal) {
              await settle('refused', preparationRefusal);
              return;
            }
            const check = await restoreProjectionsInTx(tx, task.repositoryId!, m.repoPath);
            if (check.outcome !== 'clean') {
              await settle(
                'refused',
                check.outcome === 'refused'
                  ? check.reason
                  : 'The project files changed again before Undo; retry.',
              );
              return;
            }
          }
          // Set-aside rewrites bytes without refreshing git's cached stat data. --keep
          // otherwise intermittently refuses an unchanged projection as not up to date.
          if (movedCheckout) {
            const refreshed = await gitRun(movedCheckout, ['update-index', '-q', '--refresh']);
            // Exit 1 also reports real local edits, which reset --keep must judge and preserve.
            if (refreshed.code !== 0 && refreshed.code !== 1)
              throw new Error('Git could not refresh the checkout index before Undo.');
          }
          const move = await gitRun(
            movedCheckout ?? cwd,
            movedCheckout
              ? ['reset', '--keep', m.baseShaBefore]
              : ['update-ref', branch, m.baseShaBefore, m.baseShaAfter],
          );
          if (move.code !== 0) {
            await settle(
              'refused',
              'Git refused the undo; local changes or a changed branch were kept.',
            );
            return;
          }
          needsSync = true;
          await restoreFeature();
          await settle(
            'undone',
            `Moved ${m.landedOn} back to ${m.baseShaBefore}. The merge commit remains available as ${m.baseShaAfter}.`,
          );
        }
      });
    if (await attempt()) {
      // Capture commits before files move; no merge-dir or task-creation transaction is held
      // across the helper's own transactions. Re-enter all fences before the actual reset.
      const aside = await setAsideHaiveProjections(db, task.repositoryId, initial.repoPath, fence, {
        restore: section,
        putBack: section,
      });
      prepared = true;
      if (aside.outcome === 'set-aside') kept = aside.kept;
      if (aside.outcome === 'refused') preparationRefusal = aside.reason;
      if (aside.outcome === 'held')
        preparationRefusal = 'Another task is working in this checkout.';
      await attempt();
    }
  } finally {
    try {
      if (needsSync) {
        if (movedCheckout) await handBackAfterMove(movedCheckout, initial.baseShaAfter);
        if (!(await resyncHaiveProjections(db, task.repositoryId, initial.repoPath, taskId)))
          throw new Error("Haive's project files were not re-synced yet; the job will retry");
      } else if (kept) {
        await putBackProjections(db, task.repositoryId, initial.repoPath, kept, section);
      }
    } finally {
      if (root) await (root as RootClaimHandle).release();
    }
  }
}
