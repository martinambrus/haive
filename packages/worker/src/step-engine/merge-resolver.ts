import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  lockRepositoryTasksKey,
  schema,
  isUniqueViolation,
  type Database,
  type MergeResolveState,
} from '@haive/database';
import {
  MERGE_CLARIFICATION_ANSWERED_EVENT,
  MERGE_CLARIFICATION_ASKED_EVENT,
  type FormSchema,
} from '@haive/shared';
import { resolveTaskDispatch } from '../orchestrator/dispatcher.js';
import { houseRulesOptOut } from '../orchestrator/house-rules.js';
import { resolveGitEnv } from '../secrets/user-git-identity.js';
import { buildCredentialHelper, gitRun, pushBranch, scrubSecret } from '../repo/git-push.js';
import { checkoutHoldingTasks } from '../repo/refresh.js';
import {
  abortFailureNote,
  abortMerge,
  abortOtherMerge,
  captureFixBaseline,
  completeMergeHostSide,
  fixerIndexHeldNote,
  fixerLeftoversWarning,
  mergeCommitted,
  mergeOpenFor,
  openMerge,
  recordFixerLeftovers,
  relocateFixerChanges,
  revParse,
  squashMergeCommit,
  isCommitAncestor,
  unmergedPaths,
  type MergeAbort,
  type MergeOpen,
  type SecretMaskSource,
} from './git-merge.js';
import { resolveHaiveProjectionConflicts } from '../plan/projection-merge.js';
import { seedPlanBaseFromCheckout } from '../plan/mirror.js';
import {
  MOVE_ATTEMPTS,
  putBackAfterFailure,
  putBackProjections,
  recoverAfterMoveFailure,
  restoreProjectionsInTx,
  resyncHaiveProjections,
  setAsideHaiveProjections,
  type KeptFiles,
  type RestoreSection,
} from '../project-state/set-aside.js';
import {
  claimMergeDir,
  inMergeDirUnlessClaimed,
  releaseMergeDir,
  withMergeDirSection,
  type DbHandle,
} from './merge-dir-claim.js';
import {
  noteAbortedByNext,
  peekOpenMerge,
  relocateLeftOpenFixers,
  takeLeftOpenKept,
  type OpenMerge,
} from './left-open-merge.js';
import {
  adoptKept,
  keptMetadataOf,
  restoreKeptMetadataOf,
  settleProjections,
  type KeptMetadata,
} from './merge-projections.js';
import { buildSquashCommitMessage } from './squash-message.js';
import {
  addStepWarning,
  assertOwnsStep,
  insertOwnedRun,
  updateOwnedStep,
} from './step-ownership.js';
import { runFinishedCleanly, runIsLive, runNeverAnswered } from './run-wait.js';
import { hasWorkspaceEntry } from './workspace-probe.js';
import {
  isFatalProviderFailure,
  isOutputTruncationMessage,
} from '../queues/cli-exec/failure-class.js';
import { taskSecretMaskPolicy } from '../queues/cli-exec/secret-mask.js';
import { parseJsonLooseValidated } from './steps/_fenced-json.js';
import { resolvePreferredCli, TRUNCATION_RETRY_NOTICE } from './step-runner.js';
import { augmentPromptWithTerseness } from './terseness-context.js';
import { overrideOr } from './dispatch-timeout.js';
import { worktreeDirName, worktreeDirPaths } from '../repo/worktree-paths.js';
import { relUnder } from '@haive/shared/fs-safe';
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
  { resolved: true; current: TaskStepRow } | { resolved: false; result: AdvanceStepResult };

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

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

/** What the fix agent is asked to end with. Appended here and not to the shared fix prompt: the DAG
 *  merger reads no result and has no one to ask. */
const FIX_RESULT_CONTRACT = [
  '',
  'When you stop, end your reply with ONE fenced json block saying how it went:',
  '```json',
  '{"status": "resolved"}',
  '```',
  'If a conflict needs a decision the code cannot settle (which side is meant to win), do not',
  'guess: leave that file as it is and end with',
  '```json',
  '{"status": "uncertain", "question": "<one concrete question for the developer>"}',
  '```',
].join('\n');

/** Parse the fix agent's structured output: the last block that fits, so JSON it quoted from a
 *  conflicted file before its answer cannot hide the answer. Null when none does. */
function parseFixResult(inv: {
  rawOutput?: string | null;
}): { status: 'resolved' | 'uncertain'; question?: string } | null {
  const raw = inv.rawOutput ?? '';
  if (!raw) return null;
  return parseJsonLooseValidated(raw, (candidate) => {
    const parsed = mergeFixResultSchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  });
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
  return updateOwnedStep(db, stepRowId, { status: 'waiting_form', formSchema, statusMessage });
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
  db: DbHandle,
  stepRowId: string,
  patch: {
    status?: 'waiting_cli' | 'failed' | 'running';
    statusMessage?: string | null;
    errorMessage?: string | null;
    endedAt?: Date;
  },
): Promise<TaskStepRow> {
  return updateOwnedStep(db, stepRowId, patch);
}

export async function saveMergeState(
  db: DbHandle,
  stepRowId: string,
  state: MergeResolveState,
): Promise<void> {
  await updateOwnedStep(db, stepRowId, { mergeResolveState: state });
}

/** A host-side write to the merge dir, fenced on this step's claim and the pass's epoch. */
function inMergeDir<T>(
  db: Database,
  current: TaskStepRow,
  params: AdvanceStepParams,
  mergeDir: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return withMergeDirSection(
    db,
    { mergeDir, stepId: current.id, taskId: params.taskId, epoch: params.epoch },
    fn,
  );
}

/** Read ahead of a section: a pool read inside one can wait on a connection the sections hold. */
async function maskSourceOnce(db: Database, taskId: string): Promise<SecretMaskSource> {
  const read = await taskSecretMaskPolicy(db, taskId).then(
    (policy) => ({ policy }),
    (error: unknown) => ({ error }),
  );
  return async () => {
    if ('error' in read) throw read.error;
    return read.policy;
  };
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
    // Split on the repository root, as the `ensureSandboxWritableTree` call below already does.
    if (await hasWorkspaceEntry(ctx.repoPath, relUnder(ctx.repoPath, worktreePath))) {
      await gitRun(ctx.repoPath, ['worktree', 'remove', '--force', worktreePath]);
    }
    const res = await gitRun(ctx.repoPath, ['worktree', 'add', worktreePath, base]);
    if (res.code !== 0) {
      throw new Error(`git worktree add (base) failed: ${res.stderr || res.stdout}`);
    }
  }
  await ensureSandboxWritableTree(ctx.repoPath, relUnder(ctx.repoPath, worktreePath));
}

/** Never forced: a base worktree holding changes git will not discard stays, and why comes back. */
async function removeBaseWorktree(repoPath: string, worktreePath: string): Promise<string | null> {
  const res = await gitRun(repoPath, ['worktree', 'remove', worktreePath]);
  await gitRun(repoPath, ['worktree', 'prune']);
  if (res.code === 0) return null;
  return (res.stderr || res.stdout).trim().split('\n')[0] || 'git gave no reason';
}

async function taskRepositoryId(db: Database, taskId: string): Promise<string | null> {
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { repositoryId: true },
  });
  return task?.repositoryId ?? null;
}

function asideHalt(
  why:
    | { outcome: 'refused'; reason: string }
    | { outcome: 'held'; holding: number }
    | { outcome: 'retry' },
): string {
  if (why.outcome === 'held') {
    const n = why.holding;
    return `${n} other task${n === 1 ? ' is' : 's are'} working in this checkout; nothing was merged. Retry this step once ${n === 1 ? 'it finishes' : 'they finish'}.`;
  }
  return why.outcome === 'refused'
    ? `${why.reason}. Nothing was merged; commit or discard that change, then retry.`
    : "Haive's project files kept changing under the merge; nothing was merged. Retry this step.";
}

async function settleGivenUp(
  db: Database,
  current: TaskStepRow,
  params: AdvanceStepParams,
  given: MergeResolveState,
): Promise<void> {
  const repositoryId =
    given.mode === 'same-branch' ? await taskRepositoryId(db, params.taskId) : null;
  if (!repositoryId) return;
  await settleProjections(db, repositoryId, given, (cleared) =>
    saveMergeState(db, current.id, cleared),
  );
}

/** Terminal success: tear down a transient base worktree, release the merge dir and mark the state
 *  done, in one section. */
async function reachDone(
  db: Database,
  current: TaskStepRow,
  ctx: StepContext,
  params: AdvanceStepParams,
  state: MergeResolveState,
): Promise<MergeResolved> {
  // The push may fail, so the record and plan the merge brought in are re-synced first.
  const repositoryId =
    state.mode === 'same-branch' ? await taskRepositoryId(db, params.taskId) : null;
  if (repositoryId && (await resyncHaiveProjections(db, repositoryId, state.mergeDir))) {
    state = await restoreKeptMetadataOf(state);
  }
  // Pushes the commit a section read, so a pass that lost the dir cannot send another task's work.
  // Idempotent on re-entry: a completed push reports "up-to-date".
  if (state.pushAfterMerge && !state.pushed) {
    const pushing: MergeResolveState = {
      ...state,
      phase: 'pushing',
      merged: true,
      mergedAt: state.mergedAt ?? new Date().toISOString(),
    };
    const sha = await inMergeDir(db, current, params, state.mergeDir, async (tx) => {
      await saveMergeState(tx, current.id, pushing);
      const tip = await gitRun(ctx.repoPath, [
        'rev-parse',
        '--verify',
        `refs/heads/${state.baseBranch}^{commit}`,
      ]);
      return tip.code === 0 ? tip.stdout.trim() : undefined;
    });
    if (!sha) {
      return haltFailed(
        db,
        current,
        params,
        pushing,
        `could not read ${state.baseBranch}'s tip; the merge is saved locally, retry`,
        'base tip unreadable',
      );
    }
    const fv = (current.formValues ?? {}) as { credentialId?: string; setUpstream?: boolean };
    let upstreamError: string | undefined;
    try {
      ({ upstreamError } = await pushBranch({
        cwd: ctx.repoPath,
        branch: state.baseBranch,
        sha,
        setUpstream: fv.setUpstream !== false,
        credentialId: fv.credentialId || undefined,
        db,
        userId: ctx.userId,
      }));
    } catch (err) {
      const row = await halt(
        db,
        current,
        params,
        pushing,
        `Merge committed, but pushing '${state.baseBranch}' to origin failed: ${
          (err as Error).message
        } The merge is saved locally — retry the push.`,
      );
      return {
        resolved: false,
        result: { status: 'failed', row, error: row.errorMessage ?? 'push failed' },
      };
    }
    if (upstreamError) {
      ctx.logger.warn(
        { branch: state.baseBranch, upstreamError },
        'base branch pushed, but its upstream was not set',
      );
      current = await addStepWarning(
        db,
        current,
        `'${state.baseBranch}' was pushed, but git could not set its upstream: ${upstreamError}`,
      );
    }
    state = { ...pushing, pushed: true };
  }
  const done: MergeResolveState = {
    ...state,
    phase: 'done',
    merged: true,
    mergedAt: state.mergedAt ?? new Date().toISOString(),
  };
  const finished = state;
  const row = await inMergeDir(db, current, params, finished.mergeDir, async (tx) => {
    let updated = current;
    if (finished.mode === 'cross-branch') {
      const kept = await removeBaseWorktree(ctx.repoPath, finished.mergeDir);
      if (kept) {
        ctx.logger.warn(
          { worktree: finished.mergeDir, reason: kept },
          'base worktree kept after merge',
        );
        updated = await addStepWarning(
          tx,
          current,
          `The base worktree ${relUnder(ctx.repoPath, finished.mergeDir)} was kept, since git would not remove it: ${kept}.`,
        );
      }
    }
    await releaseMergeDir(tx, { mergeDir: finished.mergeDir, stepId: current.id });
    await saveMergeState(tx, current.id, done);
    return updated;
  });
  return { resolved: true, current: { ...row, mergeResolveState: done } };
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
  const squash = await squashFeatureMerge(db, current, ctx, params, state);
  let squashed = squash.state;
  if ((squashed.mergeStage ?? 'feature') === 'feature' && squashed.phase !== 'squashing') {
    squashed = { ...squashed, phase: 'squashing', merged: false, mergedAt: undefined };
    await inMergeDir(db, current, params, squashed.mergeDir, (tx) =>
      saveMergeState(tx, current.id, squashed),
    );
  }
  current = squash.current;
  if (
    squashed.pushAfterMerge &&
    !squashed.pushed &&
    (squashed.mergeStage ?? 'feature') === 'feature'
  ) {
    return prePushSync(db, stepDef, current, ctx, params, squashed);
  }
  return reachDone(db, current, ctx, params, squashed);
}

/** Collapse the landed feature merge into ONE commit on the base branch when the form
 *  asked for it (the squash checkbox, ticked by default). Called from finishMerge, which
 *  every merge round funnels through — the clean merge AND both conflict-resolution
 *  paths — which is why completeMergeHostSide needs no squash awareness of its own.
 *
 *  Scoped to the FEATURE round: prePushSync re-enters this resolver with mergeStage
 *  'base-sync' to merge origin/<base> into base, and collapsing THAT would rewrite
 *  upstream commits into a local one and get the push rejected.
 *
 *  Persists phase 'squashing' BEFORE touching git, the way reachDone persists 'pushing'.
 *  Without it a crash between the reset and the commit would re-enter at 'pending',
 *  where the re-run `git merge` fails on the dirty tree and is misread as a conflict. */
async function squashFeatureMerge(
  db: Database,
  current: TaskStepRow,
  ctx: StepContext,
  params: AdvanceStepParams,
  state: MergeResolveState,
): Promise<{ state: MergeResolveState; current: TaskStepRow }> {
  if (!state.squashAfterMerge) return { state, current };
  if ((state.mergeStage ?? 'feature') !== 'feature') return { state, current };
  if (state.squashCommitSha) return { state, current }; // already collapsed
  // A row written before baseShaBefore existed has no reset target. Leaving the merge
  // commit in place is the safe outcome: the work is integrated either way.
  if (!state.baseShaBefore) return { state, current };

  let squashing: MergeResolveState = {
    ...state,
    phase: 'squashing',
    merged: false,
    mergedAt: undefined,
  };
  const userEnv = await resolveGitEnv(db, { userId: ctx.userId, taskId: ctx.taskId });
  const commitEnv = Object.keys(userEnv).length > 0 ? userEnv : FALLBACK_GIT_IDENTITY;
  const message = await buildSquashCommitMessage(db, ctx.taskId, state.featureBranch);
  const baseShaBefore = state.baseShaBefore;
  // Committed ahead of the reset, so a crash between the reset and the commit re-enters here.
  await inMergeDir(db, current, params, squashing.mergeDir, async (tx) => {
    if (!squashing.squashMergeSha) {
      const parents = await gitRun(squashing.mergeDir, [
        'rev-list',
        '--parents',
        '-n',
        '1',
        'HEAD',
      ]);
      const commits = parents.stdout.trim().split(/\s+/);
      const feature = await revParse(squashing.mergeDir, `${squashing.featureBranch}^{commit}`);
      if (
        parents.code === 0 &&
        commits.length === 3 &&
        commits[1] === baseShaBefore &&
        feature !== null &&
        (await isCommitAncestor(squashing.mergeDir, commits[2]!, feature))
      ) {
        squashing = { ...squashing, squashMergeSha: commits[0] };
      }
    }
    await saveMergeState(tx, current.id, squashing);
  });
  let updated = current;
  const next = await inMergeDir(db, current, params, squashing.mergeDir, async (tx) => {
    let skipped: string | undefined;
    const squashCommitSha = await squashMergeCommit(
      squashing.mergeDir,
      baseShaBefore,
      message,
      commitEnv,
      squashing.featureBranch,
      (reason) => {
        skipped = reason;
      },
      squashing.squashMergeSha,
    );
    if (skipped) {
      updated = await addStepWarning(tx, current, skipped);
      await updateOwnedStep(tx, current.id, { statusMessage: skipped });
    }
    const squashed: MergeResolveState = {
      ...squashing,
      squashCommitSha,
      ...(skipped ? { squashAfterMerge: false, squashSkipReason: skipped } : {}),
    };
    await saveMergeState(tx, current.id, squashed);
    return squashed;
  });
  const squashCommitSha = next.squashCommitSha;
  ctx.logger.info(
    {
      featureBranch: state.featureBranch,
      baseBranch: state.baseBranch,
      baseShaBefore: state.baseShaBefore,
      squashCommitSha,
    },
    squashCommitSha
      ? 'feature merge squashed into a single commit on the base branch'
      : (next.squashSkipReason ?? 'squash requested but the merge left nothing to collapse'),
  );
  return { state: next, current: updated };
}

/** Best-effort authenticated `git fetch origin <base>` (same credential the push uses).
 *  Never throws — a failure is surfaced so the caller can warn-and-continue. */
async function fetchForSync(
  db: Database,
  ctx: StepContext,
  cwd: string,
  base: string,
  credentialId: string | undefined,
  fetchRef: string,
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
  argv.push(
    'fetch',
    '--no-write-fetch-head',
    '--refmap=',
    '--no-tags',
    '--end-of-options',
    'origin',
    `refs/heads/${base}:${fetchRef}`,
  );
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
  const refPrefix = `refs/haive/pre-push/${current.id}/`;
  const fetchRef = `${refPrefix}${randomUUID()}`;
  let fetched: Awaited<ReturnType<typeof fetchForSync>>;
  let decision: { behind: number; next: MergeResolveState | null } | undefined;
  try {
    fetched = await fetchForSync(
      db,
      ctx,
      state.mergeDir,
      base,
      fv.credentialId || undefined,
      fetchRef,
    );
    const checked = await inMergeDir<
      { error: string } | { behind: number; next: MergeResolveState | null }
    >(db, current, params, state.mergeDir, async (tx) => {
      const leftovers = await gitRun(state.mergeDir, [
        'for-each-ref',
        '--format=%(refname)',
        refPrefix,
      ]);
      if (leftovers.code === 0) {
        for (const ref of leftovers.stdout
          .trim()
          .split('\n')
          .filter((ref) => ref && ref !== fetchRef)) {
          await gitRun(state.mergeDir, ['update-ref', '-d', ref]);
        }
      }
      if (!fetched.ok) return { error: `fetch failed: ${fetched.error}` };
      const tip = await revParse(state.mergeDir, fetchRef);
      if (!tip) return { error: `could not record origin/${base}: fetched commit unavailable` };
      const promoted = await gitRun(state.mergeDir, [
        'update-ref',
        `refs/remotes/origin/${base}`,
        tip,
      ]);
      if (promoted.code !== 0)
        return {
          error: `could not record origin/${base}: ${promoted.stderr || promoted.stdout}`.trim(),
        };
      const behind = await countAhead(state.mergeDir, `${base}..origin/${base}`);
      if (behind === 0 || (state.baseSyncRounds ?? 0) >= MAX_BASE_SYNC_ROUNDS) {
        return { behind, next: null };
      }
      const next: MergeResolveState = {
        ...state,
        merged: false,
        mergedAt: undefined,
        mergeStage: 'base-sync',
        featureBranch: `origin/${base}`,
        phase: 'pending',
        fixInvocationId: null,
        pendingQuestion: null,
        conflictRetries: 0,
        baseSyncRounds: (state.baseSyncRounds ?? 0) + 1,
      };
      await saveMergeState(tx, current.id, next);
      return { behind, next };
    });
    if ('error' in checked) fetched = { ok: false, error: checked.error };
    else decision = checked;
  } finally {
    await gitRun(state.mergeDir, ['update-ref', '-d', fetchRef]);
  }
  if (!fetched.ok) {
    ctx.logger.warn(
      { base, err: fetched.error },
      `pre-push base sync: ${fetched.error}; pushing the local base as-is`,
    );
    return reachDone(db, current, ctx, params, state);
  }
  const { behind, next } = decision!;
  if (behind === 0) return reachDone(db, current, ctx, params, state);
  if (!next) {
    await settleGivenUp(db, current, params, state);
    const row = await halt(
      db,
      current,
      params,
      state,
      `origin/${base} keeps advancing (${behind} commits behind after ${state.baseSyncRounds ?? 0} sync attempts). Pull ${base} and push it manually — the merge is saved locally.`,
    );
    return {
      resolved: false,
      result: { status: 'failed', row, error: row.errorMessage ?? 'origin moving' },
    };
  }
  return resolveMergePhase(db, stepDef, { ...current, mergeResolveState: next }, ctx, params);
}

/** Haive's own files (the plan and the project state) merge by their own rules before any agent or
 *  person sees the conflict; a merge left with nothing else unmerged is committed here. */
async function settleOwnFiles(
  dir: string,
  feature: string,
  env: Record<string, string>,
): Promise<{ merged: boolean; warnings: string[] }> {
  const { resolved, warnings } = await resolveHaiveProjectionConflicts(dir);
  if (resolved.length === 0) return { merged: false, warnings };
  const left = await unmergedPaths(dir);
  return {
    merged: left?.length === 0 && (await completeMergeHostSide(dir, env, feature)),
    warnings,
  };
}

async function noteOwnFileFallbacks(
  db: Database,
  current: TaskStepRow,
  ctx: StepContext,
  dir: string,
  warnings: string[],
): Promise<TaskStepRow> {
  if (warnings.length === 0) return current;
  ctx.logger.warn({ dir, warnings }, "merge fell back on a side of Haive's own files");
  return addStepWarning(
    db,
    current,
    `Haive's own files in the merge fell back on a side: ${warnings.join('; ')}.`,
  );
}

/** Unmerged paths in a mid-merge worktree (for the fix prompt). */
async function conflictFiles(mergeDir: string): Promise<string[]> {
  return (await unmergedPaths(mergeDir)) ?? [];
}

/** Outcome of dispatching the conflict-resolution agent. `already_live` means a
 *  concurrent advance already holds the one-live-per-step slot; PARK on it. */
type FixAgentDispatch =
  { kind: 'ok'; invId: string } | { kind: 'no_provider' } | { kind: 'already_live' };

/** Dispatch one conflict-resolution agent into the merge worktree's sandbox. Mirrors
 *  dispatchMergeFixAgent in dag-executor.ts, `onInserted` included. */
async function dispatchFixAgent(
  db: Database,
  stepDef: StepDefinition,
  current: TaskStepRow,
  params: AdvanceStepParams,
  spec: MergeResolveSpec,
  state: MergeResolveState,
  guidance: string,
  onInserted: (invocationId: string) => Promise<void>,
  afterTruncation = false,
): Promise<FixAgentDispatch> {
  // Keep this exact value paired between prompt planning and queue payload: an
  // empty override is the repo root (real `.git` directory), while a transient
  // --base worktree receives the zero-byte gitfile boundary.
  const worktreeRel = path.relative(SANDBOX_WORKDIR, state.sandboxMergeDir);
  const augmented = await augmentPromptWithTerseness(
    spec.buildFixPrompt({
      baseBranch: state.baseBranch,
      featureBranch: state.featureBranch,
      conflictFiles: await conflictFiles(state.mergeDir),
      guidance,
    }) + FIX_RESULT_CONTRACT,
  );
  const prompt = afterTruncation ? `${augmented}\n\n${TRUNCATION_RETRY_NOTICE}` : augmented;
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
    houseRules: houseRulesOptOut(
      'a merge fixer reconciles existing histories, it writes no new code',
    ),
    invokeOpts: { cwd: state.sandboxMergeDir, effortLevel: preferredEffort ?? undefined },
  });
  if (plan.mode === 'skip' || !plan.invocation || plan.invocation.kind !== 'cli') {
    return { kind: 'no_provider' };
  }
  // A per-step SINGLETON: the one-live-per-step index rejects a second concurrent
  // dispatch. Surface that distinctly rather than throwing or reporting no_provider.
  let invId: string;
  try {
    ({ id: invId } = await insertOwnedRun(db, current.id, {
      taskId: params.taskId,
      taskStepId: current.id,
      cliProviderId: plan.providerId,
      effort: plan.effort ?? null,
      assignedAgentIds: plan.invocation?.spec.assignedAgentIds ?? [],
      mode: 'cli',
      prompt: plan.effectivePrompt ?? prompt,
      truncationRetry: afterTruncation,
    }));
  } catch (err) {
    if (isUniqueViolation(err)) return { kind: 'already_live' };
    throw err;
  }
  await onInserted(invId);
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
    timeoutMs: overrideOr(current, spec.timeoutMs ?? MERGE_FIX_TIMEOUT_MS),
  });
  return { kind: 'ok', invId };
}

async function halt(
  db: Database,
  current: TaskStepRow,
  params: AdvanceStepParams,
  state: MergeResolveState | null,
  message: string,
  beforeRecord?: (tx: DbHandle) => Promise<void>,
): Promise<TaskStepRow> {
  const record = (conn: DbHandle) =>
    setStepStatus(conn, current.id, {
      status: 'failed',
      errorMessage: message,
      endedAt: new Date(),
    });
  if (!state) {
    return db.transaction(async (tx) => {
      if (beforeRecord) await beforeRecord(tx);
      return record(tx);
    });
  }
  return inMergeDir(db, current, params, state.mergeDir, async (tx) => {
    const open = await gitRun(state.mergeDir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
    const baseline = state.fixBaseline;
    const feature =
      open.code === 0 ? await revParse(state.mergeDir, `${state.featureBranch}^{commit}`) : null;
    const mergeHead = open.stdout.trim();
    let own =
      open.code === 0 &&
      ((baseline && 'mergeHead' in baseline && mergeHead === baseline.mergeHead) ||
        mergeHead === feature);
    if (!own && open.code === 0 && feature !== null) {
      try {
        own = await isCommitAncestor(state.mergeDir, mergeHead, feature);
      } catch {
        own = true;
      }
    }
    if (beforeRecord) await beforeRecord(tx);
    const landedUnpushed =
      !state.pushed &&
      (state.phase === 'squashing' ||
        state.phase === 'pushing' ||
        state.mergeStage === 'base-sync');
    if (!landedUnpushed && (open.code === 1 || (open.code === 0 && feature !== null && !own))) {
      await releaseMergeDir(tx, { mergeDir: state.mergeDir, stepId: current.id });
    }
    return record(tx);
  });
}

export async function haltFailed(
  db: Database,
  current: TaskStepRow,
  params: AdvanceStepParams,
  state: MergeResolveState | null,
  message: string,
  fallback: string,
  beforeRecord?: (tx: DbHandle) => Promise<void>,
): Promise<MergeResolved> {
  const row = await halt(db, current, params, state, message, beforeRecord);
  return {
    resolved: false,
    result: { status: 'failed', row, error: row.errorMessage ?? fallback },
  };
}

/** A merge git refused opened nothing, so there is no conflict a fixer could resolve. */
function haltRefused(
  db: Database,
  current: TaskStepRow,
  params: AdvanceStepParams,
  state: MergeResolveState,
  detail: string,
): Promise<MergeResolved> {
  return haltFailed(
    db,
    current,
    params,
    state,
    `git refused to merge ${state.featureBranch} into ${state.baseBranch}: ${detail}. Nothing was merged; clear what git names, then retry.`,
    'merge refused',
  );
}

/** 12 only; skipped in a base-sync round and with the feature's merge open, whose tip must not move. */
async function putBackBeforeFeatureMerge(
  db: Database,
  spec: MergeResolveSpec,
  current: TaskStepRow,
  params: AdvanceStepParams,
  ctx: StepContext,
  state: MergeResolveState,
  worktreePath: string | null,
): Promise<{ current: TaskStepRow } | { halted: MergeResolved }> {
  if (!spec.putBackBeforeMerge || (state.mergeStage ?? 'feature') !== 'feature') return { current };
  if (await mergeOpenFor(state.mergeDir, state.featureBranch)) return { current };
  let notes: string[];
  try {
    notes = await spec.putBackBeforeMerge({
      ctx,
      worktreePath,
      featureBranch: state.featureBranch,
      baseBranch: state.baseBranch,
    });
  } catch (err) {
    const message = `Nothing was merged: ${err instanceof Error ? err.message : String(err)}`;
    return {
      halted: await haltFailed(db, current, params, state, message, 'haive files not put back'),
    };
  }
  let updated = current;
  for (const note of notes) updated = await addStepWarning(db, updated, note);
  return { current: updated };
}

/** Halt on a merge that could not be aborted, since a fixer dispatched into it would start from
 *  whatever the last one left. `why` is the halt the abort was part of, when there was one. */
async function haltUnaborted(
  db: Database,
  current: TaskStepRow,
  params: AdvanceStepParams,
  state: MergeResolveState,
  abort: Extract<MergeAbort, { ok: false }>,
  why?: string,
): Promise<MergeResolved> {
  const note = abortFailureNote(abort);
  return haltFailed(
    db,
    current,
    params,
    state,
    why ? `${why} ${note}` : note,
    'merge abort failed',
    async (tx) => {
      await tx.insert(schema.taskEvents).values({
        taskId: params.taskId,
        taskStepId: current.id,
        eventType: 'merge.abort_failed',
        payload: {
          featureBranch: state.featureBranch,
          baseBranch: state.baseBranch,
          blocking: abort.blocking.slice(0, 20),
          detail: abort.detail,
        },
      });
    },
  );
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
  const worktreePath =
    ((current.detectOutput ?? {}) as { worktreePath?: string | null }).worktreePath ?? null;
  if (!spec.selectedMerge(formValues)) {
    // keep / remove_only — no merge; apply handles the worktree.
    return { resolved: true, current };
  }

  const userEnv = await resolveGitEnv(db, { userId: ctx.userId, taskId: ctx.taskId });
  const commitEnv = Object.keys(userEnv).length > 0 ? userEnv : FALLBACK_GIT_IDENTITY;

  let state = current.mergeResolveState as MergeResolveState | null;
  const section = <T>(mergeDir: string, fn: (tx: Tx) => Promise<T>) =>
    inMergeDir(db, current, params, mergeDir, fn);

  // Haive's pending projection files are set aside while a merge opens in the checkout,
  // since git refuses a merge over them.
  const kept: KeptFiles = new Map();
  const mergeDirOwner = (mergeDir: string) => ({
    mergeDir,
    stepId: current.id,
    taskId: params.taskId,
    epoch: params.epoch,
  });
  const putBackSection =
    (mergeDir: string): RestoreSection =>
    (fn) =>
      inMergeDirUnlessClaimed(db, mergeDirOwner(mergeDir), fn);
  /** Tasks working in the checkout itself (no worktree of their own) have their tree changed by a merge opened there. */
  const othersIn = (conn: Parameters<typeof checkoutHoldingTasks>[0], repositoryId: string) =>
    checkoutHoldingTasks(conn, repositoryId, { excludeTaskId: params.taskId, rootOnly: true });
  /** Why the files cannot be set aside, or null once they are. */
  const setAside = async (repositoryId: string, dir: string) => {
    let aside;
    try {
      aside = await setAsideHaiveProjections(
        db,
        repositoryId,
        dir,
        (conn) => othersIn(conn, repositoryId),
        {
          restore: (fn) => withMergeDirSection(db, mergeDirOwner(dir), fn),
          putBack: putBackSection(dir),
        },
      );
    } catch (err) {
      if (kept.size > 0) {
        await putBackAfterFailure(db, repositoryId, dir, kept, err, putBackSection(dir));
      }
      throw err;
    }
    if (aside.outcome === 'set-aside') {
      for (const [file, was] of aside.kept) if (!kept.has(file)) kept.set(file, was);
    }
    return aside.outcome === 'refused' || aside.outcome === 'held' ? aside : null;
  };
  /** Under the projection locks, before a section opens a merge: the files still clean, then no one working in the checkout. */
  const beforeOpen = async (tx: Tx, repositoryId: string | null, dir: string) => {
    if (!repositoryId) return null;
    const again = await restoreProjectionsInTx(tx, repositoryId, dir);
    if (again.outcome !== 'clean') return again;
    const holding = await othersIn(tx, repositoryId);
    return holding > 0 ? { outcome: 'held' as const, holding } : null;
  };
  const putBack = async (repositoryId: string | null, dir: string): Promise<void> => {
    if (repositoryId) await putBackProjections(db, repositoryId, dir, kept, putBackSection(dir));
  };
  /** A throw from `fn` puts the set-aside files back, or re-syncs them once HEAD has moved. */
  const mergeSection = async <T>(
    repositoryId: string | null,
    dir: string,
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> => {
    const before = repositoryId ? ((await revParse(dir, 'HEAD')) ?? '') : '';
    try {
      return await section(dir, fn);
    } catch (err) {
      if (repositoryId && kept.size > 0) {
        await recoverAfterMoveFailure(
          db,
          repositoryId,
          dir,
          kept,
          before,
          err,
          putBackSection(dir),
        );
      }
      throw err;
    }
  };
  const withKept = (from: MergeResolveState): MergeResolveState => {
    const metadata = { ...keptMetadataOf(kept), ...from.keptMetadata };
    return Object.keys(metadata).length > 0 ? { ...from, keptMetadata: metadata } : from;
  };
  /** Saves into this step what a cancelled task's set-aside kept for the merge it left open in
   *  `dir`, committed before that merge is aborted: once it is, nothing finds that task again. */
  const takeStaleKept = (dir: string, stale: OpenMerge): Promise<KeptMetadata> =>
    takeLeftOpenKept(db, params.taskId, dir, stale, async (kept) => {
      const row = await db.query.taskSteps.findFirst({
        where: eq(schema.taskSteps.id, current.id),
        columns: { mergeResolveState: true },
      });
      await saveMergeState(db, current.id, adoptKept(row!.mergeResolveState!, kept));
    });

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
      // Squash is ticked by default, so an ABSENT value opts in (the `setUpstream !==
      // false` reading, not `pushBase === true`): a task whose form_schema was persisted
      // before the checkbox existed carries no key, and the collapsed tree is identical
      // either way. `spec.squashable` is what keeps this off the steps that merge
      // origin's own commits.
      squashAfterMerge: spec.squashable === true && formValues.squashMerge !== false,
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
    // The shared base worktree is created, and the base tip measured, under the merge-dir lock below.
    if (base && parentBranch && parentBranch !== base) {
      const wt = baseWorktreePaths(ctx, base);
      state = {
        ...base0,
        mode: 'cross-branch',
        phase: 'pending',
        mergeDir: wt.worktreePath,
        sandboxMergeDir: wt.sandboxWorktreePath,
      };
    } else {
      state = { ...base0, phase: 'pending' };
    }
    await saveMergeState(db, current.id, state);
  }

  if (state.phase !== 'done') {
    const claim = await claimMergeDir(db, {
      mergeDir: state.mergeDir,
      stepId: current.id,
      taskId: params.taskId,
      epoch: params.epoch,
    });
    if (claim.kind === 'held') {
      return haltFailed(
        db,
        current,
        params,
        null,
        `Task "${claim.holder.title}" (${claim.holder.id}) is still merging into ${state.baseBranch} in ${state.mergeDir}; retry once it finishes.`,
        'merge dir in use',
      );
    }
  }

  // --- pending: attempt the merge; clean -> done, conflict -> resolving (live) ---
  if (state.phase === 'pending') {
    let pending = state;
    const putBackFirst = await putBackBeforeFeatureMerge(
      db,
      spec,
      current,
      params,
      ctx,
      pending,
      worktreePath,
    );
    if ('halted' in putBackFirst) return putBackFirst.halted;
    current = putBackFirst.current;
    const repositoryId =
      pending.mode === 'same-branch' ? await taskRepositoryId(db, params.taskId) : null;
    // A plan row stamped before 0196 takes its base from the checkout before the merge moves it.
    if (repositoryId && !(await peekOpenMerge(pending.mergeDir))) {
      try {
        await seedPlanBaseFromCheckout(db, repositoryId, pending.mergeDir);
      } catch (err) {
        await settleGivenUp(db, current, params, pending);
        return haltFailed(
          db,
          current,
          params,
          state,
          `The plan's base could not be read from the checkout (${(err as Error).message}); nothing was merged. Retry this step.`,
          'plan base unread',
        );
      }
      const stopped = await setAside(repositoryId, pending.mergeDir);
      if (stopped !== null) {
        await settleGivenUp(db, current, params, pending);
        return haltFailed(db, current, params, state, asideHalt(stopped), 'haive files changed');
      }
    }
    const openPending = async (tx: Tx) => {
      // Every task creates or removes the shared base worktree only in a section.
      if (pending.mode === 'cross-branch') {
        await ensureBaseWorktree(ctx, pending.mergeDir, pending.baseBranch);
      }
      // Every task's start and every revival take this lock, so none lands between the fence and the open.
      if (repositoryId) await lockRepositoryTasksKey(tx, repositoryId);
      // The base tip before ANY merge round: the squash resets back to it, and it is the
      // documented undo point, measured in the dir the merge runs in.
      let armed = withKept(pending);
      if (!armed.baseShaBefore) {
        const baseHead = await gitRun(armed.mergeDir, ['rev-parse', 'HEAD']);
        if (baseHead.code === 0) armed = { ...armed, baseShaBefore: baseHead.stdout.trim() };
      }
      // This pass has opened no merge yet, so a merge open here is an earlier attempt's.
      const staleOpen = await peekOpenMerge(armed.mergeDir);
      // Clearing that merge moves the tree as opening one does.
      const crowded = staleOpen && repositoryId ? await othersIn(tx, repositoryId) : 0;
      if (crowded > 0) {
        return {
          kind: 'aside' as const,
          again: { outcome: 'held' as const, holding: crowded },
          armed,
          staleOpen: null,
          adopted: {},
        };
      }
      const held = staleOpen
        ? await relocateLeftOpenFixers(db, params.taskId, armed.mergeDir, staleOpen)
        : null;
      if (held) return { kind: 'held' as const, held, armed, adopted: {} };
      const adopted = staleOpen ? await takeStaleKept(armed.mergeDir, staleOpen) : {};
      armed = adoptKept(armed, adopted);
      const cleared = await abortOtherMerge(armed.mergeDir, armed.featureBranch);
      const stale = cleared.ok ? await abortMerge(armed.mergeDir) : cleared;
      if (!stale.ok) return { kind: 'unaborted' as const, stale, armed, adopted };
      // Under the projection locks, so no sweep rewrites a file between this check and the merge.
      const again = await beforeOpen(tx, repositoryId, armed.mergeDir);
      if (again) return { kind: 'aside' as const, again, armed, staleOpen, adopted };
      const opened = await openMerge(
        armed.mergeDir,
        armed.featureBranch,
        ['-m', `Merge ${armed.featureBranch}`],
        commitEnv,
      );
      const settled =
        opened.kind === 'conflict'
          ? await settleOwnFiles(armed.mergeDir, armed.featureBranch, commitEnv)
          : { merged: false, warnings: [] };
      const result: MergeOpen = settled.merged ? { kind: 'merged' } : opened;
      // Recorded in the same transaction, so a landed merge the squash has yet to reset is held too.
      if (result.kind !== 'refused') {
        await saveMergeState(tx, current.id, { ...armed, phase: 'resolving' });
      }
      return {
        kind: 'opened' as const,
        opened: result,
        armed,
        staleOpen,
        warnings: settled.warnings,
        adopted,
      };
    };
    let attempt = await mergeSection(repositoryId, pending.mergeDir, openPending);
    pending = adoptKept(pending, attempt.adopted);
    // A file Haive rewrote since the set-aside sends it round again.
    for (
      let round = 1;
      repositoryId &&
      attempt.kind === 'aside' &&
      attempt.again.outcome === 'retry' &&
      round < MOVE_ATTEMPTS;
      round++
    ) {
      if (attempt.staleOpen) {
        current = await noteAbortedByNext(
          db,
          current,
          params.taskId,
          pending.mergeDir,
          attempt.staleOpen,
        );
      }
      const stopped = await setAside(repositoryId, pending.mergeDir);
      if (stopped !== null) {
        await putBack(repositoryId, pending.mergeDir);
        await settleGivenUp(db, current, params, pending);
        return haltFailed(db, current, params, state, asideHalt(stopped), 'haive files changed');
      }
      attempt = await mergeSection(repositoryId, pending.mergeDir, openPending);
      pending = adoptKept(pending, attempt.adopted);
    }
    state = attempt.armed;
    if (attempt.kind === 'unaborted') {
      await putBack(repositoryId, state.mergeDir);
      await settleGivenUp(db, current, params, pending);
      return haltUnaborted(db, current, params, state, attempt.stale);
    }
    if (attempt.kind === 'held') {
      await putBack(repositoryId, state.mergeDir);
      await settleGivenUp(db, current, params, pending);
      return haltFailed(db, current, params, state, attempt.held, 'merge index held');
    }
    if (attempt.staleOpen) {
      current = await noteAbortedByNext(
        db,
        current,
        params.taskId,
        state.mergeDir,
        attempt.staleOpen,
      );
    }
    if (attempt.kind === 'aside') {
      await putBack(repositoryId, state.mergeDir);
      await settleGivenUp(db, current, params, pending);
      return haltFailed(
        db,
        current,
        params,
        state,
        asideHalt(attempt.again),
        'haive files changed',
      );
    }
    if (attempt.kind === 'opened') {
      current = await noteOwnFileFallbacks(db, current, ctx, state.mergeDir, attempt.warnings);
    }
    if (attempt.opened.kind === 'merged') {
      return finishMerge(db, stepDef, current, ctx, params, state);
    }
    if (attempt.opened.kind === 'refused') {
      await putBack(repositoryId, state.mergeDir);
      await settleGivenUp(db, current, params, pending);
      return haltRefused(db, current, params, state, attempt.opened.detail);
    }
    // Conflict: leave the mid-merge LIVE (no --abort) so the fix agent edits it.
    state = { ...state, phase: 'resolving' };
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
    let truncatedOnce = false;
    // (1) Ingest an in-flight fix agent.
    if (state.fixInvocationId) {
      const inv = await db.query.cliInvocations.findFirst({
        where: eq(schema.cliInvocations.id, state.fixInvocationId),
      });
      if (!inv || runIsLive(inv)) {
        return { resolved: false, result: { status: 'waiting_cli', row: current } };
      }
      if (inv.supersededAt != null) await assertOwnsStep(db, current.id);
      const ingesting = state;
      const maskSource = await maskSourceOnce(db, params.taskId);
      const relocated = await section(ingesting.mergeDir, async (tx) => {
        const found = await relocateFixerChanges(
          ingesting.mergeDir,
          ingesting.fixBaseline,
          { taskId: params.taskId, runId: inv.id },
          maskSource,
        );
        // Spent once used: a later pass comparing it with a tree the merge has since left would put
        // the merge's files back. Kept while the index still holds what the fixer staged, for the retry.
        if (ingesting.fixBaseline && !found?.indexHeld) {
          const spent = { ...ingesting, fixBaseline: null };
          await saveMergeState(tx, current.id, spent);
          return { leftovers: found, state: spent };
        }
        return { leftovers: found, state: ingesting };
      });
      const leftovers = relocated.leftovers;
      state = relocated.state;
      if (leftovers) {
        await recordFixerLeftovers(db, params.taskId, current.id, state.featureBranch, leftovers);
        current = await addStepWarning(
          db,
          current,
          fixerLeftoversWarning(params.taskId, leftovers),
        );
      }
      if (leftovers?.indexHeld) {
        return haltFailed(
          db,
          current,
          params,
          state,
          fixerIndexHeldNote(leftovers.indexHeld),
          'merge index held',
        );
      }
      const fix = parseFixResult(inv);
      const lastFixerCut =
        !runNeverAnswered(inv) && isOutputTruncationMessage(inv.errorMessage?.trim());
      // Saved with the state below, so a person's later "Retry with AI" keeps the shrink notice.
      if (lastFixerCut) state = { ...state, lastFixerCut: true };
      truncatedOnce = lastFixerCut && !inv.truncationRetry;
      if ((runNeverAnswered(inv) && !fix) || truncatedOnce) {
        // A fixer that never answered, or was cut at the output limit, may have left the merge
        // half-resolved, so its edits are discarded and it is dispatched again without spending an attempt.
        await db
          .update(schema.cliInvocations)
          .set({ consumedAt: new Date() })
          .where(eq(schema.cliInvocations.id, inv.id));
        const refunded: MergeResolveState = {
          ...state,
          fixInvocationId: null,
          conflictRetries: Math.max(0, state.conflictRetries - 1),
        };
        const aborted = await section(refunded.mergeDir, async (tx) => {
          const result = await abortMerge(refunded.mergeDir);
          await saveMergeState(tx, current.id, refunded);
          return result;
        });
        state = refunded;
        if (!aborted.ok) return haltUnaborted(db, current, params, state, aborted);
      } else {
        // Fatal provider failure (rate-limit/quota, bad/expired auth, 5xx outage) will
        // not recover this run — abort the live merge and fail instead of spending the
        // remaining conflictRetries re-dispatching against a dead provider. "Retry with
        // AI" re-creates the conflict on demand once the provider is back.
        if (isFatalProviderFailure(inv.errorMessage)) {
          await db
            .update(schema.cliInvocations)
            .set({ consumedAt: new Date() })
            .where(eq(schema.cliInvocations.id, inv.id));
          const failedDir = state.mergeDir;
          const aborted = await section(failedDir, () => abortMerge(failedDir));
          const why = inv.errorMessage ?? 'fatal provider error';
          if (!aborted.ok) return haltUnaborted(db, current, params, state, aborted, why);
          await settleGivenUp(db, current, params, state);
          return haltFailed(db, current, params, state, why, 'fatal provider error');
        }
        await db
          .update(schema.cliInvocations)
          .set({ consumedAt: new Date() })
          .where(eq(schema.cliInvocations.id, inv.id));
        // A fixer that crashed, timed out or failed on its own may have left a partial edit; a
        // superseded one that answered keeps its answer.
        const usable = inv.supersededAt != null || runFinishedCleanly(inv);
        // The agent may have signaled it cannot confidently resolve → ask the user.
        if (usable && fix?.status === 'uncertain') {
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
        const completing = state;
        const committed =
          usable &&
          (await section(completing.mergeDir, () =>
            completeMergeHostSide(completing.mergeDir, commitEnv, completing.featureBranch),
          ));
        const idle: MergeResolveState = { ...state, fixInvocationId: null };
        state = idle;
        if (committed) {
          return finishMerge(db, stepDef, current, ctx, params, state);
        }
        // Unusable, or markers remain → abort this attempt; the dispatch decision below retries or
        // halts, and the attempt stays spent.
        const aborted = await section(idle.mergeDir, async (tx) => {
          const result = await abortMerge(idle.mergeDir);
          await saveMergeState(tx, current.id, idle);
          return result;
        });
        if (!aborted.ok) return haltUnaborted(db, current, params, state, aborted);
      }
    }

    // (2) Dispatch decision. A merge finished by hand after a halt finishes the step here, before
    // any halt below can fire again. Abort the live merge before halting so a failed phase never
    // leaves the parent repo stuck mid-merge (a later "Retry with AI" re-creates the conflict on
    // demand).
    if (await mergeCommitted(state.mergeDir, state.featureBranch)) {
      return finishMerge(db, stepDef, current, ctx, params, state);
    }
    const dir = state.mergeDir;
    if (state.conflictRetries >= MAX_MERGE_CONFLICT_RETRIES) {
      const aborted = await section(dir, () => abortMerge(dir));
      const why = `Merge conflict merging ${state.featureBranch} into ${state.baseBranch}: auto-resolution exhausted after ${MAX_MERGE_CONFLICT_RETRIES} attempts. Resolve manually or use "Retry with AI".`;
      if (!aborted.ok) return haltUnaborted(db, current, params, state, aborted, why);
      await settleGivenUp(db, current, params, state);
      return haltFailed(db, current, params, state, why, 'merge conflict');
    }
    if (!params.providers || !params.deps) {
      const aborted = await section(dir, () => abortMerge(dir));
      const why = 'Merge conflict requires a CLI provider to resolve, but none were supplied.';
      if (!aborted.ok) return haltUnaborted(db, current, params, state, aborted, why);
      await settleGivenUp(db, current, params, state);
      return haltFailed(db, current, params, state, why, 'no provider');
    }
    // Recreate the live merge if it isn't open (after an abort or a crash). One open for another
    // ref is not this conflict, and a fixer must never be sent into it.
    const feature = state.featureBranch;
    const baselineSource = await maskSourceOnce(db, params.taskId);
    const repositoryId =
      state.mode === 'same-branch' ? await taskRepositoryId(db, params.taskId) : null;
    const putBackFirst = await putBackBeforeFeatureMerge(
      db,
      spec,
      current,
      params,
      ctx,
      state,
      worktreePath,
    );
    if ('halted' in putBackFirst) return putBackFirst.halted;
    current = putBackFirst.current;
    if (repositoryId && !(await peekOpenMerge(dir))) {
      const stopped = await setAside(repositoryId, dir);
      if (stopped !== null) {
        await settleGivenUp(db, current, params, state);
        return haltFailed(db, current, params, state, asideHalt(stopped), 'haive files changed');
      }
    }
    const reopen = async (tx: Tx) => {
      if (repositoryId) await lockRepositoryTasksKey(tx, repositoryId);
      const wasOpen = await peekOpenMerge(dir);
      const ours = wasOpen !== null && (await mergeOpenFor(dir, feature));
      // Clearing a merge for another ref moves the tree as opening one does.
      const crowded = wasOpen && !ours && repositoryId ? await othersIn(tx, repositoryId) : 0;
      if (crowded > 0) {
        return {
          kind: 'aside' as const,
          again: { outcome: 'held' as const, holding: crowded },
          staleOpen: null,
          adopted: {},
        };
      }
      const held = wasOpen ? await relocateLeftOpenFixers(db, params.taskId, dir, wasOpen) : null;
      if (held) return { kind: 'held' as const, held, adopted: {} };
      const staleOpen = ours ? null : wasOpen;
      const adopted = staleOpen ? await takeStaleKept(dir, staleOpen) : {};
      const cleared = await abortOtherMerge(dir, feature);
      if (!cleared.ok) return { kind: 'unaborted' as const, cleared, adopted };
      if (!(await mergeOpenFor(dir, feature))) {
        const again = await beforeOpen(tx, repositoryId, dir);
        if (again) return { kind: 'aside' as const, again, staleOpen, adopted };
        const opened = await openMerge(dir, feature, ['-m', `Merge ${feature}`], commitEnv);
        if (opened.kind === 'merged') {
          return { kind: 'merged' as const, staleOpen, warnings: [], adopted };
        }
        if (opened.kind === 'refused') {
          return { kind: 'refused' as const, detail: opened.detail, staleOpen, adopted };
        }
      }
      const settled = await settleOwnFiles(dir, feature, commitEnv);
      if (settled.merged) {
        return { kind: 'merged' as const, staleOpen, warnings: settled.warnings, adopted };
      }
      return {
        kind: 'ready' as const,
        fixBaseline: await captureFixBaseline(dir, baselineSource),
        staleOpen,
        warnings: settled.warnings,
        adopted,
      };
    };
    let reopened = await mergeSection(repositoryId, dir, reopen);
    state = adoptKept(state, reopened.adopted);
    for (
      let round = 1;
      repositoryId &&
      reopened.kind === 'aside' &&
      reopened.again.outcome === 'retry' &&
      round < MOVE_ATTEMPTS;
      round++
    ) {
      if (reopened.staleOpen) {
        current = await noteAbortedByNext(db, current, params.taskId, dir, reopened.staleOpen);
      }
      const stopped = await setAside(repositoryId, dir);
      if (stopped !== null) {
        await putBack(repositoryId, dir);
        await settleGivenUp(db, current, params, state);
        return haltFailed(db, current, params, state, asideHalt(stopped), 'haive files changed');
      }
      reopened = await mergeSection(repositoryId, dir, reopen);
      state = adoptKept(state, reopened.adopted);
    }
    if (reopened.kind === 'unaborted') {
      await putBack(repositoryId, dir);
      await settleGivenUp(db, current, params, state);
      return haltUnaborted(db, current, params, state, reopened.cleared);
    }
    if (reopened.kind === 'held') {
      await putBack(repositoryId, dir);
      await settleGivenUp(db, current, params, state);
      return haltFailed(db, current, params, state, reopened.held, 'merge index held');
    }
    if (reopened.staleOpen) {
      current = await noteAbortedByNext(db, current, params.taskId, dir, reopened.staleOpen);
    }
    if (reopened.kind === 'aside') {
      await putBack(repositoryId, dir);
      await settleGivenUp(db, current, params, state);
      return haltFailed(
        db,
        current,
        params,
        state,
        asideHalt(reopened.again),
        'haive files changed',
      );
    }
    if (reopened.kind !== 'refused') {
      current = await noteOwnFileFallbacks(db, current, ctx, dir, reopened.warnings);
    }
    state = withKept(state);
    if (reopened.kind === 'merged') return finishMerge(db, stepDef, current, ctx, params, state);
    if (reopened.kind === 'refused') {
      await putBack(repositoryId, dir);
      await settleGivenUp(db, current, params, state);
      return haltRefused(db, current, params, state, reopened.detail);
    }
    const fixBaseline = reopened.fixBaseline;
    const guidance = await loadOutstandingMergeGuidance(db, params.taskId);
    // A const alias so the closure below keeps TypeScript's narrowing of `state` to
    // non-null (a `let` loses that narrowing across a function boundary).
    const priorState = state;
    // onInserted runs after the insert and before the enqueue, so no run can start that
    // `state` does not name.
    const dispatched = await dispatchFixAgent(
      db,
      stepDef,
      current,
      params,
      spec,
      state,
      guidance,
      async (invId) => {
        state = {
          ...priorState,
          fixInvocationId: invId,
          conflictRetries: priorState.conflictRetries + 1,
          fixBaseline,
          lastFixerCut: false,
        };
        await saveMergeState(db, current.id, state);
      },
      priorState.lastFixerCut === true,
    );
    if (dispatched.kind === 'already_live') {
      // A concurrent advance already dispatched and saved its own fixInvocationId; PARK
      // on it rather than abort its merge or overwrite its state.
      const row = await setStepStatus(db, current.id, {
        status: 'waiting_cli',
        statusMessage: `Resolving merge conflict (${state.featureBranch} → ${state.baseBranch}) with AI…`,
      });
      return { resolved: false, result: { status: 'waiting_cli', row } };
    }
    if (dispatched.kind === 'no_provider') {
      const aborted = await section(dir, () => abortMerge(dir));
      const why = 'No CLI provider available for merge conflict resolution.';
      if (!aborted.ok) return haltUnaborted(db, current, params, state, aborted, why);
      await settleGivenUp(db, current, params, state);
      return haltFailed(db, current, params, state, why, 'no provider');
    }
    // 'ok': the onInserted hook above already saved state.fixInvocationId.
    const row = await setStepStatus(db, current.id, {
      status: 'waiting_cli',
      statusMessage: `Resolving merge conflict (${state.featureBranch} → ${state.baseBranch}) with AI…`,
    });
    return { resolved: false, result: { status: 'waiting_cli', row } };
  }

  // Crash-recovery: a squash persisted as in-flight re-runs idempotently — the helper
  // finishes a proven half-done reset or recognises a completed squash by its parents
  // and tree, without resetting or recommitting it.
  if (state.phase === 'squashing') {
    return finishMerge(db, stepDef, current, ctx, params, state);
  }

  // Crash-recovery: a push persisted as in-flight ('pushing') re-runs idempotently
  // (a completed push reports "up-to-date").
  if (state.phase === 'pushing') {
    return reachDone(db, current, ctx, params, state);
  }

  // phase 'done' → proceed to apply, which reads the terminal state.
  return { resolved: true, current: { ...current, mergeResolveState: state } };
}
