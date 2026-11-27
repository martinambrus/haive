import {
  prepareProjectStatePush,
  commitProjectStatePush,
  projectionPushIdentity,
} from '../../../project-state/push.js';
import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  CONFIG_KEYS,
  configService,
  prFinalizeModeSchema,
  type FormField,
  type FormSchema,
} from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { gitRemoteIdentity, redactGitUrl } from '@haive/shared/schemas';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { buildMergeFixPrompt } from '../../git-merge.js';
import { gitRun } from '../../../repo/git-exec.js';
import { OriginUrlError, getOriginUrl, pushBranch, taskRemoteUrl } from '../../../repo/git-push.js';
import { worktreesHoldingBranch } from '../../../repo/git-workspace.js';
import { removeWorktreeDir } from '../../../repo/worktree-remove.js';
import {
  listBranchProjectionEdits,
  projectionRevertNotes,
  putBackProjections,
  warnStep,
} from '../../../project-state/branch-revert.js';
import {
  describeChanges,
  readUncommittedChanges,
  type UncommittedChanges,
} from '../../../repo/worktree-changes.js';
import { findWorktreePathClaimant } from '../../../repo/worktree-claims.js';
import {
  ForgeError,
  credentialForgeProvider,
  credentialUsableForPr,
  resolveForgeContext,
  resolveForgeProvider,
  type OpenPrResult,
} from '../../../forge/index.js';

type CleanupAction = 'merge_remove' | 'remove_only' | 'keep' | 'create_pr';

const MAX_LISTED_UNCOMMITTED = 20;

interface WorktreeCleanupDetect {
  mode: 'no-git' | 'inplace' | 'worktree' | 'unknown';
  worktreePath: string | null;
  branchName: string | null;
  /** Branch the worktree was created FROM (01-worktree-setup output). */
  baseBranch: string | null;
  /** The parent repo's current branch — must equal baseBranch to merge safely. */
  parentBranch: string | null;
  /** What the worktree holds that no commit does, which the merge cannot carry. Null when git
   *  could not say, or the output predates the field: never a clean tree. */
  uncommitted: UncommittedChanges | null;
  /** Haive's own files the branch changed since it forked; absent on an output that predates it. */
  projectionEdits?: string[];
  /** For the manual-delete terminal deep-link on the remove-only path. */
  repositoryId: string | null;
  /** Whether the repo has a pushable `origin` remote (gates the base-push fields). */
  hasOrigin: boolean;
  originUrl: string | null;
  originError?: string | null;
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

interface BranchLeftover {
  branch: string;
  reason:
    | 'not-contained-in-squash'
    | 'unreadable-squash'
    | 'unreadable-branch'
    | 'checked-out'
    | 'delete-refused'
    | 'unreadable-worktrees'
    | 'symbolic-ref'
    | 'config-cleanup-refused';
}

/** Compare-and-delete only commits contained in the feature head the squash actually landed. */
async function deleteSquashedBranch(
  repoPath: string,
  branch: string,
  mergedFeature: string | null,
): Promise<{ reason: BranchLeftover['reason'] | null; tip: string | null }> {
  let sha: string | null = null;
  const result = (reason: BranchLeftover['reason'] | null) => ({ reason, tip: sha });
  const cleanConfig = async () => {
    const config = await gitRun(repoPath, ['config', '--remove-section', `branch.${branch}`]);
    // Git exits 128 when there is no section, including Retry after config cleanup.
    return result(config.code === 0 || config.code === 128 ? null : 'config-cleanup-refused');
  };
  const ref = `refs/heads/${branch}`;
  const symbolic = await gitRun(repoPath, ['symbolic-ref', '-q', ref]);
  if (symbolic.code !== 0 && symbolic.code !== 1) return result('unreadable-branch');
  const tip = await gitRun(repoPath, ['rev-parse', '-q', '--verify', ref]);
  if (symbolic.code === 0) {
    sha = tip.code === 0 ? tip.stdout.trim() : null;
    return result('symbolic-ref');
  }
  if (tip.code === 1) {
    // rev-parse also exits 1 for a junk loose ref; show-ref refuses that with 128.
    const exists = await gitRun(repoPath, ['show-ref', '--verify', '--quiet', ref]);
    return exists.code === 1 ? cleanConfig() : result('unreadable-branch');
  }
  if (tip.code !== 0) return result('unreadable-branch');
  sha = tip.stdout.trim();
  if (!mergedFeature) return result('unreadable-squash');
  const contained = await gitRun(repoPath, ['merge-base', '--is-ancestor', sha, mergedFeature]);
  if (contained.code === 1) return result('not-contained-in-squash');
  if (contained.code !== 0) return result('unreadable-branch');
  // update-ref has no branch -D holder checks, including detached rebase/bisect state.
  try {
    if ((await worktreesHoldingBranch(repoPath, ref, true)).length) return result('checked-out');
  } catch {
    return result('unreadable-worktrees');
  }
  const del = await gitRun(repoPath, ['update-ref', '-d', ref, sha, '--no-deref']);
  return del.code === 0 ? cleanConfig() : result('delete-refused');
}

function branchLeftoverMessage(branch: string, reason: BranchLeftover['reason']): string {
  const explanation: Record<BranchLeftover['reason'], string> = {
    'not-contained-in-squash': 'it contains commits outside the recorded squash',
    'unreadable-squash': 'the recorded merge evidence is missing or unreadable',
    'unreadable-branch': 'Git could not verify its tip or ancestry',
    'checked-out': 'another worktree is using it, possibly for a rebase or bisect',
    'delete-refused': 'Git refused the compare-and-delete, possibly because its tip changed',
    'unreadable-worktrees': 'Haive could not check which worktrees are using it',
    'symbolic-ref': 'it is a symbolic ref pointing to another branch',
    'config-cleanup-refused': 'its ref is gone but Git refused to remove its branch configuration',
  };
  return `Branch ${branch} needs cleanup because ${explanation[reason]}. Inspect the branch in the repository terminal, finish any rebase or bisect, then Retry; delete it manually only after checking its commits are safe.`;
}

interface WorktreeCleanupApply {
  action: CleanupAction | 'none';
  removed: boolean;
  merged: boolean;
  branchDeleted: boolean;
  branchLeftovers?: BranchLeftover[];
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

function codeSpan(raw: string): string {
  const text = raw.replace(/[\r\n]+/g, ' ');
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  return longest > 0 ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

function uncommittedNoteBody(uncommitted: UncommittedChanges | null): string {
  if (uncommitted === null) {
    return "Haive could not read this worktree's changes, so it cannot tell whether removing it would delete work. It is kept unless you choose to delete it anyway.";
  }
  const listed = uncommitted.paths.map((p) => `- ${codeSpan(p)}`);
  const more = uncommitted.count - uncommitted.paths.length;
  if (more > 0) listed.push(`- and ${more} more`);
  return [
    `The worktree holds **${describeChanges(uncommitted.count)}**. Merging carries only committed work, so removing the worktree would delete them:`,
    '',
    ...listed,
  ].join('\n');
}

function projectionEditsNoteBody(paths: readonly string[]): string {
  const listed = paths.slice(0, MAX_LISTED_UNCOMMITTED).map((p) => `- ${codeSpan(p)}`);
  const more = paths.length - listed.length;
  if (more > 0) listed.push(`- and ${more} more`);
  return [
    `This branch changed **${paths.length}** of Haive's own project files (the project record and the plan). Haive puts them back to where the branch forked, in one commit, before it merges, pushes or leaves the branch, and says so on this step:`,
    '',
    ...listed,
    '',
    "To change one, use the repository's settings.",
  ].join('\n');
}

/** Puts the branch's Haive files back where 12 leaves it as it is, and warns for every action. */
async function noteHaiveFiles(
  ctx: StepContext,
  d: WorktreeCleanupDetect,
  action: CleanupAction,
): Promise<void> {
  if ((action === 'keep' || action === 'remove_only') && d.branchName) {
    const target = [d.baseBranch, d.parentBranch].filter((b): b is string => !!b);
    const branch = d.branchName;
    await warnStep(
      ctx,
      await putBackProjections({ ctx, worktree: d.worktreePath, branch, target }),
    );
    return;
  }
  await warnStep(ctx, await projectionRevertNotes(ctx.db, ctx.taskId));
}

/** What the step card says about the task's branches: one sentence for the task branch,
 *  then the DAG issue branches. The two are independent, so neither may hide the other. */
export function branchOutcomeParts(o: {
  action: string;
  branchName: string | null | undefined;
  deleteRequested: boolean;
  branchDeleted: boolean;
  issueBranchesDeleted: number;
  branchLeftoverReason?: BranchLeftover['reason'];
}): string[] {
  const parts: string[] = [];
  if (o.branchDeleted) parts.push(`deleted branch ${o.branchName}`);
  else if (o.branchLeftoverReason)
    parts.push(branchLeftoverMessage(o.branchName ?? '', o.branchLeftoverReason));
  else if (o.action === 'remove_only') parts.push(`kept branch ${o.branchName}`);
  // A requested delete that git refused must not read as a silent success.
  else if (o.deleteRequested && o.branchName)
    parts.push(`branch ${o.branchName} NOT deleted (git refused; see worker log)`);
  // Merged but the delete was declined. The worktree (and its terminal) is gone, so
  // name the only remaining path to that branch on the step card itself.
  else if (o.action === 'merge_remove' && o.branchName)
    parts.push(
      `kept branch ${o.branchName} (delete it in the repository terminal: git branch -d ${o.branchName})`,
    );
  if (o.issueBranchesDeleted > 0)
    parts.push(`deleted ${o.issueBranchesDeleted} merged DAG issue branch(es)`);
  return parts;
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
    // This is the one mergeResolve step that merges a branch the TASK authored, so it is
    // the only one whose history may be collapsed. The form's squashMerge checkbox is the
    // per-task opt-out on top of this.
    squashable: true,
    putBackBeforeMerge: ({ ctx, worktreePath, featureBranch, baseBranch }) =>
      putBackProjections({
        ctx,
        worktree: worktreePath,
        branch: featureBranch,
        target: baseBranch,
      }),
    buildFixPrompt: ({ featureBranch, guidance }) =>
      buildMergeFixPrompt(featureBranch, undefined, guidance, true),
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
        uncommitted: null,
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
    let uncommitted: UncommittedChanges | null = null;
    let projectionEdits: string[] = [];
    let hasOrigin = false;
    let originUrl: string | null = null;
    let originError: string | null = null;
    let boundCredentialId: string | null = null;
    let credentials: WorktreeCleanupDetect['credentials'] = [];
    let prWorkflowAvailable = false;
    if (mode === 'worktree') {
      const res = await gitRun(ctx.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
      if (res.code !== 0)
        throw new Error(
          `could not read the parent checkout's branch: ${(res.stderr || res.stdout).trim()}`,
        );
      parentBranch = res.stdout.trim();
      if (output.worktreePath)
        uncommitted = await readUncommittedChanges(output.worktreePath, MAX_LISTED_UNCOMMITTED);
      if (output.branchName) {
        projectionEdits = await listBranchProjectionEdits({
          repoPath: ctx.repoPath,
          branch: output.branchName,
          target: [output.baseBranch, parentBranch].filter((b): b is string => !!b),
        }).catch((err: unknown) => {
          ctx.logger.warn({ err }, "the branch's Haive project file edits could not be listed");
          return [];
        });
      }
      try {
        originUrl = await getOriginUrl(ctx.repoPath);
        hasOrigin = originUrl !== null;
      } catch (err) {
        if (!(err instanceof OriginUrlError)) throw err;
        originError = err.message;
      }
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
        credentials.some((c) => credentialUsableForPr(c, originUrl));
    }
    return {
      mode,
      worktreePath: output.worktreePath ?? null,
      branchName: output.branchName ?? null,
      baseBranch: output.baseBranch ?? null,
      parentBranch,
      uncommitted,
      projectionEdits,
      repositoryId,
      hasOrigin,
      originUrl,
      originError,
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
    if (detected.originError)
      fields.push({
        type: 'note',
        id: 'originError',
        label: 'Push unavailable',
        body: detected.originError,
        variant: 'warning',
      });

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
              body: detected.originError
                ? `The parent checkout is on **${detected.parentBranch}**, not the base **${detected.baseBranch}**. Haive will merge **${branch}** into **${detected.baseBranch}** via a temporary worktree and commit it locally. The origin exists but its URL is refused: ${detected.originError}. Fix the checkout's remote configuration and Retry this step to enable pushing.`
                : `The parent checkout is on **${detected.parentBranch}**, not the base **${detected.baseBranch}**. Haive will merge **${branch}** into **${detected.baseBranch}** via a temporary worktree and commit it — so the merge IS saved in this repository. But there is **no origin remote**, so it cannot be pushed anywhere. Add an origin (the Push gate or the repo terminal) and push **${detected.baseBranch}** yourself to put it on a remote.`,
              variant: 'warning',
            },
      );
    }

    // Merging carries committed work only, so a worktree holding more, or one git could not read,
    // is kept by default and removed only on an explicit choice.
    const uncommitted = detected.uncommitted ?? null;
    const holdsWork = uncommitted === null || uncommitted.count > 0;
    if (holdsWork) {
      fields.push({
        type: 'note',
        id: 'uncommittedNote',
        label: 'Uncommitted changes',
        body: uncommittedNoteBody(uncommitted),
        variant: 'warning',
      });
    }

    const edited = detected.projectionEdits ?? [];
    if (edited.length > 0) {
      fields.push({
        type: 'note',
        id: 'projectionEditsNote',
        label: "Haive's own files changed on this branch",
        body: projectionEditsNoteBody(edited),
        variant: 'warning',
      });
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
    fields.push({
      type: 'radio',
      id: 'action',
      label: 'What should happen to the worktree?',
      options: actionOptions,
      default: holdsWork ? 'keep' : 'merge_remove',
      required: true,
    });
    if (holdsWork) {
      fields.push({
        type: 'checkbox',
        id: 'discardUncommitted',
        label:
          uncommitted === null
            ? 'Delete any uncommitted changes with the worktree'
            : `Delete the ${describeChanges(uncommitted.count)} with the worktree`,
        default: false,
        visibleWhen: { field: 'action', in: ['merge_remove', 'remove_only'] },
      });
    }
    fields.push(
      {
        type: 'checkbox',
        id: 'squashMerge',
        label: `Squash ${branch} into a single commit on ${base}`,
        description: `${base} gets ONE commit for this task instead of every commit the task made along the way (one per DAG issue, plus a merge commit each, plus a commit per fix round). The changes are identical either way; only the history differs. Untick to keep the full history on ${base}.`,
        default: true,
        visibleWhen: { field: 'action', equals: 'merge_remove' },
      },
      {
        type: 'checkbox',
        id: 'deleteBranch',
        label: `Delete the ${branch} branch after merging (safe — only if fully merged)`,
        default: true,
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
        .filter((c) => credentialUsableForPr(c, detected.originUrl))
        .map((c) => ({
          value: c.id,
          label: `${c.label} (${c.host} — ${credentialForgeProvider(c.provider, c.host)})`,
        }));
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
            'Only credentials matching this forge are listed (by provider, or auto-detected from the host). The token must be able to push the branch and open pull/merge requests.',
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
          label: `Push ${base} to origin (${detected.originUrl ? redactGitUrl(detected.originUrl) : 'origin'}) after merging`,
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
    const values = args.formValues as {
      action?: string;
      deleteBranch?: boolean;
      discardUncommitted?: boolean;
    };

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

    await noteHaiveFiles(ctx, d, action);

    if (action === 'keep') {
      const held = d.uncommitted?.count ?? 0;
      return {
        action,
        removed: false,
        merged: false,
        branchDeleted: false,
        mode: 'worktree',
        message: `worktree kept at ${d.worktreePath}${held > 0 ? ` with ${describeChanges(held)}` : ''}`,
      };
    }

    if (action === 'create_pr') {
      return openPullRequestForCleanup(ctx, d, args.formValues as CreatePrFormValues);
    }

    // The merge (action === 'merge_remove') runs in resolveMergePhase BEFORE apply.
    // Read its terminal outcome to decide whether the worktree may be removed.
    let merged = false;
    let mergeTarget: string | null = null;
    // A squash hides ancestry from branch -d; its recorded merge's second parent
    // proves which feature commits landed, even if the live feature branch moved.
    let squashCommitSha: string | null = null;
    let squashMergeSha: string | undefined;
    let squashSkipReason: string | undefined;
    if (action === 'merge_remove') {
      const row = await ctx.db.query.taskSteps.findFirst({
        where: eq(schema.taskSteps.id, ctx.taskStepId),
        columns: { mergeResolveState: true },
      });
      const st = row?.mergeResolveState ?? null;
      merged = st?.merged ?? false;
      mergeTarget = st?.baseBranch || null;
      squashCommitSha = st?.squashCommitSha ?? null;
      squashMergeSha = st?.squashMergeSha;
      squashSkipReason = st?.squashSkipReason;
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

    // Never remove a directory another live task is working in. Tasks handed the same
    // branch name before 01-worktree-setup guarded against it share ONE worktree, so this
    // task finishing would delete the other's tree mid-run. Not an error: the merge (if
    // any) is already durable, and the sharer removes the worktree when it finishes.
    const sharer = await findWorktreePathClaimant(ctx.db, {
      worktreePath: d.worktreePath,
      taskId: ctx.taskId,
    });
    if (sharer) {
      ctx.logger.warn(
        { worktreePath: d.worktreePath, sharerTaskId: sharer.id, sharerStatus: sharer.status },
        'worktree is shared with another live task; left in place',
      );
      return {
        action,
        removed: false,
        merged,
        branchDeleted: false,
        mode: 'worktree',
        message: `${merged ? `merged ${d.branchName} into ${mergeTarget}; ` : ''}worktree kept: task "${sharer.title}" (${sharer.id}, ${sharer.status}) is still working in ${d.worktreePath}.`,
      };
    }

    // The merge carried commits only, and removing the directory deletes the rest. Read the tree
    // again here rather than trust detect: work can land between the form and this pass.
    if (values.discardUncommitted !== true) {
      const held = await readUncommittedChanges(d.worktreePath, MAX_LISTED_UNCOMMITTED);
      if (held === null || held.count > 0) {
        ctx.logger.warn(
          { worktreePath: d.worktreePath, uncommitted: held?.count ?? null },
          'worktree kept: it holds uncommitted changes or git could not read it',
        );
        return {
          action,
          removed: false,
          merged,
          branchDeleted: false,
          mode: 'worktree',
          message: `${merged ? `merged ${d.branchName} into ${mergeTarget}; ` : ''}worktree kept at ${d.worktreePath}: ${held === null ? 'it could not be checked for uncommitted changes' : `removing it would delete ${describeChanges(held.count)}`}.`,
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

    // The live feature ref can include work added AFTER the squash. Use the recorded
    // feature parent for both DAG and feature deletion, never the moved live ref.
    const featureParent =
      squashCommitSha && squashMergeSha
        ? await gitRun(ctx.repoPath, [
            'rev-parse',
            '-q',
            '--verify',
            `${squashMergeSha}^2^{commit}`,
          ])
        : null;
    const mergedFeature = featureParent?.code === 0 ? featureParent.stdout.trim() : null;
    const branchLeftovers: BranchLeftover[] = [];
    const branchTips: Record<string, string | null> = Object.create(null);
    const deleteBranch = async (branch: string): Promise<boolean> => {
      if (squashCommitSha) {
        const { reason, tip } = await deleteSquashedBranch(ctx.repoPath, branch, mergedFeature);
        if (reason) {
          branchLeftovers.push({ branch, reason });
          branchTips[branch] = tip;
        }
        return reason === null;
      }
      const del = await gitRun(ctx.repoPath, ['branch', '-d', branch]);
      if (del.code !== 0)
        ctx.logger.warn({ branch, stderr: del.stderr }, 'safe branch delete failed; left in place');
      return del.code === 0;
    };
    let issueBranchesDeleted = 0;
    if (action === 'merge_remove' && merged && values.deleteBranch && d.branchName) {
      const issuePrefix = `${d.branchName}--`;
      const listed = await gitRun(ctx.repoPath, [
        'branch',
        '--list',
        '--format=%(refname:lstrip=2)',
        ...(squashCommitSha ? [] : ['--merged', `refs/heads/${d.branchName}`]),
        `${issuePrefix}*`,
      ]);
      const issueBranches =
        listed.code === 0
          ? listed.stdout
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
          : [];
      for (const branch of issueBranches) {
        if (await deleteBranch(branch)) issueBranchesDeleted += 1;
      }
    }

    // remove_only never deletes the branch; it is the work's remaining recovery path.
    let branchDeleted = false;
    if (action === 'merge_remove' && values.deleteBranch && d.branchName) {
      branchDeleted = await deleteBranch(d.branchName);
    }
    if (branchLeftovers.length) {
      ctx.logger.warn({ branches: branchLeftovers }, 'branch leftovers kept after squash');
      const prior = await ctx.db.query.taskEvents.findMany({
        where: and(
          eq(schema.taskEvents.taskId, ctx.taskId),
          eq(schema.taskEvents.eventType, 'worktree.branch_leftovers'),
        ),
        columns: { payload: true },
      });
      const seen = new Set<string>();
      for (const { payload } of prior) {
        const p = payload as {
          branches?: BranchLeftover[];
          tips?: Record<string, string | null>;
        } | null;
        if (!Array.isArray(p?.branches) || !p.tips) continue;
        for (const { branch } of p.branches) {
          if (Object.hasOwn(p.tips, branch)) seen.add(JSON.stringify([branch, p.tips[branch]]));
        }
      }
      const fresh = branchLeftovers.filter(
        ({ branch }) => !seen.has(JSON.stringify([branch, branchTips[branch]])),
      );
      if (fresh.length) {
        await ctx.db.insert(schema.taskEvents).values({
          taskId: ctx.taskId,
          eventType: 'worktree.branch_leftovers',
          payload: {
            branches: fresh,
            tips: Object.fromEntries(fresh.map(({ branch }) => [branch, branchTips[branch]])),
            squashCommitSha,
            squashMergeSha: squashMergeSha ?? null,
          },
        });
      }
      await warnStep(
        ctx,
        branchLeftovers.map(({ branch, reason }) => branchLeftoverMessage(branch, reason)),
      );
    }

    const parts: string[] = [];
    if (merged)
      parts.push(
        squashCommitSha
          ? `merged ${d.branchName} into ${mergeTarget} as one squashed commit ${squashCommitSha.slice(0, 7)}`
          : `merged ${d.branchName} into ${mergeTarget}`,
      );
    if (squashSkipReason) parts.push(squashSkipReason);
    for (const { branch, reason } of branchLeftovers) {
      if (branch !== d.branchName) parts.push(branchLeftoverMessage(branch, reason));
    }
    parts.push(`removed worktree ${d.worktreePath}`);
    parts.push(
      ...branchOutcomeParts({
        action,
        branchName: d.branchName,
        deleteRequested: !!values.deleteBranch,
        branchDeleted,
        issueBranchesDeleted,
        branchLeftoverReason: branchLeftovers.find(({ branch }) => branch === d.branchName)?.reason,
      }),
    );

    ctx.logger.info({ action, merged, branchDeleted }, 'worktree cleanup complete');
    return {
      action,
      removed: true,
      merged,
      branchDeleted,
      mode: 'worktree',
      ...(branchLeftovers.length ? { branchLeftovers } : {}),
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
    columns: { prUrl: true, repositoryId: true },
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

  // Local base leads: a record it holds ahead of origin is in the branch's history, and origin's would undo it.
  const target = [baseBranch, `origin/${baseBranch}`, ...(d.baseBranch ? [d.baseBranch] : [])];
  await warnStep(
    ctx,
    await putBackProjections({ ctx, worktree: d.worktreePath, branch: d.branchName, target }),
  );

  const repositoryId = existing?.repositoryId ?? null;
  await prepareProjectStatePush(ctx.db, {
    repositoryId,
    sourcePath: ctx.repoPath,
    taskId: ctx.taskId,
  });
  const identity = await projectionPushIdentity(ctx.db, ctx.userId, repositoryId);
  await ctx.db.transaction((tx) =>
    commitProjectStatePush(tx, {
      repositoryId,
      sourcePath: ctx.repoPath,
      targetPath: d.worktreePath!,
      identity,
      taskId: ctx.taskId,
    }),
  );

  let provider: string;
  let result: OpenPrResult;
  try {
    const forgeCtx = await resolveForgeContext({
      db: ctx.db,
      userId: ctx.userId,
      credentialId,
      remoteUrl: d.originUrl,
    });
    // Make sure the feature branch is on origin. It was pushed at 11a-gate-4-push, but
    // fix loops after that push can add commits. Host-side; git works here (the sandbox
    // git ban is cli-exec only).
    await pushBranch({
      cwd: ctx.repoPath,
      branch: d.branchName,
      setUpstream: true,
      credentialId,
      remoteUrl: (await taskRemoteUrl(ctx)) ?? d.originUrl,
      db: ctx.db,
      userId: ctx.userId,
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
      prRemoteUrl: gitRemoteIdentity(d.originUrl),
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
