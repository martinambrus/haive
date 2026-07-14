import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { desc, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  CONFIG_KEYS,
  configService,
  prFinalizeModeSchema,
  type FormField,
  type FormSchema,
} from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { buildMergeFixPrompt } from '../../git-merge.js';
import { detectOrigin, getOriginUrl, pushBranch } from '../../../repo/git-push.js';
import { removeWorktreeDir } from '../../../repo/worktree-remove.js';
import {
  ForgeError,
  isForgeProviderName,
  resolveForgeContext,
  resolveForgeProvider,
  type OpenPrResult,
} from '../../../forge/index.js';

const exec = promisify(execFile);

type CleanupAction = 'merge_remove' | 'remove_only' | 'keep' | 'create_pr';

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
  /** The user's stored git credentials, for the push credential picker. `provider`
   *  names the forge (null when unset — such a credential can push but not open PRs). */
  credentials: { id: string; label: string; host: string; provider: string | null }[];
  /** Whether the create_pr action may be offered: the global + per-repo PR workflow
   *  toggles are on, an origin remote exists, and at least one credential has a forge
   *  provider set. */
  prWorkflowAvailable: boolean;
  /** Task title/description, used as the PR title/body defaults on the form. */
  taskTitle: string;
  taskDescription: string;
}

interface WorktreeCleanupApply {
  action: CleanupAction | 'none';
  removed: boolean;
  merged: boolean;
  branchDeleted: boolean;
  mode: WorktreeCleanupDetect['mode'];
  message: string;
  /** Set on the create_pr path: the opened PR/MR URL, for the step card. */
  prUrl?: string | null;
}

interface CreatePrFormValues {
  action?: string;
  prTitle?: string;
  prBody?: string;
  prBaseBranch?: string;
  prCredentialId?: string;
  finalizeMode?: string;
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
      columns: { repositoryId: true, title: true, description: true },
    });
    const repositoryId = task?.repositoryId ?? null;
    const taskTitle = task?.title ?? '';
    const taskDescription = task?.description ?? '';

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
        prWorkflowAvailable: false,
        taskTitle,
        taskDescription,
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
    let credentials: WorktreeCleanupDetect['credentials'] = [];
    let prWorkflowAvailable = false;
    if (mode === 'worktree') {
      const res = await gitRun(ctx.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
      parentBranch = res.code === 0 ? res.stdout.trim() : null;
      hasOrigin = await detectOrigin(ctx.repoPath);
      originUrl = hasOrigin ? await getOriginUrl(ctx.repoPath) : null;
      const repo = repositoryId
        ? await ctx.db.query.repositories.findFirst({
            where: eq(schema.repositories.id, repositoryId),
            columns: { credentialsSecretId: true, prWorkflowEnabled: true },
          })
        : null;
      boundCredentialId = repo?.credentialsSecretId ?? null;
      const rows = await ctx.db.query.repoCredentials.findMany({
        where: eq(schema.repoCredentials.userId, ctx.userId),
        columns: { id: true, label: true, host: true, provider: true },
        orderBy: [desc(schema.repoCredentials.createdAt)],
      });
      credentials = rows.map((r) => ({
        id: r.id,
        label: r.label,
        host: r.host,
        provider: r.provider,
      }));
      // Offer create_pr only when the whole chain is in place: the global kill-switch
      // and the per-repo enable are on, a pushable origin exists, and at least one
      // credential names a forge provider whose REST API can open the PR.
      const prGlobalEnabled = await configService.getBoolean(
        CONFIG_KEYS.PR_WORKFLOW_ENABLED,
        false,
      );
      prWorkflowAvailable =
        prGlobalEnabled &&
        (repo?.prWorkflowEnabled ?? false) &&
        hasOrigin &&
        !!originUrl &&
        credentials.some((c) => isForgeProviderName(c.provider));
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
      prWorkflowAvailable,
      taskTitle,
      taskDescription,
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

    const actionOptions = [
      {
        value: 'merge_remove',
        label: `Merge ${branch} into ${base}, then remove the worktree`,
      },
    ];
    if (detected.prWorkflowAvailable) {
      actionOptions.push({
        value: 'create_pr',
        label: `Open a pull request from ${branch} into ${base} (keep the worktree until it merges)`,
      });
    }
    actionOptions.push(
      { value: 'remove_only', label: 'Remove the worktree, keep the branch' },
      { value: 'keep', label: 'Keep the worktree' },
    );
    fields.push(
      {
        type: 'radio',
        id: 'action',
        label: 'What should happen to the worktree?',
        options: actionOptions,
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

    // Create-PR fields — shown only when the PR workflow is available for this repo.
    if (detected.prWorkflowAvailable) {
      const prCredentialOptions = detected.credentials
        .filter((c) => isForgeProviderName(c.provider))
        .map((c) => ({ value: c.id, label: `${c.label} (${c.host} — ${c.provider})` }));
      const boundIsForgeCapable =
        detected.boundCredentialId != null &&
        prCredentialOptions.some((o) => o.value === detected.boundCredentialId);
      const defaultPrCredential = boundIsForgeCapable
        ? (detected.boundCredentialId as string)
        : (prCredentialOptions[0]?.value ?? '');
      const prBaseDefault = detected.baseBranch ?? detected.parentBranch ?? 'main';
      fields.push(
        {
          type: 'text',
          id: 'prTitle',
          label: 'Pull request title',
          default: detected.taskTitle,
          required: true,
          visibleWhen: { field: 'action', equals: 'create_pr' },
        },
        {
          type: 'textarea',
          id: 'prBody',
          label: 'Pull request description',
          default: detected.taskDescription,
          rows: 6,
          visibleWhen: { field: 'action', equals: 'create_pr' },
        },
        {
          type: 'text',
          id: 'prBaseBranch',
          label: 'Base branch (the PR merges into this)',
          default: prBaseDefault,
          required: true,
          visibleWhen: { field: 'action', equals: 'create_pr' },
        },
        {
          type: 'select',
          id: 'prCredentialId',
          label: 'Forge credential to open the PR with',
          description:
            'Must be a credential with a forge provider set (GitHub, Gitea/Forgejo, GitLab, Bitbucket) and a token that can create pull requests.',
          options: prCredentialOptions,
          default: defaultPrCredential,
          visibleWhen: { field: 'action', equals: 'create_pr' },
        },
        {
          type: 'radio',
          id: 'finalizeMode',
          label: 'When the PR merges',
          options: [
            { value: 'auto', label: 'Automatically finish this task (reap the worktree)' },
            { value: 'manual', label: 'Wait for me to click Finalize' },
          ],
          default: 'auto',
          visibleWhen: { field: 'action', equals: 'create_pr' },
        },
      );
    }

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
      values.action === 'keep' ||
      values.action === 'create_pr'
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

    if (action === 'create_pr') {
      return openPullRequestForCleanup(ctx, d, args.formValues as CreatePrFormValues);
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
    // removeWorktreeDir repairs a poisoned gitfile, then falls back from
    // `git worktree remove` to a chmod-then-rm for read-only trees (Drupal's 0555
    // sites/default). Failing here must be loud: returning `done` with removed:false
    // reported success while the worktree and its branch survived. The merge commit
    // is already durable, so a Retry re-enters with mergeResolve short-circuiting.
    const removal = await removeWorktreeDir(ctx.repoPath, d.worktreePath);
    if (!removal.removed) {
      ctx.logger.error({ err: removal.error }, 'worktree removal failed');
      throw new Error(
        `${merged ? `merged ${d.branchName} into ${mergeTarget}, but ` : ''}removing the worktree at ${d.worktreePath} failed: ${removal.error ?? 'unknown error'}`,
      );
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
    // A requested delete that git refused must not read as a silent success.
    else if (values.deleteBranch && d.branchName)
      parts.push(`branch ${d.branchName} NOT deleted (git refused; see worker log)`);

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

/** create_pr apply: ensure the feature branch is on origin, open a PR/MR on the repo's
 *  forge, and record it on the task row. Leaves the worktree in place — the trailing
 *  13-pr-wait step parks the task in waiting_pr and finalizes on merge. */
async function openPullRequestForCleanup(
  ctx: StepContext,
  d: WorktreeCleanupDetect,
  values: CreatePrFormValues,
): Promise<WorktreeCleanupApply> {
  if (!d.branchName || !d.originUrl) {
    throw new Error(
      'Cannot open a pull request: the worktree branch or the origin remote is unavailable.',
    );
  }

  // Idempotency: a Retry after the PR was already opened must not open a second one.
  const existing = await ctx.db.query.tasks.findFirst({
    where: eq(schema.tasks.id, ctx.taskId),
    columns: { prUrl: true },
  });
  const priorPrUrl = existing?.prUrl;
  if (priorPrUrl) {
    return {
      action: 'create_pr',
      removed: false,
      merged: false,
      branchDeleted: false,
      mode: 'worktree',
      message: `pull request already open: ${priorPrUrl}`,
      prUrl: priorPrUrl,
    };
  }

  const credentialId = values.prCredentialId?.trim();
  if (!credentialId) {
    throw new Error('Choose a forge credential (with a provider set) to open the pull request.');
  }
  const baseBranch = values.prBaseBranch?.trim() || d.baseBranch || d.parentBranch;
  if (!baseBranch) {
    throw new Error('No base branch to open the pull request against.');
  }
  const title = values.prTitle?.trim() || d.taskTitle || d.branchName;
  const body = values.prBody ?? d.taskDescription ?? '';
  const finalizeMode = prFinalizeModeSchema.catch('auto').parse(values.finalizeMode);

  // Make sure the feature branch is on origin. It was pushed at 11a-gate-4-push, but
  // fix loops after that push can add commits. Host-side; git works here (the sandbox
  // git ban is cli-exec only).
  await pushBranch({
    cwd: ctx.repoPath,
    branch: d.branchName,
    setUpstream: true,
    credentialId,
    db: ctx.db,
    userId: ctx.userId,
  });

  let provider: string;
  let result: OpenPrResult;
  try {
    const forgeCtx = await resolveForgeContext({
      db: ctx.db,
      userId: ctx.userId,
      credentialId,
      remoteUrl: d.originUrl,
    });
    provider = forgeCtx.provider;
    result = await resolveForgeProvider(forgeCtx.provider).openPullRequest(forgeCtx, {
      head: d.branchName,
      base: baseBranch,
      title,
      body,
    });
  } catch (err) {
    if (err instanceof ForgeError) {
      // Loud + actionable: the branch is safely on origin, so a Retry after fixing the
      // token/scope re-enters cleanly.
      throw new Error(`Opening the pull request failed: ${err.message}`);
    }
    throw err;
  }

  await ctx.db
    .update(schema.tasks)
    .set({
      prProvider: provider,
      prUrl: result.url,
      prNumber: result.number,
      prState: 'open',
      prFinalizeMode: finalizeMode,
      prCredentialId: credentialId,
      prPollError: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.tasks.id, ctx.taskId));

  ctx.logger.info(
    { prUrl: result.url, prNumber: result.number, provider },
    'pull request opened; task will wait for it to merge',
  );
  return {
    action: 'create_pr',
    removed: false,
    merged: false,
    branchDeleted: false,
    mode: 'worktree',
    message: `opened pull request ${result.url} (${provider}); waiting for it to merge`,
    prUrl: result.url,
  };
}
