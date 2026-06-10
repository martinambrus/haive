import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { and, asc, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { dagIssueResultSchema } from '@haive/shared';
import { resolveDispatch } from '../orchestrator/dispatcher.js';
import { resolveUserGitEnv } from '../secrets/user-git-identity.js';
import { extractFencedJson } from './steps/_fenced-json.js';
import { loadPreviousStepOutput, pathExists } from './steps/onboarding/_helpers.js';
import type { DagCoderContext, StepContext, StepDefinition } from './step-definition.js';
import { resolvePreferredCli } from './step-runner.js';
import type { AdvanceStepParams, AdvanceStepResult, TaskStepRow } from './step-runner.js';

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
}

async function loadIntegrationWorktree(db: Database, taskId: string): Promise<IntegrationWorktree> {
  const wt = await loadPreviousStepOutput(db, taskId, '01-worktree-setup');
  const out = wt?.output as { worktreePath?: string; branchName?: string } | null;
  if (!out?.worktreePath || !out.branchName) {
    throw new Error('06c-dag-execute requires 01-worktree-setup to have produced a worktree');
  }
  return { path: out.worktreePath, branch: out.branchName };
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

/** Merge this level's issue branches into the integration branch (Slice 3:
 *  clean merges only; a conflict throws and fails the step — Slice 4 replaces
 *  this with held conflicts + retry_ai resolution). */
async function mergeLevel(
  db: Database,
  integration: IntegrationWorktree,
  issues: DagIssueRow[],
  gitEnv: Record<string, string>,
): Promise<void> {
  for (const issue of issues) {
    if (issue.outcome !== 'completed' && issue.outcome !== 'completed_with_debt') continue;
    if (issue.mergeStatus === 'clean') continue;
    if (!issue.branchName) continue;
    const merge = await gitRun(
      integration.path,
      ['merge', '--no-ff', '--no-edit', issue.branchName],
      gitEnv,
    );
    if (merge.code !== 0) {
      await gitRun(integration.path, ['merge', '--abort']);
      throw new Error(
        `merge conflict on ${issue.branchName} (conflict resolution lands in Slice 4): ${
          merge.stderr || merge.stdout
        }`.slice(0, 1500),
      );
    }
    await db
      .update(schema.taskDagIssues)
      .set({ mergeStatus: 'clean', mergedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.taskDagIssues.id, issue.id));
  }
}

async function cleanupLevelWorktrees(ctx: StepContext, issues: DagIssueRow[]): Promise<void> {
  for (const issue of issues) {
    if (!issue.worktreePath) continue;
    await gitRun(ctx.repoPath, ['worktree', 'remove', '--force', issue.worktreePath]);
  }
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

    const issues = (await db
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

    // (E) Commit each issue's work, then merge the branches into integration.
    await ctx.emitProgress(`Merging level ${curLevel.level}…`);
    for (const issue of issues) {
      if (issue.worktreePath) await commitIssueWork(ctx, issue.worktreePath, issue, gitEnv);
    }
    await mergeLevel(db, integration, issues, gitEnv);

    // (F) Cleanup worktrees + checkpoint, then advance to the next level.
    await cleanupLevelWorktrees(ctx, issues);
    await db
      .update(schema.taskDagLevels)
      .set({ phase: 'checkpointed', checkpointedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.taskDagLevels.id, curLevel.id));
    ctx.logger.info({ level: curLevel.level, planId: plan.id }, 'dag level checkpointed');
  }
}
