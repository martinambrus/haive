import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { desc, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { FormField, FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { buildMergeFixPrompt } from '../../git-merge.js';
import { detectOrigin, getOriginUrl } from '../../../repo/git-push.js';

const exec = promisify(execFile);

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
  /** Whether the repo has a pushable `origin` remote (gates the base-push fields). */
  hasOrigin: boolean;
  originUrl: string | null;
  /** Credential bound to the repo (default selection for the push). */
  boundCredentialId: string | null;
  /** The user's stored git credentials, for the push credential picker. */
  credentials: { id: string; label: string; host: string }[];
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

  mergeResolve: {
    requiredCapabilities: ['tool_use', 'file_write'],
    // Only the merge_remove action performs a merge; keep / remove_only skip the phase.
    selectedMerge: (formValues) => formValues.action === 'merge_remove',
    buildFixPrompt: ({ featureBranch, guidance }) =>
      buildMergeFixPrompt(featureBranch, undefined, guidance),
    buildClarificationForm: ({ baseBranch, featureBranch, uncertainty }) => ({
      title: 'Merge conflict — your input needed',
      description: `The AI is unsure how to resolve the merge of ${featureBranch} into ${baseBranch}.`,
      fields: [
        {
          type: 'note',
          id: 'agentQuestion',
          label: "The AI's question",
          body: uncertainty || 'The AI could not confidently combine both sides.',
          variant: 'info',
        },
        {
          type: 'text',
          id: 'mergeGuidance',
          label: 'How should it resolve this conflict?',
          placeholder:
            'e.g. keep both changes; prefer the feature side for file X; renumber the hook…',
          required: true,
        },
      ],
      submitLabel: 'Send guidance',
      submitAction: 'clarify',
    }),
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
        hasOrigin: false,
        originUrl: null,
        boundCredentialId: null,
        credentials: [],
      };
    }
    const mode =
      output.mode === 'worktree' || output.mode === 'inplace' || output.mode === 'no-git'
        ? (output.mode as WorktreeCleanupDetect['mode'])
        : 'unknown';

    // Only the worktree mode needs the parent branch (merge target) and the push
    // affordances (origin presence + the user's credentials).
    let parentBranch: string | null = null;
    let hasOrigin = false;
    let originUrl: string | null = null;
    let boundCredentialId: string | null = null;
    let credentials: { id: string; label: string; host: string }[] = [];
    if (mode === 'worktree') {
      const res = await gitRun(ctx.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
      parentBranch = res.code === 0 ? res.stdout.trim() : null;
      hasOrigin = await detectOrigin(ctx.repoPath);
      originUrl = hasOrigin ? await getOriginUrl(ctx.repoPath) : null;
      const repo = repositoryId
        ? await ctx.db.query.repositories.findFirst({
            where: eq(schema.repositories.id, repositoryId),
            columns: { credentialsSecretId: true },
          })
        : null;
      boundCredentialId = repo?.credentialsSecretId ?? null;
      const rows = await ctx.db.query.repoCredentials.findMany({
        where: eq(schema.repoCredentials.userId, ctx.userId),
        columns: { id: true, label: true, host: true },
        orderBy: [desc(schema.repoCredentials.createdAt)],
      });
      credentials = rows.map((r) => ({ id: r.id, label: r.label, host: r.host }));
    }
    return {
      mode,
      worktreePath: output.worktreePath ?? null,
      branchName: output.branchName ?? null,
      baseBranch: output.baseBranch ?? null,
      parentBranch,
      repositoryId,
      hasOrigin,
      originUrl,
      boundCredentialId,
      credentials,
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

    // Up-front guard for the cross-branch case (parent checkout moved off the base).
    // The merge now runs via a transient worktree on the base branch, so it is never
    // skipped — but without an origin it can only persist locally.
    if (
      detected.parentBranch &&
      detected.baseBranch &&
      detected.parentBranch !== detected.baseBranch
    ) {
      fields.push(
        detected.hasOrigin
          ? {
              type: 'note',
              id: 'branchMismatchNote',
              label: 'Cross-branch merge',
              body: `The parent checkout is on **${detected.parentBranch}**, not the base **${detected.baseBranch}**. Haive will merge **${branch}** into **${detected.baseBranch}** via a temporary worktree (your current checkout stays untouched), then optionally push **${detected.baseBranch}** to origin.`,
              variant: 'info',
            }
          : {
              type: 'note',
              id: 'branchMismatchNote',
              label: 'Merge will stay local',
              body: `The parent checkout is on **${detected.parentBranch}**, not the base **${detected.baseBranch}**. Haive will merge **${branch}** into **${detected.baseBranch}** via a temporary worktree and commit it — so the merge IS saved in this repository. But there is **no origin remote**, so it cannot be pushed anywhere. Add an origin (the Push gate or the repo terminal) and push **${detected.baseBranch}** yourself to put it on a remote.`,
              variant: 'warning',
            },
      );
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

    // Base-branch push — offered only when the repo has a pushable origin. Hidden
    // entirely for local-only repos (push is impossible there).
    if (detected.hasOrigin) {
      const credentialOptions = [
        ...detected.credentials.map((c) => ({ value: c.id, label: `${c.label} (${c.host})` })),
        { value: '', label: 'Authenticate manually (no stored credential)' },
      ];
      const defaultCredential =
        detected.boundCredentialId &&
        detected.credentials.some((c) => c.id === detected.boundCredentialId)
          ? detected.boundCredentialId
          : '';
      fields.push(
        {
          type: 'checkbox',
          id: 'pushBase',
          label: `Push ${base} to origin (${detected.originUrl ?? 'origin'}) after merging`,
          default: false,
          visibleWhen: { field: 'action', equals: 'merge_remove' },
        },
        {
          type: 'select',
          id: 'credentialId',
          label: 'Credential to push with',
          description:
            'Used only for this push; the token is never written to git config. Choose "manually" for SSH or public remotes.',
          options: credentialOptions,
          default: defaultCredential,
          visibleWhen: { field: 'action', equals: 'merge_remove' },
        },
        {
          type: 'checkbox',
          id: 'setUpstream',
          label: 'Set upstream (-u) so future pushes default to origin',
          default: true,
          visibleWhen: { field: 'action', equals: 'merge_remove' },
        },
      );
    }

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

    // The merge (action === 'merge_remove') runs in resolveMergePhase BEFORE apply.
    // Read its terminal outcome to decide whether the worktree may be removed.
    let merged = false;
    let mergeTarget: string | null = null;
    if (action === 'merge_remove') {
      const row = await ctx.db.query.taskSteps.findFirst({
        where: eq(schema.taskSteps.id, ctx.taskStepId),
        columns: { mergeResolveState: true },
      });
      const st = row?.mergeResolveState ?? null;
      merged = st?.merged ?? false;
      mergeTarget = st?.baseBranch || null;
      if (!merged) {
        // The merge did not run (e.g. the parent checkout is off the base branch).
        // Keep the worktree so the user can integrate manually.
        return {
          action,
          removed: false,
          merged: false,
          branchDeleted: false,
          mode: 'worktree',
          message: st?.skipReason
            ? `merge skipped: ${st.skipReason}; worktree kept.`
            : 'merge did not run; worktree kept.',
        };
      }
    }

    // Remove the worktree (merge_remove after a successful merge, or remove_only).
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
