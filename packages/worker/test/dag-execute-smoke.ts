import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
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

// Integration smoke for resolveDagPhase (Slice 3). Drives the executor directly
// against a real git fixture + Postgres, simulating each coder with a fake
// enqueueCliInvocation that writes a file in the issue worktree and stores an
// ISSUE_RESULT_JSON. Asserts: per-level worktrees created, coders ingested, each
// branch committed + merged into the integration branch, worktrees cleaned, all
// levels checkpointed. Plan shape: level 0 = [ISSUE-001, ISSUE-002] (parallel),
// level 1 = [ISSUE-003] (depends on both) — exercises the barrier.

const log = logger.child({ module: 'dag-execute-smoke' });

const REQUIRED_ENV = ['DATABASE_URL', 'REDIS_URL', 'CONFIG_ENCRYPTION_KEY'] as const;
for (const k of REQUIRED_ENV) {
  if (!process.env[k]) {
    console.error(`[smoke] missing env ${k}`);
    process.exit(2);
  }
}

const INTEGRATION_BRANCH = 'feat-dag';

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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'haive-dag-smoke-'));
  await writeFile(path.join(dir, 'README.md'), '# fixture\n');
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'smoke@test.local']);
  git(dir, ['config', 'user.name', 'Smoke']);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'initial']);
  // Exclude .haive so the per-issue worktrees never show as repo changes.
  await writeFile(path.join(dir, '.git', 'info', 'exclude'), '.haive/\n');
  // Integration worktree (what 01-worktree-setup would create).
  git(dir, [
    'worktree',
    'add',
    path.join(dir, '.haive', 'worktrees', INTEGRATION_BRANCH),
    '-b',
    INTEGRATION_BRANCH,
    'main',
  ]);
  return dir;
}

async function main(): Promise<void> {
  const state: State = {};
  let exitCode = 0;
  try {
    log.info('bootstrapping');
    initRedis(process.env.REDIS_URL!);
    await configService.initialize(process.env.REDIS_URL!);
    const db = initDatabase(process.env.DATABASE_URL!);
    await secretsService.initialize(db);
    const masterKek = await secretsService.getMasterKek();
    await userSecretsService.initialize(db, masterKek);

    state.fixtureDir = await createFixture();
    const repoPath = state.fixtureDir;
    const integrationWorktree = path.join(repoPath, '.haive', 'worktrees', INTEGRATION_BRANCH);
    log.info({ repoPath }, 'fixture + integration worktree created');

    const now = new Date();
    const userId = randomUUID();
    state.userId = userId;
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'dag-smoke@test.local',
      emailBlindIndex: `dag-${randomBytes(4).toString('hex')}`,
      passwordHash: 'smoke-not-real',
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
        label: 'dag smoke',
        executablePath: '/bin/true',
        supportsSubagents: true,
        authMode: 'subscription',
        enabled: true,
      })
      .returning();
    if (!provider) throw new Error('provider insert failed');

    const [repo] = await db
      .insert(schema.repositories)
      .values({
        userId,
        name: 'dag-smoke-fixture',
        source: 'local_path',
        localPath: repoPath,
        storagePath: repoPath,
        status: 'ready',
      })
      .returning();
    if (!repo) throw new Error('repo insert failed');
    state.repoId = repo.id;

    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId,
        repositoryId: repo.id,
        cliProviderId: provider.id,
        type: 'workflow',
        title: 'dag smoke',
        status: 'running',
      })
      .returning();
    if (!task) throw new Error('task insert failed');
    state.taskId = task.id;

    // Seed the prior steps the executor reads: 01-worktree-setup (integration
    // worktree) and 06b-sprint-planning (mode=dag + the plan).
    const [worktreeStep] = await db
      .insert(schema.taskSteps)
      .values({
        taskId: task.id,
        stepId: '01-worktree-setup',
        stepIndex: 1,
        title: 'Worktree setup',
        status: 'done',
        output: {
          mode: 'worktree',
          worktreePath: integrationWorktree,
          sandboxWorktreePath: `${SANDBOX_WORKDIR}/.haive/worktrees/${INTEGRATION_BRANCH}`,
          branchName: INTEGRATION_BRANCH,
        },
      })
      .returning();
    if (!worktreeStep) throw new Error('worktree step insert failed');

    const [planStep] = await db
      .insert(schema.taskSteps)
      .values({
        taskId: task.id,
        stepId: '06b-sprint-planning',
        stepIndex: 6.2,
        title: 'Sprint planning',
        status: 'done',
        output: { mode: 'dag' },
      })
      .returning();
    if (!planStep) throw new Error('plan step insert failed');

    const levels = [['ISSUE-001', 'ISSUE-002'], ['ISSUE-003']];
    const [plan] = await db
      .insert(schema.taskDagPlans)
      .values({
        taskId: task.id,
        taskStepId: planStep.id,
        mode: 'dag',
        rationale: 'smoke',
        maxParallel: 2,
        levels,
        planJson: {},
      })
      .returning();
    if (!plan) throw new Error('plan insert failed');

    for (let i = 0; i < levels.length; i += 1) {
      await db.insert(schema.taskDagLevels).values({
        dagPlanId: plan.id,
        level: i,
        issueKeys: levels[i],
        phase: 'pending',
      });
    }
    const issueDefs = [
      { key: 'ISSUE-001', level: 0, deps: [] as string[] },
      { key: 'ISSUE-002', level: 0, deps: [] as string[] },
      { key: 'ISSUE-003', level: 1, deps: ['ISSUE-001', 'ISSUE-002'] },
    ];
    for (const d of issueDefs) {
      await db.insert(schema.taskDagIssues).values({
        dagPlanId: plan.id,
        taskId: task.id,
        issueKey: d.key,
        level: d.level,
        title: `Implement ${d.key}`,
        specSections: [`Section ${d.key}`],
        acceptanceCriteria: [`${d.key} works`],
        dependsOn: d.deps,
        outcome: 'pending',
      });
    }

    // The 06c step row the executor drives.
    const [execStep] = await db
      .insert(schema.taskSteps)
      .values({
        taskId: task.id,
        stepId: '06c-dag-execute',
        stepIndex: 6.5,
        title: 'DAG implementation',
        status: 'running',
      })
      .returning();
    if (!execStep) throw new Error('exec step insert failed');

    // Fake coder: write a file in the issue's worktree (so the merge has real
    // content) + store an ISSUE_RESULT_JSON, completing the invocation
    // synchronously. The next resolveDagPhase pass ingests + merges it.
    const enqueueCliInvocation = async (payload: CliExecJobPayload): Promise<void> => {
      const issue = await db.query.taskDagIssues.findFirst({
        where: eq(schema.taskDagIssues.cliInvocationId, payload.invocationId),
      });
      if (!issue?.worktreePath)
        throw new Error(`fake coder: no issue/worktree for ${payload.invocationId}`);
      await writeFile(
        path.join(issue.worktreePath, `${issue.issueKey}.txt`),
        `impl ${issue.issueKey}\n`,
      );
      const result = {
        issue_id: issue.issueKey,
        outcome: 'completed',
        files_modified: [`${issue.issueKey}.txt`],
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
    };

    const controller = new AbortController();
    const ctx: StepContext = {
      taskId: task.id,
      taskStepId: execStep.id,
      userId,
      repoPath,
      workspacePath: repoPath,
      sandboxWorkdir: SANDBOX_WORKDIR,
      cliProviderId: provider.id,
      db,
      logger: log.child({ stepId: '06c-dag-execute' }),
      signal: controller.signal,
      throwIfCancelled: () => {
        if (controller.signal.aborted) throw new TaskCancelledError();
      },
      async emitProgress() {
        /* no-op for the smoke */
      },
    };
    const params: AdvanceStepParams = {
      db,
      taskId: task.id,
      userId,
      repoPath,
      workspacePath: repoPath,
      cliProviderId: provider.id,
      stepDef: dagExecuteStep,
      providers: [provider as CliProviderRecord],
      deps: { enqueueCliInvocation },
    };

    // Drive the executor: each pass either dispatches a level (the fake coder
    // completes it), ingests + merges + checkpoints, or resolves.
    let current = execStep;
    let resolved = false;
    for (let i = 0; i < 12 && !resolved; i += 1) {
      const r = await resolveDagPhase(db, dagExecuteStep, current, ctx, params);
      if (r.resolved) {
        resolved = true;
        break;
      }
      if (r.result.status === 'failed') {
        throw new Error(`dag step failed: ${(r.result as { error: string }).error}`);
      }
      current = r.result.row;
    }
    if (!resolved) throw new Error('dag did not resolve within 12 passes');

    // --- Assertions ---
    const issues = await db
      .select()
      .from(schema.taskDagIssues)
      .where(eq(schema.taskDagIssues.dagPlanId, plan.id));
    const notCompleted = issues.filter((it) => it.outcome !== 'completed');
    if (notCompleted.length > 0) {
      throw new Error(
        `issues not completed: ${notCompleted.map((i) => `${i.issueKey}=${i.outcome}`).join(', ')}`,
      );
    }
    const allMerged = issues.every((it) => it.mergeStatus === 'clean');
    if (!allMerged) throw new Error('not all issues merged');

    const dagLevels = await db
      .select()
      .from(schema.taskDagLevels)
      .where(eq(schema.taskDagLevels.dagPlanId, plan.id));
    const uncheckpointed = dagLevels.filter((l) => l.checkpointedAt === null);
    if (uncheckpointed.length > 0) {
      throw new Error(`levels not checkpointed: ${uncheckpointed.map((l) => l.level).join(', ')}`);
    }

    // Integration branch must contain every issue's file (merged in dep order).
    for (const d of issueDefs) {
      const tracked = git(integrationWorktree, ['ls-files', `${d.key}.txt`]).trim();
      if (tracked !== `${d.key}.txt`) {
        throw new Error(`integration branch missing ${d.key}.txt (ls-files: "${tracked}")`);
      }
    }
    // Merge commits exist (--no-ff).
    const logOut = git(integrationWorktree, ['log', '--oneline']);
    const mergeCommits = logOut.split('\n').filter((l) => /Merge/i.test(l)).length;
    if (mergeCommits < 3) {
      throw new Error(`expected >=3 merge commits, found ${mergeCommits}`);
    }

    // Issue worktrees cleaned up.
    for (const d of issueDefs) {
      const wt = path.join(repoPath, '.haive', 'worktrees', `${INTEGRATION_BRANCH}--${d.key}`);
      if (existsSync(wt)) throw new Error(`issue worktree not cleaned: ${wt}`);
    }

    console.log(
      JSON.stringify({
        smoke: 'DAG_EXECUTE_OK',
        issues: issues.map((i) => ({ key: i.issueKey, outcome: i.outcome, merge: i.mergeStatus })),
        levels: dagLevels.length,
        mergeCommits,
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
      // Prune worktree registrations before removing the dir.
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
