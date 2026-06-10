import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  configService,
  secretsService,
  userSecretsService,
  logger,
  type CliExecJobPayload,
} from '@haive/shared';
import { initDatabase, getDb } from '../src/db.js';
import { initRedis, closeRedis } from '../src/redis.js';
import { closeTaskQueue } from '../src/queues/task-queue.js';
import { SANDBOX_WORKDIR } from '../src/sandbox/sandbox-runner.js';
import { resolveDagPhase } from '../src/step-engine/dag-executor.js';
import { dagExecuteStep } from '../src/step-engine/steps/workflow/06c-dag-execute.js';
import { TaskCancelledError, type StepContext } from '../src/step-engine/step-definition.js';
import type { AdvanceStepParams } from '../src/step-engine/step-runner.js';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';

// Slice 6 escalation smoke: two issues, both review-BLOCKED. The issue-advisor
// then ACCEPTS ISSUE-001 with debt (it merges) and ESCALATES ISSUE-002, which
// triggers the replanner -> CONTINUE (ISSUE-002 is skipped). Validates the
// middle loop (advisor), the outer loop (replanner), debt aggregation, and the
// reloop control flow.

const log = logger.child({ module: 'dag-escalation-smoke' });

for (const k of ['DATABASE_URL', 'REDIS_URL', 'CONFIG_ENCRYPTION_KEY'] as const) {
  if (!process.env[k]) {
    console.error(`[smoke] missing env ${k}`);
    process.exit(2);
  }
}

const BRANCH = 'feat-escalation';

interface State {
  fixtureDir?: string;
  userId?: string;
  repoId?: string;
  taskId?: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
}

function fence(obj: unknown): string {
  return '```json\n' + JSON.stringify(obj) + '\n```';
}

async function createFixture(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'haive-dag-esc-'));
  await writeFile(path.join(dir, 'README.md'), '# fixture\n');
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'smoke@test.local']);
  git(dir, ['config', 'user.name', 'Smoke']);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'initial']);
  await writeFile(path.join(dir, '.git', 'info', 'exclude'), '.haive/\n');
  git(dir, [
    'worktree',
    'add',
    path.join(dir, '.haive', 'worktrees', BRANCH),
    '-b',
    BRANCH,
    'main',
  ]);
  return dir;
}

async function main(): Promise<void> {
  const state: State = {};
  let exitCode = 0;
  try {
    initRedis(process.env.REDIS_URL!);
    await configService.initialize(process.env.REDIS_URL!);
    const db = initDatabase(process.env.DATABASE_URL!);
    await secretsService.initialize(db);
    await userSecretsService.initialize(db, await secretsService.getMasterKek());

    state.fixtureDir = await createFixture();
    const repoPath = state.fixtureDir;
    const integrationWorktree = path.join(repoPath, '.haive', 'worktrees', BRANCH);

    const now = new Date();
    const userId = randomUUID();
    state.userId = userId;
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'dag-esc@test.local',
      emailBlindIndex: `dage-${randomBytes(4).toString('hex')}`,
      passwordHash: 'x',
      role: 'user',
      status: 'active',
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    const [provider] = await db
      .insert(schema.cliProviders)
      .values({
        userId,
        name: 'claude-code',
        label: 'esc smoke',
        executablePath: '/bin/true',
        supportsSubagents: true,
        authMode: 'subscription',
        enabled: true,
      })
      .returning();
    const [repo] = await db
      .insert(schema.repositories)
      .values({
        userId,
        name: 'dag-esc',
        source: 'local_path',
        localPath: repoPath,
        storagePath: repoPath,
        status: 'ready',
      })
      .returning();
    state.repoId = repo!.id;
    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId,
        repositoryId: repo!.id,
        cliProviderId: provider!.id,
        type: 'workflow',
        title: 'dag escalation smoke',
        status: 'running',
      })
      .returning();
    state.taskId = task!.id;

    await db.insert(schema.taskSteps).values({
      taskId: task!.id,
      stepId: '01-worktree-setup',
      stepIndex: 1,
      title: 'Worktree setup',
      status: 'done',
      output: {
        worktreePath: integrationWorktree,
        sandboxWorktreePath: `${SANDBOX_WORKDIR}/.haive/worktrees/${BRANCH}`,
        branchName: BRANCH,
      },
    });
    const [planStep] = await db
      .insert(schema.taskSteps)
      .values({
        taskId: task!.id,
        stepId: '06b-sprint-planning',
        stepIndex: 6.2,
        title: 'Sprint planning',
        status: 'done',
        output: { mode: 'dag' },
      })
      .returning();
    const levels = [['ISSUE-001', 'ISSUE-002']];
    const [plan] = await db
      .insert(schema.taskDagPlans)
      .values({
        taskId: task!.id,
        taskStepId: planStep!.id,
        mode: 'dag',
        maxParallel: 2,
        levels,
        planJson: {},
        reviewEnabled: true,
      })
      .returning();
    await db.insert(schema.taskDagLevels).values({
      dagPlanId: plan!.id,
      level: 0,
      issueKeys: levels[0],
      phase: 'pending',
    });
    for (const key of ['ISSUE-001', 'ISSUE-002']) {
      await db.insert(schema.taskDagIssues).values({
        dagPlanId: plan!.id,
        taskId: task!.id,
        issueKey: key,
        level: 0,
        title: `Implement ${key}`,
        acceptanceCriteria: [`${key} works`],
        outcome: 'pending',
      });
    }
    const [execStep] = await db
      .insert(schema.taskSteps)
      .values({
        taskId: task!.id,
        stepId: '06c-dag-execute',
        stepIndex: 6.5,
        title: 'DAG implementation',
        status: 'running',
      })
      .returning();

    const enqueueCliInvocation = async (payload: CliExecJobPayload): Promise<void> => {
      const finish = (out: unknown) =>
        db
          .update(schema.cliInvocations)
          .set({ exitCode: 0, rawOutput: fence(out), endedAt: new Date() })
          .where(eq(schema.cliInvocations.id, payload.invocationId));

      const issue = await db.query.taskDagIssues.findFirst({
        where: eq(schema.taskDagIssues.cliInvocationId, payload.invocationId),
      });
      if (issue?.worktreePath) {
        await writeFile(
          path.join(issue.worktreePath, `${issue.issueKey}.txt`),
          `impl ${issue.issueKey}\n`,
        );
        await finish({
          issue_id: issue.issueKey,
          outcome: 'completed',
          files_modified: [`${issue.issueKey}.txt`],
          debt_items: [],
          concerns: '',
        });
        return;
      }
      const run = await db.query.dagAgentRuns.findFirst({
        where: eq(schema.dagAgentRuns.cliInvocationId, payload.invocationId),
      });
      if (run) {
        if (run.role === 'reviewer') {
          await finish({
            verdict: 'block',
            criteria_results: [],
            issues: [{ severity: 'high', description: 'fundamentally broken' }],
          });
          return;
        }
        if (run.role === 'issue_advisor') {
          const issRow = await db.query.taskDagIssues.findFirst({
            where: eq(schema.taskDagIssues.id, run.dagIssueId),
          });
          await finish(
            issRow?.issueKey === 'ISSUE-001'
              ? { action: 'ACCEPT_WITH_DEBT', reasoning: 'good enough' }
              : { action: 'ESCALATE_TO_REPLAN', reasoning: 'plan is wrong' },
          );
          return;
        }
        await finish({
          issue_id: 'x',
          outcome: 'completed',
          files_modified: [],
          debt_items: [],
          concerns: '',
        });
        return;
      }
      // plan-level replanner.
      const planRow = await db.query.taskDagPlans.findFirst({
        where: eq(schema.taskDagPlans.replannerInvocationId, payload.invocationId),
      });
      if (planRow) {
        await finish({
          action: 'CONTINUE',
          reasoning: 'skip the broken issue',
          skip_downstream: ['ISSUE-002'],
        });
        return;
      }
      await finish('unexpected');
    };

    const controller = new AbortController();
    const ctx: StepContext = {
      taskId: task!.id,
      taskStepId: execStep!.id,
      userId,
      repoPath,
      workspacePath: repoPath,
      sandboxWorkdir: SANDBOX_WORKDIR,
      cliProviderId: provider!.id,
      db,
      logger: log.child({ stepId: '06c-dag-execute' }),
      signal: controller.signal,
      throwIfCancelled: () => {
        if (controller.signal.aborted) throw new TaskCancelledError();
      },
      async emitProgress() {},
    };
    const params: AdvanceStepParams = {
      db,
      taskId: task!.id,
      userId,
      repoPath,
      workspacePath: repoPath,
      cliProviderId: provider!.id,
      stepDef: dagExecuteStep,
      providers: [provider as CliProviderRecord],
      deps: { enqueueCliInvocation },
    };

    let current = execStep!;
    let resolved = false;
    for (let i = 0; i < 30 && !resolved; i += 1) {
      const r = await resolveDagPhase(db, dagExecuteStep, current, ctx, params);
      if (r.resolved) {
        resolved = true;
        break;
      }
      if (r.result.status === 'failed') {
        throw new Error(`escalation smoke failed: ${(r.result as { error: string }).error}`);
      }
      current = r.result.row;
    }
    if (!resolved) throw new Error('escalation smoke did not complete');

    // --- Assertions ---
    const issues = await db
      .select()
      .from(schema.taskDagIssues)
      .where(eq(schema.taskDagIssues.dagPlanId, plan!.id));
    const i1 = issues.find((i) => i.issueKey === 'ISSUE-001')!;
    const i2 = issues.find((i) => i.issueKey === 'ISSUE-002')!;
    if (i1.resolution !== 'completed_with_debt') {
      throw new Error(`ISSUE-001 expected completed_with_debt, got ${i1.resolution}`);
    }
    if (i1.mergeStatus !== 'clean') throw new Error('ISSUE-001 should be merged');
    if (i2.resolution !== 'skipped')
      throw new Error(`ISSUE-002 expected skipped, got ${i2.resolution}`);
    if (i1.advisorInvocations !== 1 || i2.advisorInvocations !== 1) {
      throw new Error('expected one advisor invocation per issue');
    }
    const finalPlan = await db.query.taskDagPlans.findFirst({
      where: eq(schema.taskDagPlans.id, plan!.id),
    });
    if (finalPlan!.replannerInvocations !== 1 || finalPlan!.lastReplannerAction !== 'CONTINUE') {
      throw new Error(
        `expected 1 replanner CONTINUE, got ${finalPlan!.replannerInvocations}/${finalPlan!.lastReplannerAction}`,
      );
    }
    const debt = finalPlan!.debtAggregate as { total?: number };
    if (!debt || (debt.total ?? 0) < 1) throw new Error('expected debt aggregated from the accept');

    console.log(
      JSON.stringify({
        smoke: 'DAG_ESCALATION_OK',
        i1: i1.resolution,
        i2: i2.resolution,
        replanner: finalPlan!.lastReplannerAction,
        debt: finalPlan!.debtAggregate,
      }),
    );
  } catch (err) {
    exitCode = 1;
    log.error({ err }, 'smoke failed');
    console.error('[smoke] FAILED:', err);
  } finally {
    try {
      const db = getDb();
      if (state.taskId) await db.delete(schema.tasks).where(eq(schema.tasks.id, state.taskId));
      if (state.repoId) {
        await db.delete(schema.repositories).where(eq(schema.repositories.id, state.repoId));
      }
      if (state.userId) await db.delete(schema.users).where(eq(schema.users.id, state.userId));
    } catch (cleanupErr) {
      log.warn({ err: cleanupErr }, 'db cleanup failed');
    }
    if (state.fixtureDir) {
      try {
        git(state.fixtureDir, ['worktree', 'prune']);
      } catch {
        /* ignore */
      }
      await rm(state.fixtureDir, { recursive: true, force: true }).catch(() => {});
    }
    await closeTaskQueue().catch(() => {});
    await closeRedis().catch(() => {});
    process.exit(exitCode);
  }
}

void main();
