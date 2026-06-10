import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
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

// Slice 4 integration smoke: two issues at one level both ADD the same file with
// different content (an add/add merge conflict). The executor merges the first
// clean, HOLDS the second (mergeStatus 'conflict') and HALTS the step. We then
// simulate "Retry with LLM" (the retry_ai API handler: set aiFixContext) and a
// fake fix agent that resolves the conflict + commits inside the integration
// worktree. The step then completes. Validates: git-first merge, held conflict,
// halt, retry_ai-driven resolution, completion.

const log = logger.child({ module: 'dag-merge-conflict-smoke' });

for (const k of ['DATABASE_URL', 'REDIS_URL', 'CONFIG_ENCRYPTION_KEY'] as const) {
  if (!process.env[k]) {
    console.error(`[smoke] missing env ${k}`);
    process.exit(2);
  }
}

const BRANCH = 'feat-conflict';
const CONFLICT_FILE = 'conflict.txt';

interface State {
  fixtureDir?: string;
  userId?: string;
  repoId?: string;
  taskId?: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
}

async function createFixture(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'haive-dag-conflict-'));
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
      emailEncrypted: 'dag-conflict@test.local',
      emailBlindIndex: `dagc-${randomBytes(4).toString('hex')}`,
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
        label: 'conflict smoke',
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
        name: 'dag-conflict',
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
        title: 'dag conflict smoke',
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

    // Fake spawner: a coder (linked to an issue) ADDS the conflict file with
    // issue-specific content; the merge-fix agent (not linked to any issue)
    // resolves the live conflict in the integration worktree + commits.
    const enqueueCliInvocation = async (payload: CliExecJobPayload): Promise<void> => {
      const issue = await db.query.taskDagIssues.findFirst({
        where: eq(schema.taskDagIssues.cliInvocationId, payload.invocationId),
      });
      if (issue?.worktreePath) {
        await writeFile(
          path.join(issue.worktreePath, CONFLICT_FILE),
          `content from ${issue.issueKey}\n`,
        );
        const result = {
          issue_id: issue.issueKey,
          outcome: 'completed',
          files_modified: [CONFLICT_FILE],
          debt_items: [],
          concerns: '',
        };
        await db
          .update(schema.cliInvocations)
          .set({
            exitCode: 0,
            rawOutput: '```json\n' + JSON.stringify(result) + '\n```',
            endedAt: new Date(),
          })
          .where(eq(schema.cliInvocations.id, payload.invocationId));
        return;
      }
      // Merge-fix agent: resolve the conflict markers + complete the merge.
      await writeFile(path.join(integrationWorktree, CONFLICT_FILE), 'resolved: 001 + 002\n');
      git(integrationWorktree, ['add', '-A']);
      git(integrationWorktree, ['commit', '--no-edit']);
      await db
        .update(schema.cliInvocations)
        .set({ exitCode: 0, rawOutput: 'merge resolved', endedAt: new Date() })
        .where(eq(schema.cliInvocations.id, payload.invocationId));
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

    // Phase A — drive until the merge conflict halts the step.
    let current = execStep!;
    let halted = false;
    for (let i = 0; i < 12 && !halted; i += 1) {
      const r = await resolveDagPhase(db, dagExecuteStep, current, ctx, params);
      if (r.resolved) throw new Error('expected a merge-conflict halt, but the DAG resolved');
      if (r.result.status === 'failed') {
        current = r.result.row;
        halted = true;
        break;
      }
      current = r.result.row;
    }
    if (!halted) throw new Error('step did not halt on the merge conflict');
    if (!/Retry with LLM/.test(current.errorMessage ?? '')) {
      throw new Error(`halt message unexpected: ${current.errorMessage}`);
    }
    const issuesAtHalt = await db
      .select()
      .from(schema.taskDagIssues)
      .where(eq(schema.taskDagIssues.dagPlanId, plan!.id));
    const conflicted = issuesAtHalt.filter((i) => i.mergeStatus === 'conflict');
    const cleanAtHalt = issuesAtHalt.filter((i) => i.mergeStatus === 'clean');
    if (conflicted.length !== 1 || cleanAtHalt.length !== 1) {
      throw new Error(
        `expected 1 clean + 1 conflict at halt, got clean=${cleanAtHalt.length} conflict=${conflicted.length}`,
      );
    }

    // Phase B — simulate the retry_ai API handler: set the fix marker, re-run.
    await db
      .update(schema.taskSteps)
      .set({
        status: 'running',
        errorMessage: null,
        endedAt: null,
        aiFixContext: { priorError: current.errorMessage ?? '', priorOutput: '' },
        updatedAt: new Date(),
      })
      .where(eq(schema.taskSteps.id, execStep!.id));
    current = (
      await db.select().from(schema.taskSteps).where(eq(schema.taskSteps.id, execStep!.id))
    )[0]!;

    // Phase C — drive until the conflict resolves + the DAG completes.
    let resolved = false;
    for (let i = 0; i < 12 && !resolved; i += 1) {
      const r = await resolveDagPhase(db, dagExecuteStep, current, ctx, params);
      if (r.resolved) {
        resolved = true;
        break;
      }
      if (r.result.status === 'failed') {
        throw new Error(`failed after retry_ai: ${(r.result as { error: string }).error}`);
      }
      current = r.result.row;
    }
    if (!resolved) throw new Error('did not resolve after retry_ai');

    // --- Assertions ---
    const finalIssues = await db
      .select()
      .from(schema.taskDagIssues)
      .where(eq(schema.taskDagIssues.dagPlanId, plan!.id));
    if (!finalIssues.every((i) => i.outcome === 'completed')) {
      throw new Error('not all issues completed');
    }
    const resolvedIssue = finalIssues.find((i) => i.mergeStatus === 'resolved');
    if (!resolvedIssue) throw new Error('no issue marked resolved after the fix');
    const level0 = (
      await db
        .select()
        .from(schema.taskDagLevels)
        .where(eq(schema.taskDagLevels.dagPlanId, plan!.id))
    )[0]!;
    if (level0.checkpointedAt === null) throw new Error('level not checkpointed after resolution');

    const content = readFileSync(path.join(integrationWorktree, CONFLICT_FILE), 'utf8');
    if (/<<<<<<<|>>>>>>>/.test(content))
      throw new Error('conflict markers remain in the merged file');
    for (const key of ['ISSUE-001', 'ISSUE-002']) {
      if (existsSync(path.join(repoPath, '.haive', 'worktrees', `${BRANCH}--${key}`))) {
        throw new Error(`worktree not cleaned: ${key}`);
      }
    }

    console.log(
      JSON.stringify({
        smoke: 'DAG_MERGE_CONFLICT_OK',
        resolvedIssue: resolvedIssue.issueKey,
        mergedContent: content.trim(),
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
