import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { and, asc, desc, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { dagIssueResultSchema, reviewerOutputSchema, type ReviewerOutput } from '@haive/shared';
import type { StepCapability } from '@haive/shared';
import { resolveDispatch } from '../orchestrator/dispatcher.js';
import { resolveUserGitEnv } from '../secrets/user-git-identity.js';
import { extractFencedJson } from './steps/_fenced-json.js';
import { loadPreviousStepOutput, pathExists } from './steps/onboarding/_helpers.js';
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
  const dirName = `${integration.branch}--${issueKey}`;
  return {
    worktreePath: `${ctx.repoPath}/.haive/worktrees/${dirName}`,
    sandboxWorktreePath: `${ctx.sandboxWorkdir}/.haive/worktrees/${dirName}`,
    branchName: dirName,
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

/** True once the live merge in the integration worktree is committed with no
 *  unmerged paths (MERGE_HEAD gone). */
async function mergeCommitted(integrationPath: string): Promise<boolean> {
  const head = await gitRun(integrationPath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (head.code === 0) return false; // merge still open (not committed)
  const status = await gitRun(integrationPath, ['status', '--porcelain']);
  const unmerged = status.stdout.split('\n').some((l) => /^(DD|AU|UD|UA|DU|AA|UU) /.test(l));
  return !unmerged;
}

function mergeFixPrompt(issue: DagIssueRow): string {
  return [
    'A git merge conflict occurred while merging an implemented issue branch into the integration branch.',
    'Your working directory is the integration worktree, MID-MERGE — the conflict markers are live in the files.',
    `Conflicting branch: ${issue.branchName} (${issue.title}).`,
    '',
    "Resolve EVERY conflict correctly and semantically: combine both sides as the implementation intends; don't drop either side's work.",
    'Then stage the resolved files (git add -A) and COMPLETE the merge (git commit --no-edit).',
    'Do NOT run tests or any other commands. When the merge commit is created, stop.',
  ].join('\n');
}

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
  const prompt = mergeFixPrompt(issue);
  const preferred = await resolvePreferredCli(
    db,
    params.userId,
    stepDef.metadata.id,
    params.cliProviderId ?? null,
    providers,
    'default',
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
    const committed = await mergeCommitted(integration.path);
    if (target) {
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
    'approve = ready to merge. fix_required = non-blocking issues a fix coder can address. block = a fundamental problem that cannot be approved.',
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

/** Dispatch one review-loop agent (reviewer or fix-coder) into the issue
 *  worktree, recording a dag_agent_runs row. Returns false if no provider. */
async function spawnReviewAgent(
  ra: ReviewArgs,
  issue: DagIssueRow,
  role: 'reviewer' | 'coder',
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
    role === 'reviewer' ? 'reviewer' : 'coder',
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

  const plan = (await db.query.taskDagPlans.findFirst({
    where: eq(schema.taskDagPlans.taskId, ctx.taskId),
  })) as DagPlanRow | undefined;
  if (!plan || plan.mode !== 'dag') {
    // No DAG to run (shouldRun gates on mode==='dag'); finalize trivially.
    return { resolved: true, current };
  }

  const integration = await loadIntegrationWorktree(db, ctx.taskId);
  const gitEnv = await resolveUserGitEnv(db, ctx.userId).then((e) =>
    Object.keys(e).length > 0 ? e : FALLBACK_GIT_IDENTITY,
  );

  // Drive levels until a barrier (waiting_cli), a failure, or completion. Every
  // iteration re-reads the rows, so a crash resumes from the persisted state.
  // eslint-disable-next-line no-constant-condition
  while (true) {
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

    // (D) All coders terminal. Slice 3: any unrecoverable failure fails the step
    // (recovery actions surface; Slices 5-6 add review + escalation).
    const failed = issues.filter((i) => i.outcome === 'failed_unrecoverable');
    if (failed.length > 0) {
      const msg = `DAG level ${curLevel.level} failed: ${failed.map((f) => f.issueKey).join(', ')}`;
      const updated = await setStepStatus(db, current.id, {
        status: 'failed',
        errorMessage: msg,
        endedAt: new Date(),
      });
      return { resolved: false, result: { status: 'failed', row: updated, error: msg } };
    }

    // (D.5) Inner review loop (coder<->reviewer) when enabled → per-issue
    // resolution. A blocking verdict / exhausted budget fails the step (Slice 6
    // will escalate to the issue-advisor/replanner instead).
    if (plan.reviewEnabled) {
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
      issues = (await db
        .select()
        .from(schema.taskDagIssues)
        .where(
          and(
            eq(schema.taskDagIssues.dagPlanId, plan.id),
            eq(schema.taskDagIssues.level, curLevel.level),
          ),
        )) as DagIssueRow[];
      const reviewFailed = issues.filter((i) => i.resolution === 'failed_unrecoverable');
      if (reviewFailed.length > 0) {
        const msg = `DAG level ${curLevel.level} review blocked: ${reviewFailed
          .map((f) => f.issueKey)
          .join(', ')}`;
        const updated = await setStepStatus(db, current.id, {
          status: 'failed',
          errorMessage: msg,
          endedAt: new Date(),
        });
        return { resolved: false, result: { status: 'failed', row: updated, error: msg } };
      }
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
    ctx.logger.info({ level: curLevel.level, planId: plan.id }, 'dag level checkpointed');
  }
}
