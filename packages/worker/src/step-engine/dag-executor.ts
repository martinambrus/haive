import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { and, asc, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  dagIssueResultSchema,
  reviewerOutputSchema,
  advisorOutputSchema,
  replannerOutputSchema,
  type ReviewerOutput,
  type AdvisorOutput,
  type ReplannerOutput,
} from '@haive/shared';
import type { StepCapability } from '@haive/shared';
import { resolveDispatch } from '../orchestrator/dispatcher.js';
import { resolveUserGitEnv } from '../secrets/user-git-identity.js';
import { extractFencedJson } from './steps/_fenced-json.js';
import { buildMergeFixPrompt, completeMergeHostSide } from './git-merge.js';
import { loadPreviousStepOutput, pathExists } from './steps/onboarding/_helpers.js';
import { isFatalProviderFailure } from '../queues/cli-exec/failure-class.js';
import { killCliSandboxesForTask } from '../sandbox/sandbox-kill.js';
import type { DagCoderContext, StepContext, StepDefinition } from './step-definition.js';
import type { CliProviderRecord } from '../cli-adapters/types.js';
import { resolvePreferredCli } from './step-runner.js';
import type {
  AdvanceStepParams,
  AdvanceStepResult,
  TaskStepRow,
  WorkerDeps,
} from './step-runner.js';

// Drives the persisted DAG (Phase 3) one dependency level per ADVANCE_STEP
// re-entry. All decisions are a pure function of the task_dag_* rows so a crash
// + redelivery resumes correctly — the same contract as resolveAgentMiningPhase.
// Per level: create N sibling worktrees -> dispatch one coder per issue (bounded
// by the cli-exec queue) -> waiting_cli barrier -> ingest results -> commit +
// merge each branch into the integration branch -> cleanup worktrees ->
// checkpoint -> advance. The current level is derived as the lowest level whose
// checkpoint_at is null (never a mutable scalar).

const exec = promisify(execFile);

export type DagResolved =
  | { resolved: true; current: TaskStepRow }
  | { resolved: false; result: AdvanceStepResult };

type DagIssueRow = typeof schema.taskDagIssues.$inferSelect;
type DagLevelRow = typeof schema.taskDagLevels.$inferSelect;
type DagPlanRow = typeof schema.taskDagPlans.$inferSelect;

const FALLBACK_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Haive',
  GIT_AUTHOR_EMAIL: 'worker@haive.local',
  GIT_COMMITTER_NAME: 'Haive',
  GIT_COMMITTER_EMAIL: 'worker@haive.local',
};

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

interface IntegrationWorktree {
  /** Worker-absolute path to the task's feature-branch worktree (merge target). */
  path: string;
  /** The feature branch issue branches fork from and merge into. */
  branch: string;
  /** Sandbox cwd for the merge-conflict fix agent (the same worktree). */
  sandboxPath: string;
}

async function loadIntegrationWorktree(db: Database, taskId: string): Promise<IntegrationWorktree> {
  const wt = await loadPreviousStepOutput(db, taskId, '01-worktree-setup');
  const out = wt?.output as {
    worktreePath?: string;
    branchName?: string;
    sandboxWorktreePath?: string;
  } | null;
  if (!out?.worktreePath || !out.branchName) {
    throw new Error('06c-dag-execute requires 01-worktree-setup to have produced a worktree');
  }
  return {
    path: out.worktreePath,
    branch: out.branchName,
    sandboxPath: out.sandboxWorktreePath ?? out.worktreePath,
  };
}

/** A sibling worktree dir + branch for one issue. Sibling (not nested) of the
 *  integration worktree so it isn't a worktree-inside-a-worktree. Lives under
 *  .haive/ (git-excluded) and under the repo root (so the sandbox mount sees it). */
export function issuePaths(ctx: StepContext, integration: IntegrationWorktree, issueKey: string) {
  // Double-dash, NOT a slash: an issue branch `<branch>/<issue>` would collide
  // with the integration branch ref `<branch>` (git stores refs as files, so
  // refs/heads/<branch> being a file blocks creating refs/heads/<branch>/<issue>).
  const branchName = `${integration.branch}--${issueKey}`;
  // The integration branch may be namespaced (feature/…, fix/…); flatten its slash
  // for the on-disk dir so the worktree stays one level under .haive/worktrees
  // (the branch ref keeps the slash).
  const dirName = branchName.replace(/\//g, '-');
  return {
    worktreePath: `${ctx.repoPath}/.haive/worktrees/${dirName}`,
    sandboxWorktreePath: `${ctx.sandboxWorkdir}/.haive/worktrees/${dirName}`,
    branchName,
  };
}

async function createIssueWorktree(
  ctx: StepContext,
  integration: IntegrationWorktree,
  worktreePath: string,
  branchName: string,
): Promise<void> {
  // Reclaim worktree metadata orphaned by a prior crash before (re)adding.
  await gitRun(ctx.repoPath, ['worktree', 'prune']);
  const list = await gitRun(ctx.repoPath, ['worktree', 'list', '--porcelain']);
  const registered =
    list.code === 0 && list.stdout.split('\n').some((l) => l === `worktree ${worktreePath}`);
  if (registered) return;
  if (await pathExists(worktreePath)) {
    await gitRun(ctx.repoPath, ['worktree', 'remove', '--force', worktreePath]);
  }
  const branchExists = await gitRun(ctx.repoPath, [
    'show-ref',
    '--verify',
    '--quiet',
    `refs/heads/${branchName}`,
  ]);
  const addArgs =
    branchExists.code === 0
      ? ['worktree', 'add', worktreePath, branchName]
      : ['worktree', 'add', '-b', branchName, worktreePath, integration.branch];
  const res = await gitRun(ctx.repoPath, addArgs);
  if (res.code !== 0) {
    throw new Error(`git worktree add failed for ${branchName}: ${res.stderr || res.stdout}`);
  }
}

/** Pre-formatted notes from completed lower-level issues that carried debt, so
 *  downstream coders know about upstream compromises. */
async function buildUpstreamDebt(db: Database, planId: string, level: number): Promise<string> {
  if (level === 0) return '';
  const upstream = await db
    .select()
    .from(schema.taskDagIssues)
    .where(eq(schema.taskDagIssues.dagPlanId, planId));
  const lines: string[] = [];
  for (const issue of upstream) {
    if (issue.level >= level) continue;
    if (issue.outcome !== 'completed' && issue.outcome !== 'completed_with_debt') continue;
    const debt = (issue.debtItems ?? []) as unknown[];
    if (debt.length === 0) continue;
    lines.push(`- ${issue.issueKey} (${issue.title}) completed with debt: ${JSON.stringify(debt)}`);
  }
  if (lines.length === 0) return '';
  return [
    'Known debt from upstream issues — account for it, do not re-fix it here:',
    ...lines,
  ].join('\n');
}

function coderContext(issue: DagIssueRow): DagCoderContext {
  return {
    issueKey: issue.issueKey,
    title: issue.title,
    description: issue.description ?? '',
    specSections: (issue.specSections ?? []) as string[],
    acceptanceCriteria: (issue.acceptanceCriteria ?? []) as string[],
    provides: issue.provides ?? '',
    sandboxWorktreePath: issue.sandboxWorktreePath ?? '',
  };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Parse a coder's ISSUE_RESULT_JSON; fall back to completed (exit 0) or
 *  failed_unrecoverable (non-zero exit) when no JSON is parseable. */
export function parseCoderResult(inv: typeof schema.cliInvocations.$inferSelect): {
  outcome: DagIssueRow['outcome'];
  filesModified: string[];
  debtItems: unknown[];
  concerns: string;
} {
  let candidate: unknown =
    inv.parsedOutput && typeof inv.parsedOutput === 'object' ? inv.parsedOutput : null;
  if (!candidate && typeof inv.rawOutput === 'string') {
    const body = extractFencedJson(inv.rawOutput);
    candidate = body ? safeJsonParse(body) : null;
  }
  const parsed = dagIssueResultSchema.safeParse(candidate);
  if (parsed.success) {
    return {
      outcome: parsed.data.outcome,
      filesModified: parsed.data.files_modified,
      debtItems: parsed.data.debt_items,
      concerns: parsed.data.concerns,
    };
  }
  const failed = inv.exitCode !== null && inv.exitCode !== 0;
  return {
    outcome: failed ? 'failed_unrecoverable' : 'completed',
    filesModified: [],
    debtItems: [],
    concerns: failed
      ? `coder exited ${inv.exitCode}; no ISSUE_RESULT_JSON parsed`
      : 'no ISSUE_RESULT_JSON parsed',
  };
}

/** First fatal-provider errorMessage among ended invocations, or null. Scans ALL
 *  rows (not just the most recent) because a successful sibling coder can finish
 *  AFTER the one that hit a provider wall (429/quota, bad auth, 5xx). Pure so the
 *  DAG fail-fast guard's decision is unit-testable without a DB. */
export function pickFatalProviderError(rows: { errorMessage: string | null }[]): string | null {
  return rows.find((r) => isFatalProviderFailure(r.errorMessage))?.errorMessage ?? null;
}

/** Commit any uncommitted work in an issue worktree (belt-and-suspenders — the
 *  coder is told to commit, but may not). No-op when the tree is clean. */
async function commitIssueWork(
  ctx: StepContext,
  worktreePath: string,
  issue: DagIssueRow,
  gitEnv: Record<string, string>,
): Promise<void> {
  await gitRun(worktreePath, ['add', '-A']);
  const status = await gitRun(worktreePath, ['status', '--porcelain']);
  if (status.code === 0 && status.stdout.trim().length === 0) return;
  const res = await gitRun(
    worktreePath,
    ['commit', '-m', `${issue.issueKey}: ${issue.title}`],
    gitEnv,
  );
  if (res.code !== 0) {
    ctx.logger.warn(
      { issueKey: issue.issueKey, out: res.stderr || res.stdout },
      'issue commit failed',
    );
  }
}

const MERGE_FIX_TIMEOUT_MS = 30 * 60 * 1000;

interface LevelMergeState {
  /** issueKey whose merge-fix agent is currently in flight (null = none). */
  activeConflict: string | null;
  fixInvocationId: string | null;
  /** Per-issueKey count of LLM resolution attempts. */
  conflictRetries: Record<string, number>;
}

function readMergeState(level: DagLevelRow): LevelMergeState {
  const ms = (level.mergeState ?? null) as Partial<LevelMergeState> | null;
  return {
    activeConflict: ms?.activeConflict ?? null,
    fixInvocationId: ms?.fixInvocationId ?? null,
    conflictRetries: ms?.conflictRetries ?? {},
  };
}

async function saveMergeState(db: Database, levelId: string, ms: LevelMergeState): Promise<void> {
  await db
    .update(schema.taskDagLevels)
    .set({ mergeState: ms, phase: 'merging', updatedAt: new Date() })
    .where(eq(schema.taskDagLevels.id, levelId));
}

async function clearAiFix(db: Database, stepRowId: string): Promise<void> {
  await db
    .update(schema.taskSteps)
    .set({ aiFixContext: null, updatedAt: new Date() })
    .where(eq(schema.taskSteps.id, stepRowId));
}

// mergeCommitted / buildMergeFixPrompt / completeMergeHostSide moved to ./git-merge.js
// (shared with the worktree-cleanup merge phase).

interface MergeArgs {
  db: Database;
  integration: IntegrationWorktree;
  level: DagLevelRow;
  issues: DagIssueRow[];
  gitEnv: Record<string, string>;
  current: TaskStepRow;
  params: AdvanceStepParams;
  stepDef: StepDefinition;
  providers: CliProviderRecord[];
  deps: WorkerDeps;
  /** When true, conflicts auto-dispatch the fix agent + loop (bounded) instead
   *  of halting for a manual "Retry with LLM". */
  autoResolve: boolean;
  /** When true, an issue is mergeable only after review resolved it (approved /
   *  completed_with_debt); otherwise the coder outcome gates the merge. */
  reviewEnabled: boolean;
}

/** Max auto-resolve attempts per conflicting branch before falling back to a
 *  manual halt (so an unresolvable conflict can't loop forever / burn tokens). */
const MAX_AUTO_CONFLICT_RETRIES = 4;

async function haltConflicts(
  m: MergeArgs,
  conflicts: DagIssueRow[],
  reason?: string,
): Promise<{ status: 'halt'; row: TaskStepRow; error: string }> {
  const branches = conflicts.map((c) => c.branchName ?? c.issueKey).join(', ');
  const msg = reason
    ? `Merge halted — ${reason}: ${branches}`
    : `Merge halted — ${conflicts.length} branch(es) conflict. Resolve with "Retry with LLM": ${branches}`;
  const row = await setStepStatus(m.db, m.current.id, {
    status: 'failed',
    errorMessage: msg,
    endedAt: new Date(),
  });
  return { status: 'halt', row, error: msg };
}

/** Recreate the live conflict for `target` and dispatch one merge-fix agent into
 *  the integration worktree. Returns 'waiting' (agent in flight) or 'halt' (no
 *  provider). Shared by manual retry_ai and auto-resolve. */
async function startConflictFix(
  m: MergeArgs,
  state: LevelMergeState,
  target: DagIssueRow,
): Promise<
  { status: 'waiting'; row: TaskStepRow } | { status: 'halt'; row: TaskStepRow; error: string }
> {
  await gitRun(m.integration.path, ['merge', '--no-ff', '--no-edit', target.branchName!], m.gitEnv);
  const invId = await dispatchMergeFixAgent(m, target);
  if (!invId) {
    await gitRun(m.integration.path, ['merge', '--abort']);
    await clearAiFix(m.db, m.current.id);
    return haltConflicts(m, [target], 'no CLI provider for merge resolution');
  }
  state.activeConflict = target.issueKey;
  state.fixInvocationId = invId;
  state.conflictRetries[target.issueKey] = (state.conflictRetries[target.issueKey] ?? 0) + 1;
  await saveMergeState(m.db, m.level.id, state);
  await clearAiFix(m.db, m.current.id);
  const waiting = await setStepStatus(m.db, m.current.id, {
    status: 'waiting_cli',
    statusMessage: `Resolving merge conflict on ${target.issueKey} with AI…`,
  });
  return { status: 'waiting', row: waiting };
}

async function dispatchMergeFixAgent(m: MergeArgs, issue: DagIssueRow): Promise<string | null> {
  const { db, params, stepDef, current, integration, providers, deps } = m;
  const prompt = buildMergeFixPrompt(issue.branchName ?? '', issue.title ?? undefined);
  const preferred = await resolvePreferredCli(
    db,
    params.userId,
    stepDef.metadata.id,
    params.cliProviderId ?? null,
    providers,
    'default',
    params.taskId,
    params.ignoreSavedStepClis ?? false,
  );
  const plan = resolveDispatch({
    providers,
    preferredProviderId: preferred,
    input: { kind: 'prompt', prompt, capabilities: ['tool_use', 'file_write'] },
    invokeOpts: { cwd: integration.sandboxPath },
  });
  if (plan.mode === 'skip' || !plan.invocation || plan.invocation.kind !== 'cli') return null;
  const inv = await db
    .insert(schema.cliInvocations)
    .values({
      taskId: params.taskId,
      taskStepId: current.id,
      cliProviderId: plan.providerId,
      mode: 'cli',
      prompt,
    })
    .returning({ id: schema.cliInvocations.id });
  const invId = inv[0]?.id;
  if (!invId) return null;
  await deps.enqueueCliInvocation({
    invocationId: invId,
    taskId: params.taskId,
    taskStepId: current.id,
    userId: params.userId,
    cliProviderId: plan.providerId,
    kind: 'cli',
    spec: plan.invocation.spec,
    timeoutMs: MERGE_FIX_TIMEOUT_MS,
  });
  return invId;
}

/** Merge a level's issue branches into the integration branch, git-first. Clean
 *  branches merge and proceed; a conflicting branch is HELD (mergeStatus
 *  'conflict') and the step halts until "Retry with LLM" (retry_ai) drives ONE
 *  conflict's resolution per click via a fix agent in the integration worktree.
 *  Returns 'ok' (all merged), 'waiting' (a fix agent is in flight), or 'halt'
 *  (conflicts remain → step failed until the next retry). */
async function runLevelMerge(
  m: MergeArgs,
): Promise<{ status: 'ok' | 'halt' | 'waiting'; row: TaskStepRow; error?: string }> {
  const { db, integration, level, issues, gitEnv } = m;
  const mergeable = issues.filter((i) => {
    if (i.branchName === null) return false;
    return m.reviewEnabled
      ? i.resolution === 'approved' || i.resolution === 'completed_with_debt'
      : i.outcome === 'completed' || i.outcome === 'completed_with_debt';
  });
  const state = readMergeState(level);

  // 1. A fix agent is in flight — ingest its result.
  if (state.fixInvocationId) {
    const inv = await db.query.cliInvocations.findFirst({
      where: eq(schema.cliInvocations.id, state.fixInvocationId),
    });
    if (!inv || inv.endedAt === null) return { status: 'waiting', row: m.current };
    await db
      .update(schema.cliInvocations)
      .set({ consumedAt: new Date() })
      .where(eq(schema.cliInvocations.id, inv.id));
    const target = mergeable.find((i) => i.issueKey === state.activeConflict);
    if (target) {
      // The fix agent only edited the conflicted files; finish the merge here
      // (verify markers gone, stage, commit) — git is unavailable in the sandbox.
      const committed = await completeMergeHostSide(integration.path, gitEnv);
      if (committed) {
        await db
          .update(schema.taskDagIssues)
          .set({ mergeStatus: 'resolved', mergedAt: new Date(), updatedAt: new Date() })
          .where(eq(schema.taskDagIssues.id, target.id));
        target.mergeStatus = 'resolved';
      } else {
        await gitRun(integration.path, ['merge', '--abort']);
        // leave mergeStatus='conflict' for another retry
      }
    }
    state.activeConflict = null;
    state.fixInvocationId = null;
    await saveMergeState(db, level.id, state);
    await clearAiFix(db, m.current.id);
    m.current = await setStepStatus(db, m.current.id, { status: 'running' });
    // fall through to the merge pass + halt/ok decision
  } else if (m.current.aiFixContext) {
    // 2. retry_ai (manual) — dispatch a fix agent for the first held conflict.
    const target = mergeable.find((i) => i.mergeStatus === 'conflict');
    if (target) return startConflictFix(m, state, target);
    await clearAiFix(db, m.current.id);
  }

  // 3. Merge pass: merge still-pending branches (mergeStatus null) in order.
  for (const issue of mergeable) {
    if (issue.mergeStatus !== null) continue; // clean | resolved | conflict already decided
    const merge = await gitRun(
      integration.path,
      ['merge', '--no-ff', '--no-edit', issue.branchName!],
      gitEnv,
    );
    if (merge.code === 0) {
      await db
        .update(schema.taskDagIssues)
        .set({ mergeStatus: 'clean', mergedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.taskDagIssues.id, issue.id));
      issue.mergeStatus = 'clean';
    } else {
      await gitRun(integration.path, ['merge', '--abort']);
      await db
        .update(schema.taskDagIssues)
        .set({ mergeStatus: 'conflict', updatedAt: new Date() })
        .where(eq(schema.taskDagIssues.id, issue.id));
      issue.mergeStatus = 'conflict';
    }
  }

  // 4. Conflicts remain → auto-resolve (bounded) or halt for manual retry_ai.
  const conflicts = mergeable.filter((i) => i.mergeStatus === 'conflict');
  if (conflicts.length === 0) return { status: 'ok', row: m.current };
  if (m.autoResolve) {
    const target = conflicts.find(
      (c) => (state.conflictRetries[c.issueKey] ?? 0) < MAX_AUTO_CONFLICT_RETRIES,
    );
    if (target) return startConflictFix(m, state, target);
    return haltConflicts(
      m,
      conflicts,
      `auto-resolution exhausted after ${MAX_AUTO_CONFLICT_RETRIES} attempts per branch`,
    );
  }
  return haltConflicts(m, conflicts);
}

async function cleanupLevelWorktrees(ctx: StepContext, issues: DagIssueRow[]): Promise<void> {
  for (const issue of issues) {
    if (!issue.worktreePath) continue;
    await gitRun(ctx.repoPath, ['worktree', 'remove', '--force', issue.worktreePath]);
  }
}

// --- Inner review loop (coder <-> reviewer, per issue) --------------------

const REVIEW_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_REVIEW_ITERS = 5;
const STUCK_LIMIT = 3;

interface ReviewArgs {
  db: Database;
  issues: DagIssueRow[];
  level: DagLevelRow;
  current: TaskStepRow;
  params: AdvanceStepParams;
  stepDef: StepDefinition;
  providers: CliProviderRecord[];
  deps: WorkerDeps;
  taskId: string;
}

function reviewerPrompt(issue: DagIssueRow): string {
  const criteria = (issue.acceptanceCriteria ?? []) as string[];
  return [
    `You are reviewing the implementation of ${issue.issueKey}: ${issue.title}`,
    'Your working directory is the issue worktree containing the implementation.',
    'Review it as a senior engineer would before merge; verify each acceptance criterion against the code.',
    criteria.length > 0 ? `Acceptance criteria:\n- ${criteria.join('\n- ')}` : '',
    '',
    'Emit ONE JSON object inside a ```json fenced code block with EXACTLY this shape:',
    '{ "verdict": "approve|fix_required|block", "criteria_results": [{ "criterion": "...", "passed": true, "note": "" }], "issues": [{ "severity": "high|medium|low", "file": "path", "description": "...", "suggestion": "..." }] }',
    'Verdict rules: approve = every acceptance criterion passes — choose approve even if you still have low-severity or cosmetic suggestions; list them under issues and they are tracked as debt, not a merge blocker.',
    'fix_required = at least one issue makes an acceptance criterion fail and a fix coder can address it. block = a fundamental problem (broken build, security hole, wrong approach) that cannot be approved.',
  ]
    .filter(Boolean)
    .join('\n');
}

function fixCoderPrompt(issue: DagIssueRow, reviewIssues: unknown[]): string {
  return [
    `You are addressing reviewer findings for ${issue.issueKey}: ${issue.title}`,
    'Your working directory is the issue worktree. Validate each finding against the actual code and fix the real ones by editing files; ignore findings that are wrong or out of scope. Match the existing style.',
    `Reviewer findings:\n${JSON.stringify(reviewIssues).slice(0, 4000)}`,
    '',
    'When done, emit ONE JSON object inside a ```json fenced code block:',
    `{ "issue_id": "${issue.issueKey}", "outcome": "completed|completed_with_debt|failed_unrecoverable", "files_modified": [], "debt_items": [], "concerns": "" }`,
  ].join('\n');
}

function parseReviewerOutput(inv: typeof schema.cliInvocations.$inferSelect): ReviewerOutput {
  let candidate: unknown =
    inv.parsedOutput && typeof inv.parsedOutput === 'object' ? inv.parsedOutput : null;
  if (!candidate && typeof inv.rawOutput === 'string') {
    const body = extractFencedJson(inv.rawOutput);
    candidate = body ? safeJsonParse(body) : null;
  }
  const parsed = reviewerOutputSchema.safeParse(candidate);
  // Unparseable reviewer output → approve (don't block the pipeline on a parse miss).
  return parsed.success ? parsed.data : { verdict: 'approve', criteria_results: [], issues: [] };
}

/** A fix_required verdict whose own structured signals say the work is done:
 *  every acceptance criterion passed and every raised issue is explicitly
 *  low-severity (cosmetic). These resolve as debt instead of looping the
 *  coder<->reviewer pair on polish. Conservative: an empty criteria list, or
 *  any issue without an explicit 'low' severity, counts as NOT cosmetic. */
export function fixRequiredIsCosmetic(v: ReviewerOutput): boolean {
  return (
    v.verdict === 'fix_required' &&
    v.criteria_results.length > 0 &&
    v.criteria_results.every((c) => c.passed) &&
    v.issues.every((i) => i.severity === 'low')
  );
}

/** Dispatch one review-loop agent (reviewer or fix-coder) into the issue
 *  worktree, recording a dag_agent_runs row. Returns false if no provider. */
async function spawnReviewAgent(
  ra: ReviewArgs,
  issue: DagIssueRow,
  role: 'reviewer' | 'coder' | 'issue_advisor',
  iteration: number,
  prompt: string,
  capabilities: StepCapability[],
): Promise<boolean> {
  const preferred = await resolvePreferredCli(
    ra.db,
    ra.params.userId,
    ra.stepDef.metadata.id,
    ra.params.cliProviderId ?? null,
    ra.providers,
    role,
    ra.params.taskId,
    ra.params.ignoreSavedStepClis ?? false,
  );
  const plan = resolveDispatch({
    providers: ra.providers,
    preferredProviderId: preferred,
    input: { kind: 'prompt', prompt, capabilities },
    invokeOpts: { cwd: issue.sandboxWorktreePath ?? undefined },
  });
  if (plan.mode === 'skip' || !plan.invocation || plan.invocation.kind !== 'cli') return false;
  const inv = await ra.db
    .insert(schema.cliInvocations)
    .values({
      taskId: ra.taskId,
      taskStepId: ra.current.id,
      cliProviderId: plan.providerId,
      mode: 'cli',
      prompt,
    })
    .returning({ id: schema.cliInvocations.id });
  const invId = inv[0]?.id;
  if (!invId) return false;
  await ra.db.insert(schema.dagAgentRuns).values({
    dagIssueId: issue.id,
    taskId: ra.taskId,
    role,
    iteration,
    status: 'running',
    cliInvocationId: invId,
    startedAt: new Date(),
  });
  await ra.deps.enqueueCliInvocation({
    invocationId: invId,
    taskId: ra.taskId,
    taskStepId: ra.current.id,
    userId: ra.params.userId,
    cliProviderId: plan.providerId,
    kind: 'cli',
    spec: plan.invocation.spec,
    timeoutMs: REVIEW_TIMEOUT_MS,
  });
  return true;
}

async function setResolution(
  db: Database,
  issue: DagIssueRow,
  resolution: 'approved' | 'failed_unrecoverable',
): Promise<void> {
  await db
    .update(schema.taskDagIssues)
    .set({ resolution, reviewStatus: resolution, endedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.taskDagIssues.id, issue.id));
}

async function acceptWithDebt(
  db: Database,
  issue: DagIssueRow,
  reviewIssues: unknown[],
): Promise<void> {
  const existing = (issue.debtItems ?? []) as unknown[];
  await db
    .update(schema.taskDagIssues)
    .set({
      debtItems: [...existing, ...reviewIssues],
      outcome: 'completed_with_debt',
      resolution: 'completed_with_debt',
      reviewStatus: 'completed_with_debt',
      updatedAt: new Date(),
    })
    .where(eq(schema.taskDagIssues.id, issue.id));
}

/** Fold one finished review-loop agent into the issue state, spawning the next
 *  agent (a fix-coder after a reviewer's fix_required, or a re-review after a
 *  fix-coder) until the issue resolves. */
async function ingestReviewRun(
  ra: ReviewArgs,
  issue: DagIssueRow,
  run: typeof schema.dagAgentRuns.$inferSelect,
  inv: typeof schema.cliInvocations.$inferSelect,
): Promise<void> {
  await ra.db
    .update(schema.dagAgentRuns)
    .set({
      status: 'done',
      consumedAt: new Date(),
      endedAt: new Date(),
      rawOutput: inv.rawOutput ?? null,
    })
    .where(eq(schema.dagAgentRuns.id, run.id));

  if (run.role === 'reviewer') {
    const verdict = parseReviewerOutput(inv);
    if (verdict.verdict === 'approve') return setResolution(ra.db, issue, 'approved');
    if (verdict.verdict === 'block') return setResolution(ra.db, issue, 'failed_unrecoverable');
    // fix_required whose criteria all pass and whose only issues are cosmetic →
    // approve (folding the nits into debt) instead of looping on polish.
    if (fixRequiredIsCosmetic(verdict)) {
      return verdict.issues.length > 0
        ? acceptWithDebt(ra.db, issue, verdict.issues)
        : setResolution(ra.db, issue, 'approved');
    }
    // fix_required
    const newStuck = issue.stuckCount + 1;
    const newIter = issue.innerIteration + 1;
    if (newStuck >= STUCK_LIMIT) return acceptWithDebt(ra.db, issue, verdict.issues);
    if (newIter >= MAX_REVIEW_ITERS) return setResolution(ra.db, issue, 'failed_unrecoverable');
    await ra.db
      .update(schema.taskDagIssues)
      .set({
        stuckCount: newStuck,
        innerIteration: newIter,
        reviewStatus: 'fix_required',
        reviewerVerdict: verdict,
        updatedAt: new Date(),
      })
      .where(eq(schema.taskDagIssues.id, issue.id));
    const ok = await spawnReviewAgent(
      ra,
      issue,
      'coder',
      newIter,
      fixCoderPrompt(issue, verdict.issues),
      ['tool_use', 'file_write'],
    );
    if (!ok) await setResolution(ra.db, issue, 'failed_unrecoverable');
    return;
  }
  // fix-coder finished → re-review.
  const ok = await spawnReviewAgent(
    ra,
    issue,
    'reviewer',
    issue.innerIteration,
    reviewerPrompt(issue),
    ['tool_use'],
  );
  if (!ok) await setResolution(ra.db, issue, 'failed_unrecoverable');
}

/** Per-issue coder<->reviewer inner loop for a level. Returns 'ok' once every
 *  reviewable issue has a resolution, else 'waiting' while agents are in flight.
 *  A blocking verdict sets the issue's resolution to failed_unrecoverable;
 *  resolveDagPhase decides what to do with that. */
async function resolveReviewPhase(
  ra: ReviewArgs,
): Promise<{ status: 'ok' | 'waiting'; row: TaskStepRow }> {
  const needReview = ra.issues.filter(
    (i) =>
      (i.outcome === 'completed' || i.outcome === 'completed_with_debt') && i.resolution === null,
  );
  if (needReview.length === 0) return { status: 'ok', row: ra.current };

  for (const issue of needReview) {
    const runs = await ra.db
      .select()
      .from(schema.dagAgentRuns)
      .where(eq(schema.dagAgentRuns.dagIssueId, issue.id))
      .orderBy(desc(schema.dagAgentRuns.createdAt))
      .limit(1);
    const latest = runs[0];
    if (!latest) {
      const ok = await spawnReviewAgent(ra, issue, 'reviewer', 0, reviewerPrompt(issue), [
        'tool_use',
      ]);
      if (!ok) await setResolution(ra.db, issue, 'failed_unrecoverable');
      continue;
    }
    if (latest.consumedAt || !latest.cliInvocationId) continue;
    const inv = await ra.db.query.cliInvocations.findFirst({
      where: eq(schema.cliInvocations.id, latest.cliInvocationId),
    });
    if (!inv || inv.endedAt === null) continue; // in flight
    await ingestReviewRun(ra, issue, latest, inv);
  }

  const fresh = (await ra.db
    .select()
    .from(schema.taskDagIssues)
    .where(
      and(
        eq(schema.taskDagIssues.dagPlanId, ra.level.dagPlanId),
        eq(schema.taskDagIssues.level, ra.level.level),
      ),
    )) as DagIssueRow[];
  const stillReviewing = fresh.filter(
    (i) =>
      (i.outcome === 'completed' || i.outcome === 'completed_with_debt') && i.resolution === null,
  );
  if (stillReviewing.length === 0) return { status: 'ok', row: ra.current };
  const row = await setStepStatus(ra.db, ra.current.id, {
    status: 'waiting_cli',
    statusMessage: 'Reviewing implementations…',
  });
  return { status: 'waiting', row };
}

// --- Middle/outer escalation (issue-advisor + replanner) ------------------

const MAX_ADVISOR_INVOCATIONS = 2;
const MAX_REPLANNER_INVOCATIONS = 2;
const REPLAN_FAIL_RATIO = 0.8;

interface EscalationArgs extends ReviewArgs {
  plan: DagPlanRow;
}

function advisorPrompt(issue: DagIssueRow): string {
  return [
    `Issue ${issue.issueKey} (${issue.title}) failed its review loop after ${issue.innerIteration} fix attempt(s).`,
    issue.reviewerVerdict
      ? `Latest reviewer verdict: ${JSON.stringify(issue.reviewerVerdict).slice(0, 2000)}`
      : '',
    'Decide how to proceed. Emit ONE JSON object inside a ```json fenced code block:',
    '{ "action": "RETRY_APPROACH|RETRY_MODIFIED|SPLIT|ACCEPT_WITH_DEBT|ESCALATE_TO_REPLAN", "reasoning": "...", "retry_context": "<RETRY_*: guidance for the next attempt>", "drop_criteria": ["<RETRY_MODIFIED: criteria to drop>"], "sub_issues": [{ "title": "...", "description": "..." }] }',
    'RETRY_APPROACH: try again with new guidance. RETRY_MODIFIED: relax/drop some criteria then retry. SPLIT: break into sub-issues. ACCEPT_WITH_DEBT: accept as-is with documented gaps. ESCALATE_TO_REPLAN: the plan itself is wrong.',
  ]
    .filter(Boolean)
    .join('\n');
}

function replannerPrompt(plan: DagPlanRow, failed: DagIssueRow[]): string {
  return [
    `The DAG has broad failure: ${failed.length} issue(s) could not be implemented (${failed
      .map((f) => f.issueKey)
      .join(', ')}).`,
    `Current dependency levels: ${JSON.stringify(plan.levels)}`,
    'Decide how to proceed. Emit ONE JSON object inside a ```json fenced code block:',
    '{ "action": "CONTINUE|MODIFY_DAG|REDUCE_SCOPE|ABORT", "reasoning": "...", "skip_downstream": ["<issue ids to skip>"], "new_levels": [["ISSUE-..."]] }',
    'CONTINUE: skip the failed issues, proceed. REDUCE_SCOPE: drop low-priority issues. MODIFY_DAG: restructure (provide new_levels). ABORT: stop the workflow with a failure report.',
  ].join('\n');
}

function parseAdvisor(inv: typeof schema.cliInvocations.$inferSelect): AdvisorOutput {
  let c: unknown =
    inv.parsedOutput && typeof inv.parsedOutput === 'object' ? inv.parsedOutput : null;
  if (!c && typeof inv.rawOutput === 'string') {
    const b = extractFencedJson(inv.rawOutput);
    c = b ? safeJsonParse(b) : null;
  }
  const p = advisorOutputSchema.safeParse(c);
  return p.success
    ? p.data
    : {
        action: 'ACCEPT_WITH_DEBT',
        reasoning: 'advisor output unparseable',
        drop_criteria: [],
        sub_issues: [],
      };
}

function parseReplanner(inv: typeof schema.cliInvocations.$inferSelect): ReplannerOutput {
  let c: unknown =
    inv.parsedOutput && typeof inv.parsedOutput === 'object' ? inv.parsedOutput : null;
  if (!c && typeof inv.rawOutput === 'string') {
    const b = extractFencedJson(inv.rawOutput);
    c = b ? safeJsonParse(b) : null;
  }
  const p = replannerOutputSchema.safeParse(c);
  return p.success
    ? p.data
    : {
        action: 'CONTINUE',
        reasoning: 'replanner output unparseable',
        skip_downstream: [],
        new_levels: [],
      };
}

async function pushDebt(db: Database, issue: DagIssueRow, items: unknown[]): Promise<void> {
  const existing = (issue.debtItems ?? []) as unknown[];
  await db
    .update(schema.taskDagIssues)
    .set({ debtItems: [...existing, ...items], updatedAt: new Date() })
    .where(eq(schema.taskDagIssues.id, issue.id));
}

async function skipIssue(db: Database, issue: DagIssueRow): Promise<void> {
  await db
    .update(schema.taskDagIssues)
    .set({
      resolution: 'skipped',
      reviewStatus: 'skipped',
      endedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.taskDagIssues.id, issue.id));
}

/** Fold one finished issue-advisor run into the issue + return the action taken
 *  ('retry' spawned a fix coder, 'split' added sub-issues, 'accept' resolved with
 *  debt, 'escalate' left it for the replanner). */
async function ingestAdvisor(
  ea: EscalationArgs,
  issue: DagIssueRow,
  run: typeof schema.dagAgentRuns.$inferSelect,
  inv: typeof schema.cliInvocations.$inferSelect,
): Promise<'retry' | 'split' | 'accept' | 'escalate'> {
  await ea.db
    .update(schema.dagAgentRuns)
    .set({
      status: 'done',
      consumedAt: new Date(),
      endedAt: new Date(),
      rawOutput: inv.rawOutput ?? null,
    })
    .where(eq(schema.dagAgentRuns.id, run.id));
  const out = parseAdvisor(inv);
  await ea.db
    .update(schema.taskDagIssues)
    .set({
      advisorInvocations: issue.advisorInvocations + 1,
      lastAdvisorAction: out.action,
      updatedAt: new Date(),
    })
    .where(eq(schema.taskDagIssues.id, issue.id));

  if (out.action === 'ACCEPT_WITH_DEBT') {
    await acceptWithDebt(ea.db, issue, [{ type: 'advisor_accept', reasoning: out.reasoning }]);
    return 'accept';
  }
  if (out.action === 'ESCALATE_TO_REPLAN') return 'escalate'; // stays failed_unrecoverable
  if (out.action === 'SPLIT') {
    const subs =
      out.sub_issues.length > 0
        ? out.sub_issues
        : [{ title: `${issue.title} (retry)`, description: '' }];
    let idx = 0;
    for (const sub of subs) {
      idx += 1;
      await ea.db.insert(schema.taskDagIssues).values({
        dagPlanId: issue.dagPlanId,
        taskId: ea.taskId,
        issueKey: `${issue.issueKey}-S${idx}`,
        level: issue.level,
        title: sub.title,
        description: sub.description,
        acceptanceCriteria: (issue.acceptanceCriteria ?? []) as string[],
        parentIssueId: issue.id,
        outcome: 'pending',
      });
    }
    await ea.db
      .update(schema.taskDagIssues)
      .set({ resolution: 'split', reviewStatus: 'split', updatedAt: new Date() })
      .where(eq(schema.taskDagIssues.id, issue.id));
    return 'split';
  }
  // RETRY_APPROACH / RETRY_MODIFIED → reset to a fresh fix-coder pass.
  let criteria = (issue.acceptanceCriteria ?? []) as string[];
  if (out.action === 'RETRY_MODIFIED' && out.drop_criteria.length > 0) {
    criteria = criteria.filter((c) => !out.drop_criteria.includes(c));
    await pushDebt(
      ea.db,
      issue,
      out.drop_criteria.map((c) => ({ type: 'dropped_criterion', criterion: c })),
    );
  }
  const newIter = issue.innerIteration + 1;
  await ea.db
    .update(schema.taskDagIssues)
    .set({
      resolution: null,
      reviewStatus: null,
      acceptanceCriteria: criteria,
      retryContext: { note: out.retry_context ?? '' },
      innerIteration: newIter,
      updatedAt: new Date(),
    })
    .where(eq(schema.taskDagIssues.id, issue.id));
  const ok = await spawnReviewAgent(
    ea,
    { ...issue, acceptanceCriteria: criteria },
    'coder',
    newIter,
    fixCoderPrompt(issue, [
      { retry_context: out.retry_context ?? '', findings: issue.reviewerVerdict },
    ]),
    ['tool_use', 'file_write'],
  );
  if (!ok) await setResolution(ea.db, issue, 'failed_unrecoverable');
  return 'retry';
}

async function spawnReplanner(ea: EscalationArgs, failed: DagIssueRow[]): Promise<boolean> {
  const prompt = replannerPrompt(ea.plan, failed);
  const preferred = await resolvePreferredCli(
    ea.db,
    ea.params.userId,
    ea.stepDef.metadata.id,
    ea.params.cliProviderId ?? null,
    ea.providers,
    'replanner',
    ea.params.taskId,
    ea.params.ignoreSavedStepClis ?? false,
  );
  const plan = resolveDispatch({
    providers: ea.providers,
    preferredProviderId: preferred,
    input: { kind: 'prompt', prompt, capabilities: ['tool_use'] },
    invokeOpts: { cwd: ea.params.workspacePath },
  });
  if (plan.mode === 'skip' || !plan.invocation || plan.invocation.kind !== 'cli') return false;
  const inv = await ea.db
    .insert(schema.cliInvocations)
    .values({
      taskId: ea.taskId,
      taskStepId: ea.current.id,
      cliProviderId: plan.providerId,
      mode: 'cli',
      prompt,
    })
    .returning({ id: schema.cliInvocations.id });
  const invId = inv[0]?.id;
  if (!invId) return false;
  await ea.db
    .update(schema.taskDagPlans)
    .set({ replannerInvocationId: invId, updatedAt: new Date() })
    .where(eq(schema.taskDagPlans.id, ea.plan.id));
  await ea.deps.enqueueCliInvocation({
    invocationId: invId,
    taskId: ea.taskId,
    taskStepId: ea.current.id,
    userId: ea.params.userId,
    cliProviderId: plan.providerId,
    kind: 'cli',
    spec: plan.invocation.spec,
    timeoutMs: REVIEW_TIMEOUT_MS,
  });
  return true;
}

async function ingestReplanner(
  ea: EscalationArgs,
  inv: typeof schema.cliInvocations.$inferSelect,
  failed: DagIssueRow[],
): Promise<'continue' | 'abort'> {
  const out = parseReplanner(inv);
  await ea.db
    .update(schema.cliInvocations)
    .set({ consumedAt: new Date() })
    .where(eq(schema.cliInvocations.id, inv.id));
  await ea.db
    .update(schema.taskDagPlans)
    .set({
      replannerInvocations: ea.plan.replannerInvocations + 1,
      lastReplannerAction: out.action,
      replannerInvocationId: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.taskDagPlans.id, ea.plan.id));
  if (out.action === 'ABORT') return 'abort';
  // CONTINUE / REDUCE_SCOPE / MODIFY_DAG → skip the failed issues and proceed.
  // (MODIFY_DAG's full level-restructure is intentionally conservative here: the
  // failed work is skipped rather than re-sequenced, which is always safe.)
  for (const issue of failed) await skipIssue(ea.db, issue);
  return 'continue';
}

async function reReadLevelIssues(ea: EscalationArgs): Promise<DagIssueRow[]> {
  return (await ea.db
    .select()
    .from(schema.taskDagIssues)
    .where(
      and(
        eq(schema.taskDagIssues.dagPlanId, ea.plan.id),
        eq(schema.taskDagIssues.level, ea.level.level),
      ),
    )) as DagIssueRow[];
}

/** Handle a level's failed issues: issue-advisor (middle loop) then replanner
 *  (outer loop). Returns 'ok' (no failures left → merge), 'waiting' (an agent is
 *  in flight), 'reloop' (state changed; re-process the level), or 'aborted'. */
async function resolveEscalationPhase(
  ea: EscalationArgs,
): Promise<{ status: 'ok' | 'waiting' | 'reloop' | 'aborted'; row: TaskStepRow; error?: string }> {
  // A plan-level replanner in flight?
  if (ea.plan.replannerInvocationId) {
    const inv = await ea.db.query.cliInvocations.findFirst({
      where: eq(schema.cliInvocations.id, ea.plan.replannerInvocationId),
    });
    if (!inv || inv.endedAt === null) return { status: 'waiting', row: ea.current };
    const failedNow = ea.issues.filter((i) => i.resolution === 'failed_unrecoverable');
    const action = await ingestReplanner(ea, inv, failedNow);
    if (action === 'abort') {
      const msg = `DAG aborted by replanner at level ${ea.level.level}: ${failedNow
        .map((f) => f.issueKey)
        .join(', ')}`;
      const row = await setStepStatus(ea.db, ea.current.id, {
        status: 'failed',
        errorMessage: msg,
        endedAt: new Date(),
      });
      return { status: 'aborted', row, error: msg };
    }
    return { status: 'reloop', row: ea.current };
  }

  const failed = ea.issues.filter((i) => i.resolution === 'failed_unrecoverable');
  if (failed.length === 0) return { status: 'ok', row: ea.current };

  // Middle loop: issue-advisor per failed (not-yet-escalated) issue.
  let inFlight = false;
  let reloop = false;
  for (const issue of failed) {
    if (issue.lastAdvisorAction === 'ESCALATE_TO_REPLAN') continue;
    const runs = await ea.db
      .select()
      .from(schema.dagAgentRuns)
      .where(
        and(
          eq(schema.dagAgentRuns.dagIssueId, issue.id),
          eq(schema.dagAgentRuns.role, 'issue_advisor'),
        ),
      )
      .orderBy(desc(schema.dagAgentRuns.createdAt))
      .limit(1);
    const latest = runs[0];
    if (latest && !latest.consumedAt && latest.cliInvocationId) {
      const inv = await ea.db.query.cliInvocations.findFirst({
        where: eq(schema.cliInvocations.id, latest.cliInvocationId),
      });
      if (!inv || inv.endedAt === null) {
        inFlight = true;
        continue;
      }
      const action = await ingestAdvisor(ea, issue, latest, inv);
      if (action === 'retry') inFlight = true;
      else if (action === 'split') reloop = true;
      continue;
    }
    if (issue.advisorInvocations < MAX_ADVISOR_INVOCATIONS) {
      const ok = await spawnReviewAgent(
        ea,
        issue,
        'issue_advisor',
        issue.advisorInvocations,
        advisorPrompt(issue),
        ['tool_use'],
      );
      if (ok) inFlight = true;
      else await acceptWithDebt(ea.db, issue, [{ type: 'no_advisor_provider' }]);
    } else {
      await acceptWithDebt(ea.db, issue, [{ type: 'advisor_exhausted' }]);
    }
  }
  if (inFlight) {
    const row = await setStepStatus(ea.db, ea.current.id, {
      status: 'waiting_cli',
      statusMessage: 'Advising failed issues…',
    });
    return { status: 'waiting', row };
  }
  if (reloop) return { status: 'reloop', row: ea.current };

  // Outer loop: replanner when failures are broad / escalated.
  const fresh = await reReadLevelIssues(ea);
  const stillFailed = fresh.filter((i) => i.resolution === 'failed_unrecoverable');
  if (stillFailed.length === 0) return { status: 'reloop', row: ea.current };
  const escalated = stillFailed.some((i) => i.lastAdvisorAction === 'ESCALATE_TO_REPLAN');
  const ratioTrigger = stillFailed.length / Math.max(1, fresh.length) >= REPLAN_FAIL_RATIO;
  const trigger = escalated || stillFailed.length >= 2 || ratioTrigger;
  if (!trigger || ea.plan.replannerInvocations >= MAX_REPLANNER_INVOCATIONS) {
    for (const issue of stillFailed)
      await acceptWithDebt(ea.db, issue, [{ type: 'unresolved_after_escalation' }]);
    return { status: 'reloop', row: ea.current };
  }
  const ok = await spawnReplanner(ea, stillFailed);
  if (!ok) {
    for (const issue of stillFailed)
      await acceptWithDebt(ea.db, issue, [{ type: 'no_replanner_provider' }]);
    return { status: 'reloop', row: ea.current };
  }
  const row = await setStepStatus(ea.db, ea.current.id, {
    status: 'waiting_cli',
    statusMessage: 'Replanning the DAG…',
  });
  return { status: 'waiting', row };
}

export async function resolveDagPhase(
  db: Database,
  stepDef: StepDefinition,
  current: TaskStepRow,
  ctx: StepContext,
  params: AdvanceStepParams,
): Promise<DagResolved> {
  const spec = stepDef.dagExecute!;
  if (!params.providers || !params.deps) {
    const updated = await setStepStatus(db, current.id, {
      status: 'failed',
      errorMessage: 'dag execution requires CLI providers but none were supplied',
      endedAt: new Date(),
    });
    return {
      resolved: false,
      result: {
        status: 'failed',
        row: updated,
        error: updated.errorMessage ?? 'missing providers',
      },
    };
  }
  const providers = params.providers;
  const deps = params.deps;

  const planExists = await db.query.taskDagPlans.findFirst({
    where: eq(schema.taskDagPlans.taskId, ctx.taskId),
    columns: { id: true, mode: true },
  });
  if (!planExists || planExists.mode !== 'dag') {
    // No DAG to run (shouldRun gates on mode==='dag'); finalize trivially.
    return { resolved: true, current };
  }

  // Fail fast on a fatal provider failure (rate-limit/quota, bad/expired auth, 5xx
  // outage). Every DAG agent — coder, reviewer, advisor, replanner, merge-fix —
  // links to THIS step row, so one check at re-entry covers them all. Without it a
  // depleted-provider failure is swallowed by escalation (advisor → replanner →
  // accept-with-debt) and every retry re-hits the dead provider, burning calls and
  // silently degrading an OUTAGE into accepted technical debt. We scan all ended
  // (not superseded) invocations rather than only the most recent because a
  // successful sibling coder can finish AFTER the one that hit the wall. The user
  // retries the task (Retry resumes this step) once the provider is back.
  const endedInvocations = await db
    .select({ errorMessage: schema.cliInvocations.errorMessage })
    .from(schema.cliInvocations)
    .where(
      and(
        eq(schema.cliInvocations.taskStepId, current.id),
        isNotNull(schema.cliInvocations.endedAt),
        isNull(schema.cliInvocations.supersededAt),
        isNotNull(schema.cliInvocations.errorMessage),
      ),
    )
    .orderBy(desc(schema.cliInvocations.endedAt))
    .limit(50);
  const fatalMsg = pickFatalProviderError(endedInvocations);
  if (fatalMsg) {
    // Cancel sibling coders still in flight — each would re-hit the dead provider and
    // burn another doomed call. Mark them ended+superseded (supersededAt makes
    // resumeStepIfLinked skip the spurious advance when their jobs finish) then force-
    // remove their containers. killCliSandboxesForTask is DDEV-safe: it filters to
    // `haive-cli-` names, leaving the `haive-ddev-` runtime (same task label) untouched.
    await db
      .update(schema.cliInvocations)
      .set({
        exitCode: 137,
        errorMessage: 'cancelled: sibling of a fatal provider failure',
        endedAt: new Date(),
        supersededAt: new Date(),
      })
      .where(
        and(
          eq(schema.cliInvocations.taskStepId, current.id),
          isNull(schema.cliInvocations.endedAt),
          isNull(schema.cliInvocations.supersededAt),
        ),
      );
    await killCliSandboxesForTask(ctx.taskId);
    const updated = await setStepStatus(db, current.id, {
      status: 'failed',
      errorMessage: fatalMsg,
      endedAt: new Date(),
    });
    return { resolved: false, result: { status: 'failed', row: updated, error: fatalMsg } };
  }

  const integration = await loadIntegrationWorktree(db, ctx.taskId);
  const gitEnv = await resolveUserGitEnv(db, ctx.userId).then((e) =>
    Object.keys(e).length > 0 ? e : FALLBACK_GIT_IDENTITY,
  );

  // Drive levels until a barrier (waiting_cli), a failure, or completion. Every
  // iteration re-reads the rows, so a crash resumes from the persisted state.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Re-read the plan each iteration — the escalation phase mutates plan fields
    // (replannerInvocationId, replannerInvocations, debtAggregate) in the DB, so
    // a stale in-memory copy would loop forever on a 'reloop'.
    const plan = (await db.query.taskDagPlans.findFirst({
      where: eq(schema.taskDagPlans.taskId, ctx.taskId),
    })) as DagPlanRow;
    const levels = (await db
      .select()
      .from(schema.taskDagLevels)
      .where(eq(schema.taskDagLevels.dagPlanId, plan.id))
      .orderBy(asc(schema.taskDagLevels.level))) as DagLevelRow[];
    const curLevel = levels.find((l) => l.checkpointedAt === null);
    if (!curLevel) {
      // All levels checkpointed → DAG complete; apply finalizes the step.
      return { resolved: true, current };
    }

    let issues = (await db
      .select()
      .from(schema.taskDagIssues)
      .where(
        and(
          eq(schema.taskDagIssues.dagPlanId, plan.id),
          eq(schema.taskDagIssues.level, curLevel.level),
        ),
      )) as DagIssueRow[];

    if (issues.length === 0) {
      await db
        .update(schema.taskDagLevels)
        .set({ phase: 'checkpointed', checkpointedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.taskDagLevels.id, curLevel.id));
      continue;
    }

    // (A) Worktrees not created for this level yet.
    if (issues.some((i) => i.worktreePath === null)) {
      await ctx.emitProgress(`Creating ${issues.length} worktree(s) for level ${curLevel.level}…`);
      for (const issue of issues) {
        if (issue.worktreePath) continue;
        const p = issuePaths(ctx, integration, issue.issueKey);
        await createIssueWorktree(ctx, integration, p.worktreePath, p.branchName);
        await db
          .update(schema.taskDagIssues)
          .set({
            worktreePath: p.worktreePath,
            sandboxWorktreePath: p.sandboxWorktreePath,
            branchName: p.branchName,
            updatedAt: new Date(),
          })
          .where(eq(schema.taskDagIssues.id, issue.id));
      }
      await db
        .update(schema.taskDagLevels)
        .set({ phase: 'worktrees_ready', updatedAt: new Date() })
        .where(eq(schema.taskDagLevels.id, curLevel.id));
      continue;
    }

    // (B) Coders not dispatched yet.
    const undispatched = issues.filter(
      (i) => i.outcome === 'pending' && i.cliInvocationId === null,
    );
    if (undispatched.length > 0) {
      const preferred = await resolvePreferredCli(
        db,
        params.userId,
        stepDef.metadata.id,
        params.cliProviderId ?? null,
        providers,
        'coder',
        params.taskId,
        params.ignoreSavedStepClis ?? false,
      );
      const upstreamDebt = await buildUpstreamDebt(db, plan.id, curLevel.level);
      let dispatched = 0;
      for (const issue of undispatched) {
        const prompt = spec.buildCoderPrompt(coderContext(issue), upstreamDebt);
        const planDispatch = resolveDispatch({
          providers,
          preferredProviderId: preferred,
          input: { kind: 'prompt', prompt, capabilities: spec.requiredCapabilities },
          invokeOpts: { cwd: issue.sandboxWorktreePath ?? undefined },
        });
        if (
          planDispatch.mode === 'skip' ||
          !planDispatch.invocation ||
          planDispatch.invocation.kind !== 'cli'
        ) {
          await db
            .update(schema.taskDagIssues)
            .set({
              outcome: 'failed_unrecoverable',
              errorMessage: `no cli provider available: ${planDispatch.reason}`,
              endedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(schema.taskDagIssues.id, issue.id));
          continue;
        }
        const inv = await db
          .insert(schema.cliInvocations)
          .values({
            taskId: ctx.taskId,
            taskStepId: current.id,
            cliProviderId: planDispatch.providerId,
            mode: 'cli',
            prompt,
          })
          .returning({ id: schema.cliInvocations.id });
        const invId = inv[0]?.id;
        if (!invId) throw new Error('06c-dag-execute: failed to insert cli_invocations row');
        // Atomic claim: only the pass that flips pending→running owns the issue;
        // a concurrent re-entry that lost the race voids its orphan invocation.
        const claim = await db
          .update(schema.taskDagIssues)
          .set({
            outcome: 'running',
            cliInvocationId: invId,
            startedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(eq(schema.taskDagIssues.id, issue.id), eq(schema.taskDagIssues.outcome, 'pending')),
          )
          .returning({ id: schema.taskDagIssues.id });
        if (claim.length === 0) {
          await db
            .update(schema.cliInvocations)
            .set({ supersededAt: new Date() })
            .where(eq(schema.cliInvocations.id, invId));
          continue;
        }
        await deps.enqueueCliInvocation({
          invocationId: invId,
          taskId: ctx.taskId,
          taskStepId: current.id,
          userId: params.userId,
          cliProviderId: planDispatch.providerId,
          kind: 'cli',
          spec: planDispatch.invocation.spec,
          timeoutMs: spec.timeoutMs,
        });
        dispatched += 1;
      }
      await db
        .update(schema.taskDagLevels)
        .set({ phase: 'coding', updatedAt: new Date() })
        .where(eq(schema.taskDagLevels.id, curLevel.id));
      const updated = await setStepStatus(db, current.id, {
        status: 'waiting_cli',
        statusMessage: `Implementing level ${curLevel.level} (${dispatched} issue(s))…`,
      });
      ctx.logger.info(
        { level: curLevel.level, dispatched, planId: plan.id },
        'dag level coders dispatched',
      );
      return { resolved: false, result: { status: 'waiting_cli', row: updated } };
    }

    // (C) Coders in flight — ingest any that finished; wait if any still running.
    const running = issues.filter((i) => i.outcome === 'running');
    if (running.length > 0) {
      let anyInFlight = false;
      for (const issue of running) {
        if (!issue.cliInvocationId) {
          // Claimed but the dispatch crashed before enqueue — wait for recovery.
          anyInFlight = true;
          continue;
        }
        const inv = await db.query.cliInvocations.findFirst({
          where: eq(schema.cliInvocations.id, issue.cliInvocationId),
        });
        if (!inv || inv.endedAt === null) {
          anyInFlight = true;
          continue;
        }
        const result = parseCoderResult(inv);
        await db
          .update(schema.taskDagIssues)
          .set({
            outcome: result.outcome,
            filesModified: result.filesModified,
            debtItems: result.debtItems,
            concerns: result.concerns,
            rawOutput: inv.rawOutput ?? null,
            endedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.taskDagIssues.id, issue.id));
        await db
          .update(schema.cliInvocations)
          .set({ consumedAt: new Date() })
          .where(eq(schema.cliInvocations.id, inv.id));
      }
      if (anyInFlight) {
        return { resolved: false, result: { status: 'waiting_cli', row: current } };
      }
      continue; // all ingested — re-read + proceed to merge/checkpoint
    }

    // (D) Coder failures. With the escalation path (review on) mark them so the
    // issue-advisor can act; otherwise fail the step (recovery via retry/retry_ai).
    const coderFailed = issues.filter((i) => i.outcome === 'failed_unrecoverable');
    if (coderFailed.length > 0 && !plan.reviewEnabled) {
      const msg = `DAG level ${curLevel.level} failed: ${coderFailed.map((f) => f.issueKey).join(', ')}`;
      const updated = await setStepStatus(db, current.id, {
        status: 'failed',
        errorMessage: msg,
        endedAt: new Date(),
      });
      return { resolved: false, result: { status: 'failed', row: updated, error: msg } };
    }
    for (const f of coderFailed) {
      if (plan.reviewEnabled && f.resolution === null) {
        await db
          .update(schema.taskDagIssues)
          .set({ resolution: 'failed_unrecoverable', updatedAt: new Date() })
          .where(eq(schema.taskDagIssues.id, f.id));
      }
    }

    // (D.5 / D.6) Review loop then escalation (when enabled). Review resolves each
    // completed issue; escalation (issue-advisor -> replanner) handles failures.
    // A 'reloop' re-processes the level after a retry / split / skip.
    if (plan.reviewEnabled) {
      const reReadLevel = async () =>
        (await db
          .select()
          .from(schema.taskDagIssues)
          .where(
            and(
              eq(schema.taskDagIssues.dagPlanId, plan.id),
              eq(schema.taskDagIssues.level, curLevel.level),
            ),
          )) as DagIssueRow[];

      const review = await resolveReviewPhase({
        db,
        issues,
        level: curLevel,
        current,
        params,
        stepDef,
        providers,
        deps,
        taskId: ctx.taskId,
      });
      if (review.status === 'waiting') {
        return { resolved: false, result: { status: 'waiting_cli', row: review.row } };
      }
      current = review.row;
      issues = await reReadLevel();

      const escalation = await resolveEscalationPhase({
        db,
        issues,
        level: curLevel,
        current,
        params,
        stepDef,
        providers,
        deps,
        taskId: ctx.taskId,
        plan,
      });
      if (escalation.status === 'waiting') {
        return { resolved: false, result: { status: 'waiting_cli', row: escalation.row } };
      }
      if (escalation.status === 'aborted') {
        return {
          resolved: false,
          result: { status: 'failed', row: escalation.row, error: escalation.error ?? 'aborted' },
        };
      }
      if (escalation.status === 'reloop') continue;
      current = escalation.row;
      issues = await reReadLevel();
    }

    // (E) Commit each issue's work, then merge — git-first, conflicts held for
    // "Retry with LLM" (the step halts until every branch merges).
    await ctx.emitProgress(`Merging level ${curLevel.level}…`);
    for (const issue of issues) {
      if (issue.worktreePath && issue.mergeStatus === null) {
        await commitIssueWork(ctx, issue.worktreePath, issue, gitEnv);
      }
    }
    const merge = await runLevelMerge({
      db,
      integration,
      level: curLevel,
      issues,
      gitEnv,
      current,
      params,
      stepDef,
      providers,
      deps,
      autoResolve: plan.autoResolveConflicts,
      reviewEnabled: plan.reviewEnabled,
    });
    if (merge.status === 'waiting') {
      return { resolved: false, result: { status: 'waiting_cli', row: merge.row } };
    }
    if (merge.status === 'halt') {
      return {
        resolved: false,
        result: { status: 'failed', row: merge.row, error: merge.error ?? 'merge halted' },
      };
    }
    current = merge.row;

    // (F) Cleanup worktrees + checkpoint, then advance to the next level.
    await cleanupLevelWorktrees(ctx, issues);
    await db
      .update(schema.taskDagLevels)
      .set({
        phase: 'checkpointed',
        checkpointedAt: new Date(),
        mergeState: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.taskDagLevels.id, curLevel.id));

    // Aggregate accumulated debt by severity across the whole DAG (for the summary).
    const debtRows = (await db
      .select({ debtItems: schema.taskDagIssues.debtItems })
      .from(schema.taskDagIssues)
      .where(eq(schema.taskDagIssues.dagPlanId, plan.id))) as { debtItems: unknown[] }[];
    const agg = { high: 0, medium: 0, low: 0, total: 0 };
    for (const r of debtRows) {
      for (const d of (r.debtItems ?? []) as Array<{ severity?: string }>) {
        const sev: 'high' | 'medium' | 'low' =
          d?.severity === 'high' || d?.severity === 'medium' ? d.severity : 'low';
        agg[sev] += 1;
        agg.total += 1;
      }
    }
    await db
      .update(schema.taskDagPlans)
      .set({ debtAggregate: agg, updatedAt: new Date() })
      .where(eq(schema.taskDagPlans.id, plan.id));

    ctx.logger.info({ level: curLevel.level, planId: plan.id }, 'dag level checkpointed');
  }
}
