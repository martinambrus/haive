import { eq } from 'drizzle-orm';
import { schema, type MergeResolveState } from '@haive/database';
import type { FormField, FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import {
  buildCredentialHelper,
  detectOrigin,
  getOriginUrl,
  gitRun,
  scrubSecret,
} from '../../../repo/git-push.js';
import { buildMergeFixPrompt } from '../../git-merge.js';
import { loadPreviousStepOutput } from './_helpers.js';

// 12-post-onboarding commits the generated files on the current branch. This step
// optionally pushes that branch to origin with the SAME pull/merge/AI-conflict machinery
// the task-close step uses, by reusing resolveMergePhase: the merge-resolver's "feature"
// side is origin/<branch> (the incoming remote work) merged INTO <branch>, then the
// integrated branch is pushed (pushAfterMerge). Runs only when step 12 recorded
// pushRequested; the push credential/upstream were chosen on step 12's form and are
// echoed here so the auto-submitted form can hand them to resolveMergePhase.

/** The subset of 12-post-onboarding's output this step consumes. */
interface PostOnboardingPushHandoff {
  pushRequested?: boolean;
  pushCredentialId?: string | null;
  pushSetUpstream?: boolean;
  branch?: string | null;
}

interface OnboardingPushDetect {
  /** True once there is a branch + origin to push to. */
  ready: boolean;
  currentBranch: string | null;
  hasOrigin: boolean;
  originUrl: string | null;
  fetchOk: boolean;
  fetchError: string | null;
  /** Local base behind / ahead of origin/<base> (0 when the ref is absent / not fetched). */
  behindBy: number;
  aheadBy: number;
  // --- fields resolveMergePhase reads to merge <branchName> INTO <baseBranch> ---
  /** The ref merged in (merge-resolver's "feature" side): origin/<base> when that
   *  remote-tracking ref exists, else <base> itself (a self-merge no-op so the phase
   *  still proceeds to push a branch that is not yet on origin). */
  branchName: string | null;
  /** Local branch the merge lands on and that gets pushed. */
  baseBranch: string | null;
  /** Parent checkout's branch; equals baseBranch here -> same-branch merge at repoPath. */
  parentBranch: string | null;
  // --- push choices echoed from step 12 (form defaults) ---
  credentialId: string;
  setUpstream: boolean;
}

interface OnboardingPushApply {
  pushed: boolean;
  merged: boolean;
  branch: string | null;
  message: string;
}

/** Best-effort `git fetch origin <base>` with the step-12 credential. Never throws -
 *  a failure is surfaced (warn & continue), not fatal (mirrors 00a-sync-base). */
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

async function loadHandoff(ctx: StepContext): Promise<PostOnboardingPushHandoff> {
  const prev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '12-post-onboarding');
  return (prev?.output ?? {}) as PostOnboardingPushHandoff;
}

export const onboardingPushStep: StepDefinition<OnboardingPushDetect, OnboardingPushApply> = {
  metadata: {
    id: '13-onboarding-push',
    workflowType: 'onboarding',
    index: 17,
    title: 'Push onboarding to origin',
    description:
      'Pushes the committed onboarding files to origin, first merging any newer origin commits into the branch (AI-assisted on conflict).',
    requiresCli: false,
  },

  // Only when 12-post-onboarding committed AND the user ticked "push to origin".
  async shouldRun(ctx): Promise<boolean> {
    const handoff = await loadHandoff(ctx);
    return handoff.pushRequested === true;
  },

  async detect(ctx): Promise<OnboardingPushDetect> {
    const handoff = await loadHandoff(ctx);
    const credentialId =
      typeof handoff.pushCredentialId === 'string' ? handoff.pushCredentialId : '';
    const setUpstream = handoff.pushSetUpstream !== false;

    const empty: OnboardingPushDetect = {
      ready: false,
      currentBranch: null,
      hasOrigin: false,
      originUrl: null,
      fetchOk: false,
      fetchError: null,
      behindBy: 0,
      aheadBy: 0,
      branchName: null,
      baseBranch: null,
      parentBranch: null,
      credentialId,
      setUpstream,
    };

    const cur = await gitRun(ctx.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const currentBranch = cur.code === 0 ? cur.stdout.trim() : null;
    const base = currentBranch && currentBranch !== 'HEAD' ? currentBranch : null;
    const hasOrigin = await detectOrigin(ctx.repoPath);
    const originUrl = hasOrigin ? await getOriginUrl(ctx.repoPath) : null;
    if (!base || !hasOrigin) {
      return { ...empty, currentBranch, hasOrigin, originUrl };
    }

    const fetch = await fetchOrigin(ctx, base, credentialId || null);
    // origin/<base> may exist (from the clone / this fetch) or not (a branch never
    // pushed). When present we merge it in (the pull); when absent we self-merge <base>
    // (a no-op) so resolveMergePhase still proceeds to push and CREATE the branch.
    const originRef = `origin/${base}`;
    const originRefExists =
      (await gitRun(ctx.repoPath, ['rev-parse', '--verify', '--quiet', originRef])).code === 0;
    const branchName = originRefExists ? originRef : base;
    const behindBy = originRefExists
      ? await countCommits(ctx.repoPath, `${base}..${originRef}`)
      : 0;
    const aheadBy = originRefExists ? await countCommits(ctx.repoPath, `${originRef}..${base}`) : 0;

    return {
      ...empty,
      ready: true,
      currentBranch,
      hasOrigin: true,
      originUrl,
      fetchOk: fetch.ok,
      fetchError: fetch.error,
      behindBy,
      aheadBy,
      branchName,
      baseBranch: base,
      parentBranch: currentBranch,
    };
  },

  // Headless: the user already chose to push (and picked the credential) on step 12.
  // Auto-submit the push params as this form's defaults so resolveMergePhase reads them
  // from formValues (pushBase -> pushAfterMerge; credentialId/setUpstream -> the push).
  form(_ctx, detected): FormSchema {
    const base = detected.baseBranch ?? 'the current branch';
    const body = !detected.ready
      ? 'No branch or origin remote to push to; skipping.'
      : !detected.fetchOk
        ? `Could not fetch origin (${detected.fetchError ?? 'unknown'}); attempting the push with the local branch as-is.`
        : detected.behindBy > 0
          ? `origin/${base} has ${detected.behindBy} newer commit(s); Haive will merge them into ${base} (AI-assisted on conflict), then push.`
          : `Pushing ${base} to origin.`;
    const fields: FormField[] = [
      {
        type: 'note',
        id: 'pushNote',
        label: 'Push to origin',
        body,
        variant: detected.ready && detected.fetchOk ? 'info' : 'warning',
      },
      {
        // Drives resolveMergePhase (selectedMerge + pushAfterMerge). False when not
        // ready so the phase no-ops and apply reports "nothing to push".
        type: 'checkbox',
        id: 'pushBase',
        label: `Push ${base} to origin`,
        default: detected.ready,
      },
      {
        type: 'checkbox',
        id: 'setUpstream',
        label: 'Set upstream (-u)',
        default: detected.setUpstream,
      },
      {
        // Carries the step-12 credential choice into formValues. Single matching option
        // so the auto-submitted default validates; '' means manual (no stored credential).
        type: 'select',
        id: 'credentialId',
        label: 'Push credential',
        options: [
          {
            value: detected.credentialId,
            label: detected.credentialId ? 'Stored credential' : 'Manual authentication',
          },
        ],
        default: detected.credentialId,
      },
    ];
    return {
      title: 'Push onboarding to origin',
      description: `Pushing the onboarding commit on ${base} to origin.`,
      fields,
      submitLabel: 'Push',
      autoSubmit: true,
    };
  },

  // Merge origin/<base> into <base> with the LLM conflict-resolution loop, then push
  // <base> (pushAfterMerge, driven by formValues.pushBase). Mirrors 00a-sync-base's spec.
  mergeResolve: {
    requiredCapabilities: ['tool_use', 'file_write'],
    selectedMerge: (formValues) => formValues.pushBase === true,
    buildFixPrompt: ({ featureBranch, guidance }) =>
      buildMergeFixPrompt(featureBranch, undefined, guidance),
    buildClarificationForm: ({ baseBranch, featureBranch, uncertainty }) => ({
      title: 'Push conflict - your input needed',
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

  // resolveMergePhase (before apply) did the merge + push and persisted the outcome on
  // the step's merge_resolve_state. Read it to report. No worktree to remove.
  async apply(ctx, args): Promise<OnboardingPushApply> {
    const d = args.detected;
    const base = d.baseBranch;
    if (!d.ready || !base) {
      return {
        pushed: false,
        merged: false,
        branch: base,
        message: 'nothing to push (no branch or origin remote)',
      };
    }
    const row = await ctx.db.query.taskSteps.findFirst({
      where: eq(schema.taskSteps.id, ctx.taskStepId),
      columns: { mergeResolveState: true },
    });
    const st = (row?.mergeResolveState ?? null) as MergeResolveState | null;
    const pushed = st?.pushed ?? false;
    const merged = st?.merged ?? false;

    const parts: string[] = [];
    if (merged && d.behindBy > 0) parts.push(`merged origin/${base} into ${base}`);
    parts.push(pushed ? `pushed ${base} to origin` : 'push did not complete');
    ctx.logger.info({ base, pushed, merged }, 'onboarding push complete');
    return { pushed, merged, branch: base, message: parts.join('; ') };
  },
};
