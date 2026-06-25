import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { FormField, FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { pathExists } from '../onboarding/_helpers.js';
import {
  buildCredentialHelper,
  detectOrigin,
  gitRun,
  scrubSecret,
} from '../../../repo/git-push.js';
import { buildMergeFixPrompt } from '../../git-merge.js';

// Pre-branch base sync. Runs after the model-health canary and before triage (the
// explicit pull in orderWorkflowRunList places it there). Brings the LOCAL base
// branch up to date with origin so 01-worktree-setup cuts the feature branch from
// the fresh tip AND 12-worktree-cleanup's later base push is a fast-forward — neither
// step fetches, so without this the branch starts stale and the cleanup push is
// non-ff-rejected. Fast-forward when possible; an LLM-assisted merge (reusing
// resolveMergePhase) only on real divergence. Fetch failures warn-and-continue with
// the stale base — a flaky connection must never block a task.

interface SyncBaseDetect {
  hasGit: boolean;
  /** The parent checkout's current branch — the default base to freshen and the
   *  branch 01 will cut from. Null when detached / unresolved. */
  currentBranch: string | null;
  hasOrigin: boolean;
  fetchOk: boolean;
  fetchError: string | null;
  /** Local base behind / ahead of origin/<base> (0 when not fetched). */
  behindBy: number;
  aheadBy: number;
  diverged: boolean;
  // --- fields resolveMergePhase reads to merge origin/<base> INTO <base> ---
  /** The ref merged into the base (merge-resolver's "feature" side): `origin/<base>`. */
  branchName: string | null;
  /** Local branch the merge lands on. */
  baseBranch: string | null;
  /** Parent checkout's branch; equal to baseBranch here → same-branch merge at repoPath. */
  parentBranch: string | null;
}

interface SyncBaseApply {
  synced: boolean;
  base: string | null;
  strategy: 'ff' | 'merge' | 'noop' | 'skipped';
  behindBy: number;
  reason: string | null;
}

/** Best-effort `git fetch origin <base>` with the repo's bound credential. Never
 *  throws — a failure is surfaced (warn & continue), not fatal. */
async function fetchOrigin(
  ctx: StepContext,
  base: string,
  credentialId: string | null,
): Promise<{ ok: boolean; error: string | null }> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
  const argv: string[] = [];
  let secret: string | null = null;
  if (credentialId) {
    try {
      const helper = await buildCredentialHelper(ctx.db, credentialId, ctx.userId);
      secret = helper.secret;
      Object.assign(env, helper.env);
      argv.push(...helper.argv);
    } catch (err) {
      return { ok: false, error: `credential load failed: ${(err as Error).message}` };
    }
  }
  argv.push('fetch', 'origin', base);
  const res = await gitRun(ctx.repoPath, argv, env);
  if (res.code !== 0) {
    return {
      ok: false,
      error: scrubSecret(res.stderr || res.stdout, secret)
        .trim()
        .slice(0, 500),
    };
  }
  return { ok: true, error: null };
}

async function countCommits(repoPath: string, range: string): Promise<number> {
  const res = await gitRun(repoPath, ['rev-list', '--count', range]);
  if (res.code !== 0) return 0;
  const n = Number.parseInt(res.stdout.trim() || '0', 10);
  return Number.isFinite(n) ? n : 0;
}

export const syncBaseStep: StepDefinition<SyncBaseDetect, SyncBaseApply> = {
  metadata: {
    id: '00a-sync-base',
    workflowType: 'workflow',
    index: 0.2,
    title: 'Sync base with origin',
    description:
      'Brings the base branch up to date with origin before the feature worktree is created, so work starts from the latest code. Fast-forwards when possible; an unreachable origin warns and continues with the local branch.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<SyncBaseDetect> {
    const empty: SyncBaseDetect = {
      hasGit: false,
      currentBranch: null,
      hasOrigin: false,
      fetchOk: false,
      fetchError: null,
      behindBy: 0,
      aheadBy: 0,
      diverged: false,
      branchName: null,
      baseBranch: null,
      parentBranch: null,
    };

    const hasGit = await pathExists(path.join(ctx.repoPath, '.git'));
    if (!hasGit) return empty;

    const cur = await gitRun(ctx.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const currentBranch = cur.code === 0 ? cur.stdout.trim() : null;
    // Detached HEAD ('HEAD') has no branch to freshen — skip the sync, let 01 cope.
    const base = currentBranch && currentBranch !== 'HEAD' ? currentBranch : null;

    const baseFields = {
      hasGit: true,
      currentBranch,
      branchName: base ? `origin/${base}` : null,
      baseBranch: base,
      parentBranch: currentBranch,
    };

    const hasOrigin = await detectOrigin(ctx.repoPath);
    if (!hasOrigin || !base) {
      return { ...empty, ...baseFields, hasOrigin };
    }

    // Bound credential for a private origin (same lookup 12-worktree-cleanup uses).
    const task = await ctx.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, ctx.taskId),
      columns: { repositoryId: true },
    });
    const repo = task?.repositoryId
      ? await ctx.db.query.repositories.findFirst({
          where: eq(schema.repositories.id, task.repositoryId),
          columns: { credentialsSecretId: true },
        })
      : null;

    const fetch = await fetchOrigin(ctx, base, repo?.credentialsSecretId ?? null);
    if (!fetch.ok) {
      return { ...empty, ...baseFields, hasOrigin: true, fetchOk: false, fetchError: fetch.error };
    }
    const behindBy = await countCommits(ctx.repoPath, `${base}..origin/${base}`);
    const aheadBy = await countCommits(ctx.repoPath, `origin/${base}..${base}`);
    return {
      ...empty,
      ...baseFields,
      hasOrigin: true,
      fetchOk: true,
      behindBy,
      aheadBy,
      diverged: behindBy > 0 && aheadBy > 0,
    };
  },

  form(_ctx, detected): FormSchema {
    if (!detected.hasGit || !detected.baseBranch) {
      // No git, or detached HEAD — nothing to sync; 01 handles init / cope.
      return {
        title: 'Sync base with origin',
        description: 'No git branch to sync; continuing.',
        fields: [],
        submitLabel: 'Continue',
        autoSubmit: true,
      };
    }

    const base = detected.baseBranch;
    const fields: FormField[] = [];

    if (!detected.hasOrigin) {
      fields.push({
        type: 'note',
        id: 'noOrigin',
        label: 'No remote',
        body: `No \`origin\` remote — using the local **${base}** as-is.`,
        variant: 'info',
      });
    } else if (!detected.fetchOk) {
      fields.push({
        type: 'note',
        id: 'fetchFailed',
        label: 'Could not reach origin',
        body: `Couldn't fetch origin: ${detected.fetchError ?? 'unknown error'}. Continuing with the local **${base}** (possibly stale). Fix connectivity or credentials and Retry this step to re-sync.`,
        variant: 'warning',
      });
    } else if (detected.diverged) {
      fields.push({
        type: 'note',
        id: 'diverged',
        label: 'Base diverged from origin',
        body: `**${base}** has diverged from origin (${detected.behindBy} behind / ${detected.aheadBy} ahead). Haive can merge \`origin/${base}\` into **${base}** with AI assistance, or you can skip and use the local branch as-is.`,
        variant: 'warning',
      });
    } else if (detected.behindBy > 0) {
      fields.push({
        type: 'note',
        id: 'behind',
        label: 'Base is behind origin',
        body: `**${base}** is ${detected.behindBy} commit(s) behind origin — it will be fast-forwarded to the latest before the feature worktree is created.`,
        variant: 'info',
      });
    } else {
      fields.push({
        type: 'note',
        id: 'uptodate',
        label: 'Up to date',
        body: `**${base}** is up to date with origin.`,
        variant: 'info',
      });
    }

    fields.push({
      type: 'text',
      id: 'base',
      label: 'Base branch to start work from',
      default: base,
      required: true,
      description:
        'The feature branch (next step) is cut from this branch after it is freshened from origin.',
    });

    // Divergence is the only real decision: merge origin in (AI-assisted) or skip.
    // selectedMerge reads syncAction, so this field is what drives the merge phase.
    if (detected.fetchOk && detected.diverged) {
      fields.push({
        type: 'radio',
        id: 'syncAction',
        label: 'How should the divergence be handled?',
        default: 'merge',
        required: true,
        options: [
          { value: 'merge', label: `Merge origin/${base} into ${base} (AI-assisted)` },
          { value: 'skip', label: 'Skip — use the local branch as-is' },
        ],
      });
    }

    // The only real decisions are a divergence (merge vs skip) or a failed fetch the
    // user should see; everything else (clean fast-forward, up to date, no origin) has
    // nothing to weigh, so auto-submit it — posting the base default — to keep a clean
    // sync hands-free. autoContinue still auto-answers the gated cases when it is on.
    const autoSubmit = !(detected.hasOrigin && (detected.diverged || !detected.fetchOk));
    return {
      title: 'Sync base with origin',
      description:
        'Bring the base branch up to date with origin before creating the feature worktree.',
      fields,
      submitLabel: 'Continue',
      ...(autoSubmit ? { autoSubmit: true } : {}),
    };
  },

  // Divergence → LLM-assisted merge of origin/<base> into <base>, reusing the generic
  // resolveMergePhase (runs after the form, before apply). It reads detectOutput's
  // branchName/baseBranch/parentBranch: branchName=origin/<base> is the merged-in side,
  // base==parent → same-branch merge at ctx.repoPath. No push (pushBase is unset).
  mergeResolve: {
    requiredCapabilities: ['tool_use', 'file_write'],
    selectedMerge: (formValues) => formValues.syncAction === 'merge',
    buildFixPrompt: ({ featureBranch, guidance }) =>
      buildMergeFixPrompt(featureBranch, undefined, guidance),
    buildClarificationForm: ({ baseBranch, featureBranch, uncertainty }) => ({
      title: 'Sync conflict — your input needed',
      description: `The AI is unsure how to merge ${featureBranch} into ${baseBranch}.`,
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
          placeholder: 'e.g. keep origin for file X; keep both changes; prefer the local side…',
          required: true,
        },
      ],
      submitLabel: 'Send guidance',
      submitAction: 'clarify',
    }),
  },

  async apply(ctx, args): Promise<SyncBaseApply> {
    const d = args.detected;
    const values = args.formValues as { base?: string; syncAction?: string };

    if (!d.hasGit || !d.baseBranch) {
      return {
        synced: false,
        base: null,
        strategy: 'skipped',
        behindBy: 0,
        reason: 'no git branch',
      };
    }
    const base = values.base?.trim() || d.baseBranch;

    if (!d.hasOrigin) {
      return { synced: false, base, strategy: 'skipped', behindBy: 0, reason: 'no origin remote' };
    }
    if (!d.fetchOk) {
      return {
        synced: false,
        base,
        strategy: 'skipped',
        behindBy: 0,
        reason: `fetch failed: ${d.fetchError ?? 'unknown'}`,
      };
    }

    // Divergence was analyzed for the default base (d.baseBranch). When the user kept
    // it, the merge phase already merged origin in (syncAction=merge) or they skipped.
    if (base === d.baseBranch && d.diverged) {
      return values.syncAction === 'merge'
        ? { synced: true, base, strategy: 'merge', behindBy: d.behindBy, reason: null }
        : {
            synced: false,
            base,
            strategy: 'skipped',
            behindBy: d.behindBy,
            reason: 'diverged; user chose to keep the local branch',
          };
    }

    if (base === d.baseBranch && d.behindBy === 0) {
      return { synced: true, base, strategy: 'noop', behindBy: 0, reason: null };
    }

    // Fast-forward the base to origin. base===current → merge at repoPath (parent is on
    // base); a non-default base → update its ref directly without a checkout. A shallow
    // clone may need one bounded deepen first; never --unshallow (a full pull can be huge).
    const onCurrent = base === d.currentBranch;
    const ff = (): Promise<{ code: number; stderr: string; stdout: string }> =>
      onCurrent
        ? gitRun(ctx.repoPath, ['merge', '--ff-only', `origin/${base}`])
        : gitRun(ctx.repoPath, ['fetch', 'origin', `${base}:refs/heads/${base}`]);

    let res = await ff();
    if (res.code !== 0) {
      await gitRun(ctx.repoPath, ['fetch', '--deepen=50', 'origin', base]);
      res = await ff();
    }
    if (res.code !== 0) {
      ctx.logger.warn(
        { base, stderr: res.stderr },
        'sync base: fast-forward failed; continuing with local base',
      );
      return {
        synced: false,
        base,
        strategy: 'skipped',
        behindBy: d.behindBy,
        reason: `fast-forward failed: ${res.stderr || res.stdout}`,
      };
    }
    return { synced: true, base, strategy: 'ff', behindBy: d.behindBy, reason: null };
  },
};
