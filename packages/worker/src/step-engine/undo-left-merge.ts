import { safeErrorMessage, scrubErrorPaths } from '@haive/shared/logger';
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
  MERGE_LEFT_COMMITTED_RESYNCED_EVENT,
  type LeftCommittedMerge,
  type MergeLeftCommittedOutcome,
} from '@haive/shared/merge-left-open';
import { lstatNoFollow, relUnder } from '@haive/shared/fs-safe';
import {
  detectOrigin,
  gitRun,
  originGitRun,
  buildCredentialHelper,
  scrubSecret,
} from '../repo/git-push.js';
import { worktreeDirPaths, worktreeDirName } from '../repo/worktree-paths.js';
import { checkoutHoldingTasks } from '../repo/refresh.js';
import { findWorktreePathClaimant } from '../repo/worktree-claims.js';
import { worktreesHoldingBranch } from '../repo/git-workspace.js';
import { gitOperationInProgress, GitOperationUnreadableError } from '../repo/git-operation.js';
import {
  checkGitRefTransactions,
  GitRefTransactionCommittedError,
  GitRefTransactionError,
  GitRefTransactionStartError,
  withGitRefTransaction,
} from '../repo/git-ref-transaction.js';
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

/** Expected local git failures end this attempt immediately; a person can repair and retry. */
class UndoGitError extends Error {}
const gitFailureReason = (summary: string, error: unknown, secret?: string | null) => {
  // Sanitize the original structure before converting it to persisted display copy.
  // Known secrets first, then paths (error-diagnostics.md): a path scrub can split a secret.
  const detail = scrubErrorPaths(scrubSecret(safeErrorMessage(error), secret ?? null))
    .trim()
    .slice(0, 500);
  return detail ? `${summary.replace(/\.$/, '')}: ${detail}` : summary;
};
const undoRevParse = (dir: string, spec: string) =>
  revParse(dir, spec).catch((error: unknown) => {
    throw new UndoGitError(
      gitFailureReason(
        'Git could not read the recorded merge or checkout. Repair the repository and retry Undo.',
        error,
      ),
    );
  });

const records = (db: DbHandle, taskId: string) =>
  db
    .select({ eventType: schema.taskEvents.eventType, payload: schema.taskEvents.payload })
    .from(schema.taskEvents)
    .where(
      and(
        eq(schema.taskEvents.taskId, taskId),
        inArray(schema.taskEvents.eventType, [
          'task.cancel_finished',
          MERGE_LANDED_EVENT,
          MERGE_LEFT_COMMITTED_EVENT,
          MERGE_LEFT_COMMITTED_SETTLED_EVENT,
          MERGE_LEFT_COMMITTED_RESYNCED_EVENT,
        ]),
      ),
    )
    .orderBy(asc(schema.taskEvents.createdAt));

const sha = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);

/** EOF can abort the ref transaction after read-tree has already moved the checkout.
 * Prove that exact index and the touched files before finishing only the ref move.
 * Never roll files back: unrelated local edits must keep their bytes. */
async function interruptedCheckoutMove(checkout: string, m: LeftCommittedMerge): Promise<boolean> {
  const index = await gitRun(checkout, ['write-tree']);
  if (index.code !== 0)
    throw new UndoGitError(
      gitFailureReason('Cannot read the checkout tree for Undo recovery', index.stderr),
    );
  if (index.stdout.trim() !== (await undoRevParse(checkout, `${m.baseShaBefore}^{tree}`)))
    return false;
  const changed = await gitRun(checkout, [
    'diff',
    '--name-only',
    '-z',
    '--no-renames',
    m.baseShaAfter,
    m.baseShaBefore,
    '--',
  ]);
  if (changed.code !== 0)
    throw new UndoGitError(gitFailureReason('Cannot read the Undo recovery paths', changed.stderr));
  // gitRun decodes UTF-8; never check a replacement character in place of a filename byte.
  if (changed.stdout.includes('\uFFFD')) return false;
  const paths = changed.stdout
    .split('\0')
    .filter(Boolean)
    .map((p) => `:(literal)${p}`);
  if (!paths.length) return true;
  // Neither ls-files nor diff accepts --pathspec-from-file. Bound their literal argv
  // batches instead; byte counts include NULs and leave room for the environment.
  const batches: string[][] = [];
  let batch: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    const size = Buffer.byteLength(path) + 1;
    if (size > 32_768) return false;
    if (bytes + size > 32_768) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(path);
    bytes += size;
  }
  batches.push(batch);
  for (const paths of batches) {
    const checked = await gitRun(checkout, ['ls-files', '-v', '-z', '--', ...paths]);
    if (checked.code !== 0)
      throw new UndoGitError(
        gitFailureReason('Cannot read the Undo recovery index flags', checked.stderr),
      );
    if (checked.stdout.split('\0').some((entry) => /^([a-z]|S) /.test(entry))) return false;
    const local = await gitRun(checkout, [
      '-c',
      'core.trustctime=true',
      '-c',
      'core.checkStat=default',
      '-c',
      'core.fileMode=true',
      'diff',
      '--quiet',
      '--ignore-submodules=none',
      '--',
      ...paths,
    ]);
    if (local.code === 1) return false;
    if (local.code !== 0)
      throw new UndoGitError(
        gitFailureReason('Cannot read local changes for Undo recovery', local.stderr),
      );
    // A removed path recreated as untracked (including ignored) is no longer the moved checkout.
    const untracked = await gitRun(checkout, ['ls-files', '--others', '-z', '--', ...paths]);
    if (untracked.code !== 0)
      throw new UndoGitError(
        gitFailureReason('Cannot read untracked paths for Undo recovery', untracked.stderr),
      );
    if (untracked.stdout) return false;
  }
  return true;
}

async function validBranch(dir: string, branch: string): Promise<boolean> {
  const result = await gitRun(dir, ['check-ref-format', `refs/heads/${branch}`]);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new UndoGitError(
    gitFailureReason(
      'Git could not validate the recorded branch. Repair the repository and retry Undo.',
      result.stderr,
    ),
  );
}

/** Never infer ownership from containment alone. A re-entry's later tip fails these parent
 * checks; a base-sync round is excluded even when it happens to look like a feature merge.
 * A replacement squash needs the original two-parent merge and its identical tree as proof. */
async function ownMerge(dir: string, m: LeftCommittedMerge): Promise<boolean> {
  if (m.mergeStage !== 'feature' || !sha(m.featureSha) || typeof m.featureBranch !== 'string')
    return false;
  if (!(await validBranch(dir, m.featureBranch)) || m.featureBranch === m.landedOn) return false;
  const parents = async (commit: string) => {
    const result = await gitRun(dir, ['rev-list', '--parents', '-n', '1', commit]);
    if (result.code !== 0)
      throw new UndoGitError(gitFailureReason('Cannot read the merge parents', result.stderr));
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
    (await undoRevParse(dir, `${m.baseShaAfter}^{tree}`)) ===
      (await undoRevParse(dir, `${m.squashMergeSha}^{tree}`))
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
  let helper: Awaited<ReturnType<typeof buildCredentialHelper>> | null = null;
  try {
    if ((await gitRun(m.repoPath, ['check-ref-format', `refs/heads/${m.landedOn}`])).code !== 0)
      return { reason: 'The recorded base branch is invalid; the merge was left committed.' };
    if (!(await detectOrigin(m.repoPath))) return null;
    const fetchUrl = await gitRun(m.repoPath, ['remote', 'get-url', '--all', 'origin']);
    const pushUrl = await gitRun(m.repoPath, ['remote', 'get-url', '--push', '--all', 'origin']);
    // Fetch reads only the first URL, whereas push writes to every effective push URL.
    // A person can reduce origin to one matching destination and retry this report.
    if (
      fetchUrl.code !== 0 ||
      pushUrl.code !== 0 ||
      !pushUrl.stdout.trim() ||
      pushUrl.stdout.trim().split('\n').length !== 1 ||
      fetchUrl.stdout !== pushUrl.stdout
    )
      return {
        reason: gitFailureReason(
          'The remote push destination cannot be checked safely. Configure one origin push destination matching its fetch URL, then retry Undo; the merge was left committed.',
          fetchUrl.code !== 0 ? fetchUrl.stderr : pushUrl.code !== 0 ? pushUrl.stderr : '',
        ),
      };
    helper = credentialId
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
      return {
        reason: gitFailureReason(
          'The remote branch could not be checked; the merge was left committed.',
          listed.stderr,
          helper?.secret,
        ),
      };
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
      return {
        reason: gitFailureReason(
          'The remote branch could not be checked; the merge was left committed.',
          fetched.stderr,
          helper?.secret,
        ),
      };
    const contains = await gitRun(m.repoPath, ['merge-base', '--is-ancestor', m.baseShaAfter, ref]);
    if (contains.code === 0)
      return {
        reason: 'The remote branch contains this merge; a pushed merge cannot be undone here.',
        permanent: true,
      };
    return contains.code === 1
      ? null
      : {
          reason: gitFailureReason(
            'The remote history could not be checked; the merge was left committed.',
            contains.stderr,
            helper?.secret,
          ),
        };
  } catch (error) {
    return {
      reason: gitFailureReason(
        'The remote branch could not be checked; the merge was left committed.',
        error,
        helper?.secret,
      ),
    };
  } finally {
    await gitRun(m.repoPath, ['update-ref', '-d', ref]);
  }
}

/** One confirmed click, one outcome under the same directory lock as every landing writer.
 * Retryable refusals record the click without closing the report. Re-delivery repairs post-move work without moving git again. */
export const undoLeftMerge: typeof undoLeftMergeInMove = (db, payload) =>
  withProjectionMove(async () => {
    try {
      await undoLeftMergeInMove(db, payload);
    } catch (err) {
      if (!(err instanceof UndoGitError) || !(await recordUndoFailure(db, payload, err))) throw err;
    }
  });

/** Also used after the queue's bounded retries, so a thrown job cannot leave Undo waiting forever.
 * A journal failure is thrown; it must never turn an unrecorded attempt into a completed job. */
export async function recordUndoFailure(
  db: Database,
  payload: UndoLeftMergePayload,
  err: unknown,
): Promise<boolean> {
  return inMergeDirLock(db, payload.dir, async (tx) => {
    const task = await tx.query.tasks.findFirst({
      where: and(eq(schema.tasks.id, payload.taskId), eq(schema.tasks.userId, payload.userId)),
    });
    if (task?.status !== 'cancelled') return false;
    const m = leftCommittedMerges(await records(tx, payload.taskId)).find(
      (m) => m.dir === payload.dir && m.baseShaAfter === payload.baseShaAfter,
    );
    if (!m || m.settled) return false;
    await tx.insert(schema.taskEvents).values({
      taskId: payload.taskId,
      taskStepId: null,
      eventType: MERGE_LEFT_COMMITTED_SETTLED_EVENT,
      payload: {
        dir: payload.dir,
        baseShaAfter: payload.baseShaAfter,
        outcome: 'refused',
        // The one-shot helper's plaintext secret is scoped to remoteRefusal,
        // which scrubs all remote failures before returning. This queue fallback
        // has no helper or secret; still remove paths and URL credentials here.
        // An UndoGitError already carries its sanitized, bounded sentence; prefixing it again
        // doubled the label the page puts in front ("Undo refused: Undo failed: ...").
        reason: err instanceof UndoGitError ? err.message : gitFailureReason('Undo failed', err),
      },
    });
    return true;
  });
}

async function undoLeftMergeInMove(db: Database, payload: UndoLeftMergePayload): Promise<void> {
  const { taskId, userId, dir, baseShaAfter } = payload;
  const task = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, taskId), eq(schema.tasks.userId, userId)),
  });
  if (task?.status !== 'cancelled') return;
  const initialEvents = await records(db, taskId);
  const initial = leftCommittedMerges(initialEvents).find(
    (m) => m.dir === dir && m.baseShaAfter === baseShaAfter,
  );
  if (!initial || (initial.settled && !initial.resyncOwed)) return;
  if (!initialEvents.some((e) => e.eventType === 'task.cancel_finished')) {
    await inMergeDirLock(db, dir, async (tx) => {
      const m = leftCommittedMerges(await records(tx, taskId)).find(
        (m) => m.dir === dir && m.baseShaAfter === baseShaAfter,
      );
      if (m && !m.settled)
        await tx.insert(schema.taskEvents).values({
          taskId,
          taskStepId: null,
          eventType: MERGE_LEFT_COMMITTED_SETTLED_EVENT,
          payload: {
            dir,
            baseShaAfter,
            outcome: 'refused',
            reason: 'Cancellation cleanup is still running; try again after it finishes.',
          },
        });
    });
    return;
  }
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
  let refTransactionsChecked = false;
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
        if (m.settled && !m.resyncOwed) return;
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
        if (m.settled) {
          // Settlement finalized the git move, but a crash may have skipped hand-back.
          // Only hand back the checkout still at the Undo result; a switched/detached
          // checkout or a later commit is unrelated. Its projections still need re-sync.
          const symbolic = await gitRun(m.dir, ['symbolic-ref', '-q', 'HEAD']);
          if (
            symbolic.code === 0 &&
            symbolic.stdout.trim() === `refs/heads/${m.landedOn}` &&
            (await undoRevParse(m.dir, 'HEAD')) === m.baseShaBefore
          )
            movedCheckout = m.dir;
          // Do not recreate a feature branch a person deleted after Undo.
          needsSync = true;
          return;
        }
        {
          const cwd = m.repoPath;
          const restoreFeature = async () => {
            if (typeof m.featureBranch !== 'string' || !sha(m.featureSha)) return;
            const ref = `refs/heads/${m.featureBranch}`;
            if ((await undoRevParse(cwd, ref)) === null) {
              const created = await gitRun(cwd, ['update-ref', ref, m.featureSha, '0'.repeat(40)]);
              if (created.code !== 0 && (await undoRevParse(cwd, ref)) === null)
                throw new UndoGitError(
                  gitFailureReason('Feature branch could not be restored', created.stderr),
                );
            }
          };
          if (!(await validBranch(cwd, m.landedOn)) || !(await ownMerge(cwd, m))) {
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
          // Git's update-ref does not protect a branch checked out in another worktree.
          const holders = await worktreesHoldingBranch(cwd, branch).catch((error: unknown) => {
            throw new UndoGitError(gitFailureReason('Cannot read the repository worktrees', error));
          });
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
          const prior = await undoRevParse(cwd, undoRef);
          const tip = await undoRevParse(cwd, branch);
          if (tip !== m.baseShaAfter) {
            if (tip === m.baseShaBefore && prior === m.baseShaAfter) {
              needsSync = true;
              await restoreFeature();
              await settle(
                'undone',
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
          if (!refTransactionsChecked) {
            try {
              await checkGitRefTransactions(cwd);
              refTransactionsChecked = true;
            } catch (error) {
              if (!(error instanceof GitRefTransactionStartError)) {
                if (error instanceof GitRefTransactionError)
                  throw new UndoGitError(gitFailureReason('Git refused the undo', error));
                throw error;
              }
              await settle(
                'refused',
                gitFailureReason(
                  'Git exited before acknowledging the ref transaction. Check Git and the repository, then retry Undo.',
                  error,
                ),
              );
              return;
            }
          }
          const checkoutReady = async () => {
            if (!movedCheckout) return true;
            const symbolic = await gitRun(movedCheckout, ['symbolic-ref', '-q', 'HEAD']);
            if (symbolic.code !== 0 && symbolic.code !== 1)
              throw new UndoGitError(
                gitFailureReason(
                  'Git could not read the checkout branch before Undo.',
                  symbolic.stderr,
                ),
              );
            if (symbolic.code !== 0 || symbolic.stdout.trim() !== branch) {
              await settle(
                'refused',
                'The checkout is no longer on the base branch; nothing was changed. Retry Undo to check the current branch checkouts again.',
              );
              return false;
            }
            if ((await undoRevParse(movedCheckout, 'HEAD')) !== m.baseShaAfter) {
              await settle('moved', 'The checkout moved since this merge; nothing was changed.');
              return false;
            }
            try {
              if (await gitOperationInProgress(movedCheckout, m.repoPath)) {
                await settle(
                  'refused',
                  'A Git operation is in progress in this checkout. Finish or abort it, then retry Undo.',
                );
                return false;
              }
            } catch (error) {
              if (error instanceof GitOperationUnreadableError)
                throw new UndoGitError(
                  gitFailureReason('Cannot check for a Git operation before Undo', error),
                );
              throw error;
            }
            return true;
          };
          if (!(await checkoutReady())) return;
          // The retained ref proves an earlier Undo was admitted. Check before any
          // projection set-aside can rewrite an interrupted index back toward HEAD.
          const finishingInterruptedMove =
            prior === m.baseShaAfter &&
            movedCheckout !== null &&
            (await interruptedCheckoutMove(movedCheckout, m));
          if (movedCheckout === m.repoPath && !finishingInterruptedMove) {
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
          // Set-aside rewrites bytes without refreshing git's cached stat data. The
          // two-tree read-tree otherwise intermittently refuses an unchanged projection.
          if (movedCheckout && !finishingInterruptedMove) {
            const refreshed = await gitRun(movedCheckout, ['update-index', '-q', '--refresh']);
            // Exit 1 also reports real local edits, which the read-tree must judge and keep.
            if (refreshed.code !== 0 && refreshed.code !== 1)
              throw new UndoGitError(
                gitFailureReason(
                  'Git could not refresh the checkout index before Undo.',
                  refreshed.stderr,
                ),
              );
            // The move acts on whatever HEAD is now: re-check branch and sha last, so a
            // checkout switch or commit during preparation never rewinds another branch.
            if (!(await checkoutReady())) return;
            // Staged changes are refused before the move so none is lost from the index.
            // Set-aside already restores projection entries to HEAD, so no paths need
            // excluding. A configured submodule ignore would hide a staged gitlink.
            const staged = await gitRun(movedCheckout, [
              'diff',
              '--cached',
              '--quiet',
              '--ignore-submodules=none',
              'HEAD',
            ]);
            if (staged.code === 1) {
              await settle(
                'refused',
                'This checkout has staged changes. Commit or unstage them before trying Undo again.',
              );
              return;
            }
            if (staged.code !== 0)
              throw new UndoGitError(
                gitFailureReason(
                  'Git could not read the checkout index before Undo.',
                  staged.stderr,
                ),
              );
          }
          if (prior !== m.baseShaAfter) {
            const keep = await gitRun(cwd, ['update-ref', undoRef, m.baseShaAfter, '0'.repeat(40)]);
            if (keep.code !== 0)
              throw new UndoGitError(
                gitFailureReason(
                  'The merge commit could not be preserved for recovery',
                  keep.stderr,
                ),
              );
          }
          let moved: boolean;
          try {
            moved = await withGitRefTransaction(
              cwd,
              branch,
              m.baseShaBefore,
              m.baseShaAfter,
              async () => {
                // A checkout may have acquired the branch before prepare locked it.
                // Refuse a changed holder set instead of moving a newly acquired tree.
                const lockedHolders = await worktreesHoldingBranch(cwd, branch).catch(
                  (error: unknown) => {
                    throw new UndoGitError(
                      gitFailureReason('Cannot read the repository worktrees', error),
                    );
                  },
                );
                if (
                  lockedHolders.length !== holders.length ||
                  lockedHolders.some((p) => !holders.includes(p))
                ) {
                  await settle(
                    'refused',
                    'The base branch checkout changed. Release any other worktree and retry Undo.',
                  );
                  return false;
                }
                if (!movedCheckout) return true;
                if (!(await checkoutReady())) return false;
                if (finishingInterruptedMove) {
                  // Re-prove under the prepared CAS lock; recovery writes no checkout bytes.
                  if (await interruptedCheckoutMove(movedCheckout, m)) return true;
                  await settle(
                    'refused',
                    'The interrupted Undo checkout changed; local changes were kept. Repair the checkout and retry Undo.',
                  );
                  return false;
                }
                // With no staged changes, this matches reset --keep's two-tree unpack:
                // paths changed by the move must be clean; unrelated local bytes stay.
                // Unlike reset it never writes HEAD or acquires the held branch lock.
                const tree = await gitRun(movedCheckout, [
                  'read-tree',
                  '-m',
                  '-u',
                  m.baseShaAfter,
                  m.baseShaBefore,
                ]);
                if (tree.code === 0) return true;
                await settle(
                  'refused',
                  gitFailureReason(
                    'Git refused the undo; local changes or a changed branch were kept.',
                    tree.stderr,
                  ),
                );
                return false;
              },
            );
          } catch (error) {
            if (error instanceof GitRefTransactionCommittedError) {
              needsSync = true;
              throw new UndoGitError(
                gitFailureReason(
                  'The base branch moved back, but a later Git cleanup step failed. Retry Undo to finish recovery.',
                  error,
                ),
              );
            }
            if (error instanceof GitRefTransactionError)
              throw new UndoGitError(gitFailureReason('Git refused the undo', error));
            throw error;
          }
          if (!moved) return;
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
        // Strict: a failed chown throws, so the re-sync is not recorded as complete over files
        // the sandbox user cannot write; the report stays owed and Retry stays offered.
        if (movedCheckout) await handBackAfterMove(movedCheckout, initial.baseShaAfter, true);
        if (!(await resyncHaiveProjections(db, task.repositoryId, initial.repoPath, taskId)))
          throw new Error("Haive's project files were not re-synced yet; the job will retry");
        // Re-sync owns its transactions. Journal its success afterwards under the report's
        // lock, so redelivery adds no duplicate and no connection is held over re-sync.
        await inMergeDirLock(db, dir, async (tx) => {
          const m = leftCommittedMerges(await records(tx, taskId)).find(
            (m) => m.dir === dir && m.baseShaAfter === baseShaAfter,
          );
          if (!m?.resyncOwed) return;
          await tx.insert(schema.taskEvents).values({
            taskId,
            taskStepId: null,
            eventType: MERGE_LEFT_COMMITTED_RESYNCED_EVENT,
            payload: { dir, baseShaAfter },
          });
        });
      } else if (kept) {
        await putBackProjections(db, task.repositoryId, initial.repoPath, kept, section);
      }
    } finally {
      if (root) await (root as RootClaimHandle).release();
    }
  }
}
