import path from 'node:path';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Database, type MergeResolveState } from '@haive/database';
import {
  MERGE_CLARIFICATION_ANSWERED_EVENT,
  MERGE_CLARIFICATION_ASKED_EVENT,
  type FormSchema,
} from '@haive/shared';
import { resolveTaskDispatch } from '../orchestrator/dispatcher.js';
import { resolveGitEnv } from '../secrets/user-git-identity.js';
import { buildCredentialHelper, gitRun, pushBranch, scrubSecret } from '../repo/git-push.js';
import { completeMergeHostSide, mergeCommitted } from './git-merge.js';
import { pathExists } from './steps/onboarding/_helpers.js';
import { isFatalProviderFailure } from '../queues/cli-exec/failure-class.js';
import { parseJsonLoose } from './steps/_fenced-json.js';
import { resolvePreferredCli } from './step-runner.js';
import { worktreeDirName, worktreeDirPaths } from '../repo/worktree-paths.js';
import { ensureSandboxWritableTree } from '../repo/worktree-permissions.js';
import { SANDBOX_WORKDIR } from '../sandbox/sandbox-runner.js';
import type { MergeResolveSpec, StepContext, StepDefinition } from './step-definition.js';
import type { AdvanceStepParams, AdvanceStepResult, TaskStepRow } from './step-runner.js';

// The 12-worktree-cleanup analogue of dag-executor's runLevelMerge: merge the
// feature branch into its base with an LLM conflict-resolution loop. The runner
// special-cases this between the form and apply phases (like resolveDagPhase). On
// every ADVANCE_STEP re-entry the phase re-derives its state from the persisted
// merge_resolve_state row reconciled with on-disk git, so a crash + redelivery
// resumes correctly. apply reads the terminal state to remove the worktree.

const FALLBACK_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Haive',
  GIT_AUTHOR_EMAIL: 'worker@haive.local',
  GIT_COMMITTER_NAME: 'Haive',
  GIT_COMMITTER_EMAIL: 'worker@haive.local',
};

/** Max automatic (unguided) LLM resolution attempts before halting for a manual
 *  retry. Mirrors MAX_AUTO_CONFLICT_RETRIES in dag-executor.ts. */
const MAX_MERGE_CONFLICT_RETRIES = 4;
const MERGE_FIX_TIMEOUT_MS = 30 * 60 * 1000;

export type MergeResolved =
  | { resolved: true; current: TaskStepRow }
  | { resolved: false; result: AdvanceStepResult };

// Structured signal the fix agent emits: either it resolved everything, or it is
// unsure and wants the user to decide. Parsed leniently (fenced JSON + jsonrepair).
const mergeFixResultSchema = z.object({
  status: z.enum(['resolved', 'uncertain']),
  question: z.string().optional(),
});

// Durable clarification channel (mirrors _biz-req-feedback.ts): the question + the
// user's answer live in task_events so they survive form_values / state overwrites.
// The event types are shared with the api /clarify route (single source of truth).
const MERGE_GUIDANCE_ASKED = MERGE_CLARIFICATION_ASKED_EVENT;
const MERGE_GUIDANCE_ANSWERED = MERGE_CLARIFICATION_ANSWERED_EVENT;

/** Record that the merge phase asked the user a question (phase -> awaiting-guidance). */
export async function recordMergeQuestion(
  db: Database,
  taskId: string,
  taskStepId: string,
  uncertainty: string,
): Promise<void> {
  await db
    .insert(schema.taskEvents)
    .values({ taskId, taskStepId, eventType: MERGE_GUIDANCE_ASKED, payload: { uncertainty } });
}

/** Record the user's answer (called by the /clarify API route). */
export async function recordMergeGuidance(
  db: Database,
  taskId: string,
  taskStepId: string,
  answer: string,
): Promise<void> {
  await db
    .insert(schema.taskEvents)
    .values({ taskId, taskStepId, eventType: MERGE_GUIDANCE_ANSWERED, payload: { answer } });
}

/** The most recent clarification answer that has NOT since been re-asked, or ''
 *  (mirrors loadOutstandingBizReqFeedback). */
export async function loadOutstandingMergeGuidance(db: Database, taskId: string): Promise<string> {
  const rows = await db
    .select()
    .from(schema.taskEvents)
    .where(
      and(
        eq(schema.taskEvents.taskId, taskId),
        inArray(schema.taskEvents.eventType, [MERGE_GUIDANCE_ASKED, MERGE_GUIDANCE_ANSWERED]),
      ),
    )
    .orderBy(desc(schema.taskEvents.createdAt))
    .limit(1);
  const latest = rows[0];
  if (!latest || latest.eventType !== MERGE_GUIDANCE_ANSWERED) return '';
  return ((latest.payload as { answer?: string } | null)?.answer ?? '').trim();
}

/** Parse the fix agent's structured output. Null when it emitted no parseable signal. */
function parseFixResult(inv: {
  rawOutput?: string | null;
}): { status: 'resolved' | 'uncertain'; question?: string } | null {
  const raw = inv.rawOutput ?? '';
  if (!raw) return null;
  const json = parseJsonLoose(raw);
  if (json == null) return null;
  const parsed = mergeFixResultSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** Persist the clarification form and park the step in waiting_form. The clarification
 *  schema (tagged submitAction:'clarify') replaces the persisted form schema for
 *  rendering; the answer arrives via the /clarify route (task_events), so form_values
 *  is never touched. */
async function setStepStatusForm(
  db: Database,
  stepRowId: string,
  formSchema: FormSchema,
  statusMessage: string,
): Promise<TaskStepRow> {
  const rows = await db
    .update(schema.taskSteps)
    .set({ status: 'waiting_form', formSchema, statusMessage, updatedAt: new Date() })
    .where(eq(schema.taskSteps.id, stepRowId))
    .returning();
  return rows[0]!;
}

async function parkForGuidance(
  db: Database,
  current: TaskStepRow,
  spec: MergeResolveSpec,
  state: MergeResolveState,
): Promise<MergeResolved> {
  const formSchema = spec.buildClarificationForm({
    baseBranch: state.baseBranch,
    featureBranch: state.featureBranch,
    conflictFiles: await conflictFiles(state.mergeDir),
    uncertainty: state.pendingQuestion?.uncertainty ?? '',
  });
  const row = await setStepStatusForm(
    db,
    current.id,
    formSchema,
    `Waiting for your guidance on the ${state.featureBranch} → ${state.baseBranch} merge…`,
  );
  return { resolved: false, result: { status: 'waiting_form', row, formSchema } };
}

async function setStepStatus(
  db: Database,
  stepRowId: string,
  patch: {
    status?: 'waiting_cli' | 'failed' | 'running';
    statusMessage?: string | null;
    errorMessage?: string | null;
    endedAt?: Date;
  },
): Promise<TaskStepRow> {
  const rows = await db
    .update(schema.taskSteps)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.taskSteps.id, stepRowId))
    .returning();
  return rows[0]!;
}

async function saveMergeState(
  db: Database,
  stepRowId: string,
  state: MergeResolveState,
): Promise<void> {
  await db
    .update(schema.taskSteps)
    .set({ mergeResolveState: state, updatedAt: new Date() })
    .where(eq(schema.taskSteps.id, stepRowId));
}

/** Host + sandbox paths for a transient worktree checked out on the base branch.
 *  Suffixes `--base` so it never collides with a feature worktree. */
function baseWorktreePaths(
  ctx: StepContext,
  base: string,
): { worktreePath: string; sandboxWorktreePath: string } {
  return worktreeDirPaths(ctx.repoPath, ctx.sandboxWorkdir, `${worktreeDirName(base)}--base`);
}

/** Add (or reuse) a worktree checked out on the base branch. Safe only when base is
 *  NOT checked out elsewhere — guaranteed here because this runs only when the parent
 *  checkout is on a DIFFERENT branch. Mirrors createIssueWorktree in dag-executor. */
async function ensureBaseWorktree(
  ctx: StepContext,
  worktreePath: string,
  base: string,
): Promise<void> {
  await gitRun(ctx.repoPath, ['worktree', 'prune']);
  const list = await gitRun(ctx.repoPath, ['worktree', 'list', '--porcelain']);
  const registered =
    list.code === 0 && list.stdout.split('\n').some((l) => l === `worktree ${worktreePath}`);
  if (!registered) {
    if (await pathExists(worktreePath)) {
      await gitRun(ctx.repoPath, ['worktree', 'remove', '--force', worktreePath]);
    }
    const res = await gitRun(ctx.repoPath, ['worktree', 'add', worktreePath, base]);
    if (res.code !== 0) {
      throw new Error(`git worktree add (base) failed: ${res.stderr || res.stdout}`);
    }
  }
  await ensureSandboxWritableTree(worktreePath);
}

async function removeBaseWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await gitRun(repoPath, ['worktree', 'remove', worktreePath, '--force']);
  await gitRun(repoPath, ['worktree', 'prune']);
}

/** Terminal success: tear down a transient base worktree (cross-branch only — the
 *  merge commit already persists in the shared object store) and mark the state done. */
async function reachDone(
  db: Database,
  current: TaskStepRow,
  ctx: StepContext,
  state: MergeResolveState,
): Promise<MergeResolved> {
  // Push the integrated base branch to origin first when the form requested it. The
  // push runs from ctx.repoPath, which shares refs with any base worktree, so it
  // carries the new merge commit even after the worktree is removed. Idempotent on
  // re-entry: a completed push reports "up-to-date".
  if (state.pushAfterMerge && !state.pushed) {
    const pushing: MergeResolveState = { ...state, phase: 'pushing', merged: true };
    await saveMergeState(db, current.id, pushing);
    const fv = (current.formValues ?? {}) as { credentialId?: string; setUpstream?: boolean };
    try {
      await pushBranch({
        cwd: ctx.repoPath,
        branch: state.baseBranch,
        setUpstream: fv.setUpstream !== false,
        credentialId: fv.credentialId || undefined,
        db,
        userId: ctx.userId,
      });
    } catch (err) {
      const row = await halt(
        db,
        current,
        `Merge committed, but pushing '${state.baseBranch}' to origin failed: ${
          (err as Error).message
        } The merge is saved locally — retry the push.`,
      );
      return {
        resolved: false,
        result: { status: 'failed', row, error: row.errorMessage ?? 'push failed' },
      };
    }
    state = { ...pushing, pushed: true };
  }
  if (state.mode === 'cross-branch') {
    await removeBaseWorktree(ctx.repoPath, state.mergeDir);
  }
  const done: MergeResolveState = { ...state, phase: 'done', merged: true };
  await saveMergeState(db, current.id, done);
  return { resolved: true, current: { ...current, mergeResolveState: done } };
}

/** Cap on pre-push base-sync rounds before giving up (origin is a moving target). */
const MAX_BASE_SYNC_ROUNDS = 3;

/** A merge round committed. If it was the FEATURE merge and a base push is pending,
 *  integrate origin into the base first (prePushSync) so the push fast-forwards;
 *  otherwise (base-sync round, or no push) push + finish via reachDone. */
async function finishMerge(
  db: Database,
  stepDef: StepDefinition,
  current: TaskStepRow,
  ctx: StepContext,
  params: AdvanceStepParams,
  state: MergeResolveState,
): Promise<MergeResolved> {
  if (state.pushAfterMerge && !state.pushed && (state.mergeStage ?? 'feature') === 'feature') {
    return prePushSync(db, stepDef, current, ctx, params, state);
  }
  return reachDone(db, current, ctx, state);
}

/** Best-effort authenticated `git fetch origin <base>` (same credential the push uses).
 *  Never throws — a failure is surfaced so the caller can warn-and-continue. */
async function fetchForSync(
  db: Database,
  ctx: StepContext,
  cwd: string,
  base: string,
  credentialId: string | undefined,
): Promise<{ ok: boolean; error: string | null }> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
  const argv: string[] = [];
  let secret: string | null = null;
  if (credentialId) {
    try {
      const helper = await buildCredentialHelper(db, credentialId, ctx.userId);
      secret = helper.secret;
      Object.assign(env, helper.env);
      argv.push(...helper.argv);
    } catch (err) {
      return { ok: false, error: `credential load failed: ${(err as Error).message}` };
    }
  }
  argv.push('fetch', 'origin', base);
  const res = await gitRun(cwd, argv, env);
  if (res.code !== 0) {
    return {
      ok: false,
      error: scrubSecret(res.stderr || res.stdout, secret)
        .trim()
        .slice(0, 300),
    };
  }
  return { ok: true, error: null };
}

async function countAhead(cwd: string, range: string): Promise<number> {
  const res = await gitRun(cwd, ['rev-list', '--count', range]);
  if (res.code !== 0) return 0;
  const n = Number.parseInt(res.stdout.trim() || '0', 10);
  return Number.isFinite(n) ? n : 0;
}

/** Pre-push: bring the base up to date with origin before pushing, so the push is a
 *  fast-forward. When origin advanced, merge origin/<base> into base through the SAME
 *  pending/resolving machinery (a 'base-sync' round) so a conflict gets the existing
 *  fix-agent loop; the mergeStage guard stops that round from re-syncing → the recursion
 *  is bounded (feature -> base-sync -> push). */
async function prePushSync(
  db: Database,
  stepDef: StepDefinition,
  current: TaskStepRow,
  ctx: StepContext,
  params: AdvanceStepParams,
  state: MergeResolveState,
): Promise<MergeResolved> {
  const base = state.baseBranch;
  const fv = (current.formValues ?? {}) as { credentialId?: string };
  const fetched = await fetchForSync(db, ctx, state.mergeDir, base, fv.credentialId || undefined);
  if (!fetched.ok) {
    // A flaky link must never block the task: push the local base as-is. If origin did
    // move, the push fails non-ff exactly as before — recoverable by retry.
    ctx.logger.warn(
      { base, err: fetched.error },
      'pre-push base sync: fetch failed; pushing the local base as-is',
    );
    return reachDone(db, current, ctx, state);
  }
  const behind = await countAhead(state.mergeDir, `${base}..origin/${base}`);
  if (behind === 0) {
    // Origin has not moved since 00a-sync-base — push directly (today's behavior).
    return reachDone(db, current, ctx, state);
  }
  const rounds = state.baseSyncRounds ?? 0;
  if (rounds >= MAX_BASE_SYNC_ROUNDS) {
    const row = await halt(
      db,
      current,
      `origin/${base} keeps advancing (${behind} commits behind after ${rounds} sync attempts). Pull ${base} and push it manually — the merge is saved locally.`,
    );
    return {
      resolved: false,
      result: { status: 'failed', row, error: row.errorMessage ?? 'origin moving' },
    };
  }
  const next: MergeResolveState = {
    ...state,
    mergeStage: 'base-sync',
    featureBranch: `origin/${base}`,
    phase: 'pending',
    fixInvocationId: null,
    pendingQuestion: null,
    conflictRetries: 0,
    baseSyncRounds: rounds + 1,
  };
  await saveMergeState(db, current.id, next);
  return resolveMergePhase(db, stepDef, { ...current, mergeResolveState: next }, ctx, params);
}

/** Unmerged paths in a mid-merge worktree (for the fix prompt). */
async function conflictFiles(mergeDir: string): Promise<string[]> {
  const res = await gitRun(mergeDir, ['diff', '--name-only', '--diff-filter=U']);
  return res.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Dispatch one conflict-resolution agent into the merge worktree's sandbox.
 *  Mirrors dispatchMergeFixAgent in dag-executor.ts. Returns the invocation id, or
 *  null when no CLI provider can run it. */
async function dispatchFixAgent(
  db: Database,
  stepDef: StepDefinition,
  current: TaskStepRow,
  params: AdvanceStepParams,
  spec: MergeResolveSpec,
  state: MergeResolveState,
  guidance: string,
): Promise<string | null> {
  // Keep this exact value paired between prompt planning and queue payload: an
  // empty override is the repo root (real `.git` directory), while a transient
  // --base worktree receives the zero-byte gitfile boundary.
  const worktreeRel = path.relative(SANDBOX_WORKDIR, state.sandboxMergeDir);
  const prompt = spec.buildFixPrompt({
    baseBranch: state.baseBranch,
    featureBranch: state.featureBranch,
    conflictFiles: await conflictFiles(state.mergeDir),
    guidance,
  });
  const { cliProviderId: preferred, effortLevel: preferredEffort } = await resolvePreferredCli(
    db,
    params.userId,
    stepDef.metadata.id,
    params.cliProviderId ?? null,
    params.providers!,
    'default',
    params.taskId,
    params.ignoreSavedStepClis ?? false,
  );
  const plan = await resolveTaskDispatch(db, params.taskId, {
    providers: params.providers!,
    preferredProviderId: preferred,
    worktreeRel,
    input: { kind: 'prompt', prompt, capabilities: spec.requiredCapabilities },
    invokeOpts: { cwd: state.sandboxMergeDir, effortLevel: preferredEffort ?? undefined },
  });
  if (plan.mode === 'skip' || !plan.invocation || plan.invocation.kind !== 'cli') return null;
  const inv = await db
    .insert(schema.cliInvocations)
    .values({
      taskId: params.taskId,
      taskStepId: current.id,
      cliProviderId: plan.providerId,
      mode: 'cli',
      prompt: plan.effectivePrompt ?? prompt,
    })
    .returning({ id: schema.cliInvocations.id });
  const invId = inv[0]?.id;
  if (!invId) return null;
  await params.deps!.enqueueCliInvocation({
    invocationId: invId,
    taskId: params.taskId,
    taskStepId: current.id,
    userId: params.userId,
    // Isolate the conflict fix-agent to the merge working tree: '' (repo root, same-branch)
    // or the transient --base worktree (cross-branch), recovered from the stored container
    // merge dir relative to the workdir root.
    worktreeRel,
    cliProviderId: plan.providerId,
    kind: 'cli',
    spec: plan.invocation.spec,
    timeoutMs: spec.timeoutMs ?? MERGE_FIX_TIMEOUT_MS,
  });
  return invId;
}

function halt(db: Database, current: TaskStepRow, message: string): Promise<TaskStepRow> {
  return setStepStatus(db, current.id, {
    status: 'failed',
    errorMessage: message,
    endedAt: new Date(),
  });
}

/** Merge the feature branch into its base with an LLM conflict-resolution loop.
 *  Returns resolved:true once the merge commits (or the action is not a merge / the
 *  merge is cleanly skipped) so the runner falls through to apply; resolved:false
 *  parks the step (waiting_cli) or halts it (failed). */
export async function resolveMergePhase(
  db: Database,
  stepDef: StepDefinition,
  current: TaskStepRow,
  ctx: StepContext,
  params: AdvanceStepParams,
): Promise<MergeResolved> {
  const spec = stepDef.mergeResolve!;
  const formValues = (current.formValues ?? {}) as Record<string, unknown>;
  if (!spec.selectedMerge(formValues)) {
    // keep / remove_only — no merge; apply handles the worktree.
    return { resolved: true, current };
  }

  const userEnv = await resolveGitEnv(db, { userId: ctx.userId, taskId: ctx.taskId });
  const commitEnv = Object.keys(userEnv).length > 0 ? userEnv : FALLBACK_GIT_IDENTITY;

  let state = current.mergeResolveState as MergeResolveState | null;

  // --- init: snapshot the merge target + mode from the detect output ---
  if (!state) {
    const det = (current.detectOutput ?? {}) as {
      branchName?: string | null;
      baseBranch?: string | null;
      parentBranch?: string | null;
    };
    const featureBranch = det.branchName ?? '';
    const base = det.baseBranch ?? null;
    const parentBranch = det.parentBranch ?? null;
    // The merge lands on the recorded base, or the parent's current branch when no
    // base was recorded (older tasks) — the natural integration point.
    const mergeTarget = base ?? parentBranch;
    const base0: MergeResolveState = {
      mode: 'same-branch',
      phase: 'done',
      baseBranch: mergeTarget ?? '',
      featureBranch,
      mergeDir: ctx.repoPath,
      sandboxMergeDir: ctx.sandboxWorkdir,
      fixInvocationId: null,
      conflictRetries: 0,
      pendingQuestion: null,
      pushAfterMerge: formValues.pushBase === true,
      merged: false,
      skipReason: null,
      pushed: false,
      mergeStage: 'feature',
      baseSyncRounds: 0,
    };

    if (!featureBranch || !mergeTarget) {
      const skipped = {
        ...base0,
        skipReason: 'no branch, or no base/current branch to merge into',
      };
      await saveMergeState(db, current.id, skipped);
      return { resolved: true, current: { ...current, mergeResolveState: skipped } };
    }
    // Cross-branch: the parent checkout is on a different branch, so we cannot merge
    // at ctx.repoPath without landing on the wrong branch. Create a transient worktree
    // checked out on the base branch (shares .git, so the merge commit persists) and
    // merge there.
    if (base && parentBranch && parentBranch !== base) {
      const wt = baseWorktreePaths(ctx, base);
      await ensureBaseWorktree(ctx, wt.worktreePath, base);
      state = {
        ...base0,
        mode: 'cross-branch',
        phase: 'pending',
        mergeDir: wt.worktreePath,
        sandboxMergeDir: wt.sandboxWorktreePath,
      };
      await saveMergeState(db, current.id, state);
    } else {
      state = { ...base0, phase: 'pending' };
      await saveMergeState(db, current.id, state);
    }
  }

  // --- pending: attempt the merge; clean -> done, conflict -> resolving (live) ---
  if (state.phase === 'pending') {
    const merge = await gitRun(
      state.mergeDir,
      ['merge', '--no-ff', state.featureBranch, '-m', `Merge ${state.featureBranch}`],
      commitEnv,
    );
    if (merge.code === 0) {
      return finishMerge(db, stepDef, current, ctx, params, state);
    }
    // Conflict: leave the mid-merge LIVE (no --abort) so the fix agent edits it.
    state = { ...state, phase: 'resolving' };
    await saveMergeState(db, current.id, state);
  }

  // --- awaiting-guidance: the user's answer (via /clarify, in task_events) resumes
  // the loop. A guided retry resets the auto-retry budget so the user can iterate. ---
  if (state.phase === 'awaiting-guidance') {
    const guidance = await loadOutstandingMergeGuidance(db, params.taskId);
    if (!guidance) {
      // Not answered yet → re-park (the form is rebuilt deterministically).
      return parkForGuidance(db, current, spec, state);
    }
    state = { ...state, phase: 'resolving', pendingQuestion: null, conflictRetries: 0 };
    await saveMergeState(db, current.id, state);
  }

  // --- resolving: drive the fix-agent loop ---
  if (state.phase === 'resolving') {
    // (1) Ingest an in-flight fix agent.
    if (state.fixInvocationId) {
      const inv = await db.query.cliInvocations.findFirst({
        where: eq(schema.cliInvocations.id, state.fixInvocationId),
      });
      if (!inv || inv.endedAt === null) {
        return { resolved: false, result: { status: 'waiting_cli', row: current } };
      }
      // Fatal provider failure (rate-limit/quota, bad/expired auth, 5xx outage) will
      // not recover this run — abort the live merge and fail instead of spending the
      // remaining conflictRetries re-dispatching against a dead provider. "Retry with
      // AI" re-creates the conflict on demand once the provider is back.
      if (isFatalProviderFailure(inv.errorMessage)) {
        await db
          .update(schema.cliInvocations)
          .set({ consumedAt: new Date() })
          .where(eq(schema.cliInvocations.id, inv.id));
        await gitRun(state.mergeDir, ['merge', '--abort']);
        const row = await halt(db, current, inv.errorMessage ?? 'fatal provider error');
        return {
          resolved: false,
          result: { status: 'failed', row, error: row.errorMessage ?? 'fatal provider error' },
        };
      }
      await db
        .update(schema.cliInvocations)
        .set({ consumedAt: new Date() })
        .where(eq(schema.cliInvocations.id, inv.id));
      // The agent may have signaled it cannot confidently resolve → ask the user.
      const fix = parseFixResult(inv);
      if (fix?.status === 'uncertain') {
        const question =
          fix.question?.trim() || 'The agent is unsure how to resolve this conflict.';
        await recordMergeQuestion(db, params.taskId, current.id, question);
        state = {
          ...state,
          fixInvocationId: null,
          phase: 'awaiting-guidance',
          pendingQuestion: { uncertainty: question, askedAt: new Date().toISOString() },
        };
        await saveMergeState(db, current.id, state);
        return parkForGuidance(db, current, spec, state);
      }
      const committed = await completeMergeHostSide(state.mergeDir, commitEnv);
      state = { ...state, fixInvocationId: null };
      if (committed) {
        return finishMerge(db, stepDef, current, ctx, params, state);
      }
      // Markers remain → abort this attempt; the dispatch decision below retries or halts.
      await gitRun(state.mergeDir, ['merge', '--abort']);
      await saveMergeState(db, current.id, state);
    }

    // (2) Dispatch decision. Abort the live merge before halting so a failed phase
    // never leaves the parent repo stuck mid-merge (a later "Retry with AI" re-creates
    // the conflict on demand).
    if (state.conflictRetries >= MAX_MERGE_CONFLICT_RETRIES) {
      await gitRun(state.mergeDir, ['merge', '--abort']);
      const row = await halt(
        db,
        current,
        `Merge conflict merging ${state.featureBranch} into ${state.baseBranch}: auto-resolution exhausted after ${MAX_MERGE_CONFLICT_RETRIES} attempts. Resolve manually or use "Retry with AI".`,
      );
      return {
        resolved: false,
        result: { status: 'failed', row, error: row.errorMessage ?? 'merge conflict' },
      };
    }
    if (!params.providers || !params.deps) {
      await gitRun(state.mergeDir, ['merge', '--abort']);
      const row = await halt(
        db,
        current,
        'Merge conflict requires a CLI provider to resolve, but none were supplied.',
      );
      return {
        resolved: false,
        result: { status: 'failed', row, error: row.errorMessage ?? 'no provider' },
      };
    }
    // Recreate the live merge if it isn't open (after an abort or a crash).
    if (await mergeCommitted(state.mergeDir)) {
      return finishMerge(db, stepDef, current, ctx, params, state);
    }
    const open = await gitRun(state.mergeDir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
    if (open.code !== 0) {
      await gitRun(
        state.mergeDir,
        ['merge', '--no-ff', state.featureBranch, '-m', `Merge ${state.featureBranch}`],
        commitEnv,
      );
    }
    const guidance = await loadOutstandingMergeGuidance(db, params.taskId);
    const invId = await dispatchFixAgent(db, stepDef, current, params, spec, state, guidance);
    if (!invId) {
      await gitRun(state.mergeDir, ['merge', '--abort']);
      const row = await halt(
        db,
        current,
        'No CLI provider available for merge conflict resolution.',
      );
      return {
        resolved: false,
        result: { status: 'failed', row, error: row.errorMessage ?? 'no provider' },
      };
    }
    state = { ...state, fixInvocationId: invId, conflictRetries: state.conflictRetries + 1 };
    await saveMergeState(db, current.id, state);
    const row = await setStepStatus(db, current.id, {
      status: 'waiting_cli',
      statusMessage: `Resolving merge conflict (${state.featureBranch} → ${state.baseBranch}) with AI…`,
    });
    return { resolved: false, result: { status: 'waiting_cli', row } };
  }

  // Crash-recovery: a push persisted as in-flight ('pushing') re-runs idempotently
  // (a completed push reports "up-to-date").
  if (state.phase === 'pushing') {
    return reachDone(db, current, ctx, state);
  }

  // phase 'done' → proceed to apply, which reads the terminal state.
  return { resolved: true, current: { ...current, mergeResolveState: state } };
}
