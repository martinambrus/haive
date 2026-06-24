import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { FormField, FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { resolveUserGitEnv } from '../../../secrets/user-git-identity.js';

const exec = promisify(execFile);

const FALLBACK_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Haive',
  GIT_AUTHOR_EMAIL: 'worker@haive.local',
  GIT_COMMITTER_NAME: 'Haive',
  GIT_COMMITTER_EMAIL: 'worker@haive.local',
};

type CleanupAction = 'merge_remove' | 'remove_only' | 'keep';

interface WorktreeCleanupDetect {
  mode: 'no-git' | 'inplace' | 'worktree' | 'unknown';
  worktreePath: string | null;
  branchName: string | null;
  /** Branch the worktree was created FROM (01-worktree-setup output). */
  baseBranch: string | null;
  /** The parent repo's current branch — must equal baseBranch to merge safely. */
  parentBranch: string | null;
  /** For the manual-delete terminal deep-link on the remove-only path. */
  repositoryId: string | null;
}

interface WorktreeCleanupApply {
  action: CleanupAction | 'none';
  removed: boolean;
  merged: boolean;
  branchDeleted: boolean;
  mode: WorktreeCleanupDetect['mode'];
  message: string;
}

async function gitRun(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const opts = env ? { cwd, env: { ...process.env, ...env } } : { cwd };
    const { stdout, stderr } = await exec('git', args, opts);
    return { stdout: stdout.toString(), stderr: stderr.toString(), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: (e.stdout ?? '').toString(),
      stderr: (e.stderr ?? '').toString(),
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

export const worktreeCleanupStep: StepDefinition<WorktreeCleanupDetect, WorktreeCleanupApply> = {
  metadata: {
    id: '12-worktree-cleanup',
    workflowType: 'workflow',
    index: 14,
    title: 'Worktree cleanup',
    description:
      'Finishes the task: optionally merges the worktree branch into its base branch, then removes the worktree (or keeps it). Branch deletion is offered only after a successful merge.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<WorktreeCleanupDetect> {
    const prev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-worktree-setup');
    const output = prev?.output as {
      mode?: string;
      worktreePath?: string;
      branchName?: string;
      baseBranch?: string;
    } | null;
    const task = await ctx.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, ctx.taskId),
      columns: { repositoryId: true },
    });
    const repositoryId = task?.repositoryId ?? null;

    if (!output) {
      return {
        mode: 'unknown',
        worktreePath: null,
        branchName: null,
        baseBranch: null,
        parentBranch: null,
        repositoryId,
      };
    }
    const mode =
      output.mode === 'worktree' || output.mode === 'inplace' || output.mode === 'no-git'
        ? (output.mode as WorktreeCleanupDetect['mode'])
        : 'unknown';

    // Only the worktree mode needs the parent branch (for the merge safety check).
    let parentBranch: string | null = null;
    if (mode === 'worktree') {
      const res = await gitRun(ctx.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
      parentBranch = res.code === 0 ? res.stdout.trim() : null;
    }
    return {
      mode,
      worktreePath: output.worktreePath ?? null,
      branchName: output.branchName ?? null,
      baseBranch: output.baseBranch ?? null,
      parentBranch,
      repositoryId,
    };
  },

  form(_ctx, detected): FormSchema {
    if (detected.mode !== 'worktree' || !detected.worktreePath) {
      const description =
        detected.mode === 'inplace'
          ? 'Workflow ran in-place on the existing checkout. No worktree to clean up.'
          : detected.mode === 'no-git'
            ? 'No git repository; nothing to clean up.'
            : 'Worktree setup output unavailable; nothing to clean up.';
      // Nothing to decide — pass straight through (even in manual mode).
      return {
        title: 'Worktree cleanup',
        description,
        fields: [],
        submitLabel: 'Finish',
        autoSubmit: true,
      };
    }

    // Fall back to the parent's current branch for the label when no base was
    // recorded — that is where the merge will actually land.
    const base = detected.baseBranch ?? detected.parentBranch ?? 'the base branch';
    const branch = detected.branchName ?? 'this branch';
    const fields: FormField[] = [];

    // Up-front safety surface: if the parent repo is not on the base branch, the
    // merge will be skipped — warn before the user picks it.
    if (
      detected.parentBranch &&
      detected.baseBranch &&
      detected.parentBranch !== detected.baseBranch
    ) {
      fields.push({
        type: 'note',
        id: 'branchMismatchNote',
        label: 'Merge unavailable',
        body: `The parent repo is on **${detected.parentBranch}**, not the base **${detected.baseBranch}**. Merge will be skipped if chosen — switch the parent back to \`${detected.baseBranch}\` and retry to merge.`,
        variant: 'warning',
      });
    }

    fields.push(
      {
        type: 'radio',
        id: 'action',
        label: 'What should happen to the worktree?',
        options: [
          {
            value: 'merge_remove',
            label: `Merge ${branch} into ${base}, then remove the worktree`,
          },
          { value: 'remove_only', label: 'Remove the worktree, keep the branch' },
          { value: 'keep', label: 'Keep the worktree' },
        ],
        default: 'merge_remove',
        required: true,
      },
      {
        type: 'checkbox',
        id: 'deleteBranch',
        label: `Delete the ${branch} branch after merging (safe — only if fully merged)`,
        default: false,
        visibleWhen: { field: 'action', equals: 'merge_remove' },
      },
      {
        type: 'note',
        id: 'removeOnlyNote',
        label: 'Deleting the branch manually',
        // Note-field links open in a new tab. Remove-only keeps the branch, so this
        // is the (force) path to delete an unmerged branch yourself.
        body: `The **${branch}** branch is kept. To delete it manually (it may have unmerged commits), open the [repository terminal](/repos/${detected.repositoryId ?? ''}/terminal) and run \`git branch -D ${branch}\`.`,
        variant: 'info',
        visibleWhen: { field: 'action', equals: 'remove_only' },
      },
    );

    return {
      title: 'Worktree cleanup',
      description: [
        `Worktree at ${detected.worktreePath} on branch ${branch}.`,
        `Base branch: ${base}. Parent repo is on: ${detected.parentBranch ?? 'unknown'}.`,
      ].join('\n'),
      fields,
      submitLabel: 'Finish',
    };
  },

  async apply(ctx, args): Promise<WorktreeCleanupApply> {
    const d = args.detected;
    const values = args.formValues as { action?: string; deleteBranch?: boolean };

    if (d.mode !== 'worktree' || !d.worktreePath) {
      return {
        action: 'none',
        removed: false,
        merged: false,
        branchDeleted: false,
        mode: d.mode,
        message: 'no worktree to clean up',
      };
    }

    const action: CleanupAction =
      values.action === 'merge_remove' ||
      values.action === 'remove_only' ||
      values.action === 'keep'
        ? values.action
        : 'keep';

    if (action === 'keep') {
      return {
        action,
        removed: false,
        merged: false,
        branchDeleted: false,
        mode: 'worktree',
        message: `worktree kept at ${d.worktreePath}`,
      };
    }

    let merged = false;
    let mergeTarget: string | null = null;
    if (action === 'merge_remove') {
      const { branchName: branch, baseBranch: base, parentBranch } = d;
      // The merge always lands on the parent repo's checked-out branch (HEAD). The
      // intended target is the recorded base; tasks created before the base was
      // recorded fall back to the parent's CURRENT branch — the natural integration
      // point — so cleanup still merges instead of refusing.
      mergeTarget = base ?? parentBranch;
      if (!branch || !mergeTarget) {
        return {
          action,
          removed: false,
          merged: false,
          branchDeleted: false,
          mode: 'worktree',
          message:
            'cannot merge: no branch, or no base/current branch to merge into; worktree kept',
        };
      }
      // SAFETY (only when the base is known): never merge into the wrong branch — the
      // parent must still be on the base the worktree came from. When the base is
      // unknown there is nothing to verify against, so we merge into the parent's
      // current branch as-is.
      if (base && parentBranch && parentBranch !== base) {
        return {
          action,
          removed: false,
          merged: false,
          branchDeleted: false,
          mode: 'worktree',
          message: `merge skipped: parent repo is on '${parentBranch}', not the base '${base}'. Switch it back and retry; worktree kept.`,
        };
      }
      // --no-ff always creates a merge commit, so it needs a committer identity —
      // the user's git identity when set, else the Haive fallback (same as 10/11b).
      const userEnv = await resolveUserGitEnv(ctx.db, ctx.userId);
      const commitEnv = Object.keys(userEnv).length > 0 ? userEnv : FALLBACK_GIT_IDENTITY;
      const merge = await gitRun(
        ctx.repoPath,
        ['merge', '--no-ff', branch, '-m', `Merge ${branch}`],
        commitEnv,
      );
      if (merge.code !== 0) {
        // Conflict (or other failure): abort so the target branch is left clean and
        // keep the worktree so the user can resolve it by hand.
        await gitRun(ctx.repoPath, ['merge', '--abort']);
        ctx.logger.warn(
          { branch, target: mergeTarget, stderr: merge.stderr },
          'worktree merge failed; aborted',
        );
        return {
          action,
          removed: false,
          merged: false,
          branchDeleted: false,
          mode: 'worktree',
          message: `merge conflict merging ${branch} into ${mergeTarget}; merge aborted and worktree kept so you can resolve it manually.`,
        };
      }
      merged = true;
    }

    // Remove the worktree (both merge_remove and remove_only). git -C targets the
    // parent repo so it works regardless of the worker's cwd.
    const rm = await gitRun(ctx.repoPath, ['worktree', 'remove', d.worktreePath, '--force']);
    if (rm.code !== 0) {
      ctx.logger.error({ stderr: rm.stderr }, 'git worktree remove failed');
      return {
        action,
        removed: false,
        merged,
        branchDeleted: false,
        mode: 'worktree',
        message: `${merged ? 'merged, but ' : ''}git worktree remove failed: ${rm.stderr || rm.stdout}`,
      };
    }

    // Safe branch delete ONLY after a successful merge (git branch -d refuses an
    // unmerged branch). remove_only never deletes — the branch stays recoverable.
    let branchDeleted = false;
    if (action === 'merge_remove' && values.deleteBranch && d.branchName) {
      const del = await gitRun(ctx.repoPath, ['branch', '-d', d.branchName]);
      if (del.code === 0) branchDeleted = true;
      else
        ctx.logger.warn(
          { branch: d.branchName, stderr: del.stderr },
          'safe branch delete failed; left in place',
        );
    }

    const parts: string[] = [];
    if (merged) parts.push(`merged ${d.branchName} into ${mergeTarget}`);
    parts.push(`removed worktree ${d.worktreePath}`);
    if (branchDeleted) parts.push(`deleted branch ${d.branchName}`);
    else if (action === 'remove_only') parts.push(`kept branch ${d.branchName}`);

    ctx.logger.info({ action, merged, branchDeleted }, 'worktree cleanup complete');
    return {
      action,
      removed: true,
      merged,
      branchDeleted,
      mode: 'worktree',
      message: parts.join('; '),
    };
  },
};
