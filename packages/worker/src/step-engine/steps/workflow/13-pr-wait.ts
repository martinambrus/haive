import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { removeWorktreeDir } from '../../../repo/worktree-remove.js';
import { killTaskDdevRunners } from '../../../sandbox/ddev-runner.js';
import { killTaskAppRunners } from '../../../sandbox/app-runner.js';
import { killTaskIdeContainers } from '../../../sandbox/ide-runner.js';

interface PrWaitDetect {
  /** True when this task opened a pull request (12-worktree-cleanup create_pr). When
   *  false the step is a no-op pass-through and the task completes normally. */
  pending: boolean;
  prUrl: string | null;
  prProvider: string | null;
  finalizeMode: string | null;
  worktreePath: string | null;
  branchName: string | null;
}

interface PrWaitApply {
  finalized: boolean;
  removed: boolean;
  message: string;
}

/** Terminal step of the create_pr close-out path. When a PR was opened, it parks the
 *  task in waiting_pr while the PR is reviewed (shedding the ddev/IDE runtime but
 *  keeping the worktree), then on merge (auto via the poller) or a manual Finalize it
 *  removes the worktree and lets the task complete. A verified no-op for every task
 *  that did not open a PR, so it is safe as the always-present terminal step. */
export const prWaitStep: StepDefinition<PrWaitDetect, PrWaitApply> = {
  metadata: {
    id: '13-pr-wait',
    workflowType: 'workflow',
    index: 15,
    title: 'Pull request',
    description:
      'Waits for the pull request opened at cleanup to merge, then removes the worktree and finishes the task. A no-op when no PR was opened.',
    requiresCli: false,
  },

  // When this step parks (a PR is open), show the task as waiting_pr rather than the
  // generic waiting_user, so the UI and the PR-status poller can key on it. Only takes
  // effect when the step actually parks — the no-PR path returns a null form and never
  // parks, so a non-PR task never enters waiting_pr.
  parkTaskStatus: 'waiting_pr',

  async detect(ctx: StepContext): Promise<PrWaitDetect> {
    const task = await ctx.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, ctx.taskId),
      columns: {
        prUrl: true,
        prProvider: true,
        prFinalizeMode: true,
        worktreePath: true,
        worktreeBranch: true,
      },
    });
    const pending = !!task?.prUrl;
    if (pending) {
      // Keep-worktree-only: shed the expensive per-task runtime (ddev / app-runner /
      // browser IDE) now that the work is on origin behind a PR, but leave the worktree
      // on disk so a "Reopen environment" can rebuild it to address review feedback.
      // Idempotent (a no-op if already gone); detect runs once (its output is persisted),
      // so a later reopen is not clobbered by a re-run.
      await Promise.allSettled([
        killTaskDdevRunners(ctx.taskId),
        killTaskAppRunners(ctx.taskId),
        killTaskIdeContainers(ctx.taskId),
      ]);
    }
    return {
      pending,
      prUrl: task?.prUrl ?? null,
      prProvider: task?.prProvider ?? null,
      finalizeMode: task?.prFinalizeMode ?? null,
      worktreePath: task?.worktreePath ?? null,
      branchName: task?.worktreeBranch ?? null,
    };
  },

  form(_ctx, detected): FormSchema | null {
    // No PR → nothing to wait for. Return null so the step skips straight to apply
    // (a no-op) and the task completes as it would without this step — no park, so a
    // non-PR task never touches waiting_pr.
    if (!detected.pending) return null;

    const finalizeLine =
      detected.finalizeMode === 'manual'
        ? 'This task waits for you to click Finalize.'
        : 'This task finishes automatically when the pull request merges.';
    return {
      title: 'Pull request',
      description: 'Waiting for the pull request to be reviewed and merged.',
      fields: [
        {
          type: 'note',
          id: 'prWaitNote',
          label: 'Pull request open',
          body: `Branch **${detected.branchName ?? ''}** is on the remote as a pull request${
            detected.prProvider ? ` (${detected.prProvider})` : ''
          }. ${finalizeLine} The worktree is kept until then — use **Reopen environment** to make review-requested changes and push them to the PR branch. [Open the pull request](${detected.prUrl ?? ''})`,
          variant: 'info',
        },
      ],
      submitLabel: 'Finalize now (remove the worktree and finish)',
    };
  },

  async apply(ctx, args): Promise<PrWaitApply> {
    const d = args.detected;
    if (!d.pending) {
      return { finalized: false, removed: false, message: 'no pull request; nothing to wait for' };
    }
    if (!d.worktreePath) {
      return { finalized: true, removed: false, message: 'finalized (no worktree recorded)' };
    }
    // Finalize: remove the worktree (keep the local branch — the merge is on the remote).
    // Loud on failure like 12-worktree-cleanup: a silent removed:false would leak the
    // worktree, since completion teardown does not reap it for workflow tasks.
    const res = await removeWorktreeDir(ctx.repoPath, d.worktreePath);
    if (!res.removed) {
      ctx.logger.error(
        { err: res.error, worktreePath: d.worktreePath },
        'pr-wait worktree removal failed',
      );
      throw new Error(
        `removing the worktree at ${d.worktreePath} failed: ${res.error ?? 'unknown error'}`,
      );
    }
    ctx.logger.info({ prUrl: d.prUrl }, 'pr-wait finalized; worktree removed');
    return {
      finalized: true,
      removed: true,
      message: `finalized: removed worktree ${d.worktreePath}`,
    };
  },
};
