import { eq } from 'drizzle-orm';
import { lockRepositoryTasksKey, schema } from '@haive/database';
import type { FormField, FormSchema } from '@haive/shared';
import { isBranchName } from '@haive/shared/git-args';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import {
  originGitRun,
  buildCredentialHelper,
  detectOrigin,
  gitRun,
  scrubSecret,
  OriginUrlError,
} from '../../../repo/git-push.js';
import { gitGaveNoAnswer } from '../../../repo/git-exec.js';
import { buildMergeFixPrompt, handBackAfterMove } from '../../git-merge.js';
import { requireUsableGit } from '../../../repo/git-workspace.js';
import { seedPlanBaseFromCheckout } from '../../../plan/mirror.js';
import { headCommit } from '../../../plan/merge.js';
import { checkoutHoldingTasks } from '../../../repo/refresh.js';
import {
  claimMergeDir,
  inMergeDirUnlessClaimed,
  otherLiveClaim,
  releaseMergeDir,
  withMergeDirSection,
  type DbHandle,
} from '../../merge-dir-claim.js';
import {
  MOVE_ATTEMPTS,
  putBackAfterFailure,
  putBackProjections,
  recoverAfterMoveFailure,
  restoreKeptMetadata,
  restoreProjectionsInTx,
  resyncHaiveProjections,
  setAsideHaiveProjections,
  type KeptFiles,
  type RestoreSection,
  type SetAsideResult,
} from '../../../project-state/set-aside.js';

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
  /** Set when the fetch worked but the local base could not be compared with origin/<base>, the counts then being 0 and meaning nothing. */
  compareError: string | null;
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

/** Best-effort `git fetch origin <base>` with the repo's bound credential. Network
 *  failures and refused origins warn-and-continue. */
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
  argv.push('fetch', '--end-of-options', 'origin', `refs/heads/${base}`);
  let res;
  try {
    res = await originGitRun(ctx.repoPath, argv, env);
  } catch (err) {
    if (!(err instanceof OriginUrlError)) throw err;
    ctx.logger.warn({ err: err.message }, 'base sync skipped: origin refused');
    return { ok: false, error: err.message };
  }
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

async function countCommits(
  repoPath: string,
  range: string,
): Promise<{ count: number; error: string | null }> {
  const res = await gitRun(repoPath, ['rev-list', '--count', range]);
  const count = Number.parseInt(res.stdout.trim(), 10);
  if (res.code === 0 && Number.isFinite(count)) return { count, error: null };
  return {
    count: 0,
    error: (res.stderr || res.stdout).trim().slice(0, 500) || `git exited ${res.code}`,
  };
}

async function taskRepositoryId(ctx: StepContext): Promise<string | null> {
  const task = await ctx.db.query.tasks.findFirst({
    where: eq(schema.tasks.id, ctx.taskId),
    columns: { repositoryId: true },
  });
  return task?.repositoryId ?? null;
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
      compareError: null,
      behindBy: 0,
      aheadBy: 0,
      diverged: false,
      branchName: null,
      baseBranch: null,
      parentBranch: null,
    };

    // Throws on a corrupt repo: skipping the base sync silently would branch the
    // feature worktree off a stale base.
    if (!(await requireUsableGit(ctx.repoPath))) return empty;

    const cur = await gitRun(ctx.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (gitGaveNoAnswer(cur))
      throw new Error(
        `could not read the checkout's current branch: ${(cur.stderr || cur.stdout).trim()}`,
      );
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

    let hasOrigin: boolean;
    try {
      hasOrigin = await detectOrigin(ctx.repoPath);
    } catch (err) {
      if (!(err instanceof OriginUrlError)) throw err;
      ctx.logger.warn({ err: err.message }, 'base sync skipped: origin refused');
      return { ...empty, ...baseFields, hasOrigin: true, fetchError: err.message };
    }
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
    const behind = await countCommits(ctx.repoPath, `${base}..origin/${base}`);
    const ahead = await countCommits(ctx.repoPath, `origin/${base}..${base}`);
    const compareError = behind.error ?? ahead.error;
    if (compareError !== null) {
      return { ...empty, ...baseFields, hasOrigin: true, fetchOk: true, compareError };
    }
    return {
      ...empty,
      ...baseFields,
      hasOrigin: true,
      fetchOk: true,
      behindBy: behind.count,
      aheadBy: ahead.count,
      diverged: behind.count > 0 && ahead.count > 0,
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
    } else if (detected.compareError) {
      fields.push({
        type: 'note',
        id: 'compareFailed',
        label: 'Could not compare with origin',
        body: `Couldn't compare **${base}** with \`origin/${base}\`: ${detected.compareError}. Continuing with the local **${base}** (possibly stale). Retry this step to re-sync.`,
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
    const autoSubmit = !(
      detected.hasOrigin &&
      (detected.diverged || !detected.fetchOk || Boolean(detected.compareError))
    );
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
      buildMergeFixPrompt(featureBranch, undefined, guidance, true),
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
    if (!isBranchName(base)) {
      throw new Error(`${JSON.stringify(base)} is not a branch name git accepts`);
    }

    // A claim this step left when its release failed would hold every other task out of the checkout.
    if (await taskRepositoryId(ctx)) {
      await releaseMergeDir(ctx.db, { mergeDir: ctx.repoPath, stepId: ctx.taskStepId });
    }

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

    if (base === d.baseBranch && d.compareError) {
      return {
        synced: false,
        base,
        strategy: 'skipped',
        behindBy: 0,
        reason: `could not compare ${base} with origin/${base}: ${d.compareError}`,
      };
    }

    // Divergence was analyzed for the default base (d.baseBranch). When the user kept
    // it, the merge phase already merged origin in (syncAction=merge) or they skipped.
    if (base === d.baseBranch && d.diverged) {
      if (values.syncAction === 'merge') {
        const repositoryId = await taskRepositoryId(ctx);
        if (repositoryId) await resyncHaiveProjections(ctx.db, repositoryId, ctx.repoPath);
      }
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
      if (base === d.currentBranch) {
        const repositoryId = await taskRepositoryId(ctx);
        if (repositoryId) await resyncHaiveProjections(ctx.db, repositoryId, ctx.repoPath);
      }
      return { synced: true, base, strategy: 'noop', behindBy: 0, reason: null };
    }

    // Fast-forward the base to origin. base===current → merge at repoPath (parent is on
    // base); a non-default base → update its ref directly without a checkout. A shallow
    // clone may need one bounded deepen first; never --unshallow (a full pull can be huge).
    const onCurrent = base === d.currentBranch;
    const ff = (): Promise<{ code: number; stderr: string; stdout: string }> =>
      onCurrent
        ? gitRun(ctx.repoPath, ['merge', '--ff-only', `origin/${base}`])
        : originGitRun(ctx.repoPath, [
            'fetch',
            '--end-of-options',
            'origin',
            `refs/heads/${base}:refs/heads/${base}`,
          ]);

    const repositoryId = onCurrent ? await taskRepositoryId(ctx) : null;
    // Another task working in the checkout itself (no worktree of its own) holds the base where it is.
    const fence = async (conn: Parameters<typeof checkoutHoldingTasks>[0]) =>
      (await checkoutHoldingTasks(conn, repositoryId!, {
        excludeTaskId: ctx.taskId,
        rootOnly: true,
      })) + ((await otherLiveClaim(conn as DbHandle, ctx.repoPath, ctx.taskId)) ? 1 : 0);
    let asided = false;
    const kept: KeptFiles = new Map();
    const owner = {
      mergeDir: ctx.repoPath,
      stepId: ctx.taskStepId,
      taskId: ctx.taskId,
      epoch: ctx.epoch,
    };
    const putBackSection: RestoreSection = (fn) => inMergeDirUnlessClaimed(ctx.db, owner, fn);
    const setAside = async (): Promise<SetAsideResult> => {
      if (!repositoryId) return { outcome: 'clean' };
      let aside: SetAsideResult;
      try {
        aside = await setAsideHaiveProjections(ctx.db, repositoryId, ctx.repoPath, fence, {
          restore: (fn) => withMergeDirSection(ctx.db, owner, fn),
          putBack: putBackSection,
        });
      } catch (err) {
        if (asided)
          await putBackAfterFailure(ctx.db, repositoryId, ctx.repoPath, kept, err, putBackSection);
        throw err;
      }
      if (aside.outcome === 'set-aside') {
        asided = true;
        for (const [file, was] of aside.kept) if (!kept.has(file)) kept.set(file, was);
      }
      return aside;
    };
    if (repositoryId) {
      try {
        await seedPlanBaseFromCheckout(ctx.db, repositoryId, ctx.repoPath);
      } catch (err) {
        return {
          synced: false,
          base,
          strategy: 'skipped',
          behindBy: d.behindBy,
          reason: `the plan's base could not be read from the checkout (${(err as Error).message}); the base was not moved. Retry this step.`,
        };
      }
    }
    const moveBase = async (): Promise<SyncBaseApply> => {
      const before = await headCommit(ctx.repoPath);
      const first = await setAside();
      if (first.outcome === 'held') {
        return {
          synced: false,
          base,
          strategy: 'skipped',
          behindBy: d.behindBy,
          reason: `${first.holding} other task${first.holding === 1 ? ' is' : 's are'} working in this checkout; the base was not moved. Retry this step once ${first.holding === 1 ? 'it finishes' : 'they finish'}.`,
        };
      }
      if (first.outcome === 'refused') {
        return {
          synced: false,
          base,
          strategy: 'skipped',
          behindBy: d.behindBy,
          reason: `${first.reason}; the base was not moved. Commit or discard that change, then Retry this step.`,
        };
      }

      // Under both projection locks, so no sweep can rewrite a file between the check and the move. A
      // file found rewritten ends the transaction unmoved and goes back to the set-aside.
      const ffLocked = async (): Promise<{
        code: number;
        stderr: string;
        stdout: string;
        unmoved?: true;
      }> => {
        if (!repositoryId) return ff();
        for (let attempt = 1; ; attempt++) {
          // A claimed section: no merge in this checkout interleaves, and a cancelled pass is refused.
          const moved = await withMergeDirSection(ctx.db, owner, async (tx) => {
            // Every task's start and every revival take this lock, so none lands between the fence and the move.
            await lockRepositoryTasksKey(tx, repositoryId);
            const again = await restoreProjectionsInTx(tx, repositoryId, ctx.repoPath);
            if (again.outcome !== 'clean') return { again, res: null, holding: 0 };
            const holding = await fence(tx);
            return holding > 0
              ? { again, res: null, holding }
              : { again, res: await ff(), holding };
          });
          if (moved.res) return moved.res;
          if (moved.holding > 0) {
            return {
              code: 1,
              stderr: `${moved.holding} other task${moved.holding === 1 ? ' is' : 's are'} working in this checkout`,
              stdout: '',
              unmoved: true,
            };
          }
          if (moved.again.outcome === 'refused') {
            return { code: 1, stderr: moved.again.reason, stdout: '', unmoved: true };
          }
          if (attempt === MOVE_ATTEMPTS) {
            return {
              code: 1,
              stderr: "Haive's project files kept changing under the move; Retry this step",
              stdout: '',
              unmoved: true,
            };
          }
          const again = await setAside();
          if (again.outcome === 'held') {
            return {
              code: 1,
              stderr: `${again.holding} other task${again.holding === 1 ? ' is' : 's are'} working in this checkout`,
              stdout: '',
              unmoved: true,
            };
          }
          if (again.outcome === 'refused') {
            return { code: 1, stderr: again.reason, stdout: '', unmoved: true };
          }
        }
      };

      let res: Awaited<ReturnType<typeof ffLocked>>;
      try {
        res = await ffLocked();
        if (res.code !== 0 && !res.unmoved) {
          // The deepen is a network fetch: Haive's files go back first, and the retry sets them aside again.
          if (repositoryId && asided) {
            await putBackProjections(ctx.db, repositoryId, ctx.repoPath, kept, putBackSection);
            kept.clear();
            asided = false;
          }
          await originGitRun(ctx.repoPath, [
            'fetch',
            '--deepen=50',
            '--end-of-options',
            'origin',
            `refs/heads/${base}`,
          ]);
          res = await ffLocked();
        }
      } catch (err) {
        if (repositoryId && asided) {
          try {
            await recoverAfterMoveFailure(
              ctx.db,
              repositoryId,
              ctx.repoPath,
              kept,
              before,
              err,
              putBackSection,
            );
          } catch (recovered) {
            if (recovered !== err || !(err instanceof OriginUrlError)) throw recovered;
          }
        }
        if (err instanceof OriginUrlError) {
          ctx.logger.warn({ err: err.message }, 'base sync skipped: origin refused');
          return { synced: false, base, strategy: 'skipped', behindBy: 0, reason: err.message };
        }
        throw err;
      }
      if (onCurrent && res.code === 0) await handBackAfterMove(ctx.repoPath, before);
      if (repositoryId && res.code === 0) {
        await resyncHaiveProjections(ctx.db, repositoryId, ctx.repoPath);
        await restoreKeptMetadata(ctx.repoPath, kept);
      } else if (repositoryId && asided) {
        await putBackProjections(ctx.db, repositoryId, ctx.repoPath, kept, putBackSection);
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
    };
    if (!repositoryId) return moveBase();
    // The set-aside and the move write the checkout, so they hold its merge-dir claim as a merge does.
    const claim = await claimMergeDir(ctx.db, owner);
    if (claim.kind === 'held') {
      return {
        synced: false,
        base,
        strategy: 'skipped',
        behindBy: d.behindBy,
        reason: `Task "${claim.holder.title}" (${claim.holder.id}) is merging in this checkout; the base was not moved. Retry this step once it finishes.`,
      };
    }
    let out: SyncBaseApply;
    try {
      out = await moveBase();
    } catch (err) {
      await releaseMergeDir(ctx.db, owner).catch(() => undefined);
      throw err;
    }
    // A claim left behind would hold every other task out of this checkout, so its release must land.
    await releaseMergeDir(ctx.db, owner);
    return out;
  },
};
