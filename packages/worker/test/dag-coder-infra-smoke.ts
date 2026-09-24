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
import { loadLedgerEntries } from '../src/step-engine/task-ledger.js';
import { dagExecuteStep } from '../src/step-engine/steps/workflow/06c-dag-execute.js';
import { TaskCancelledError, type StepContext } from '../src/step-engine/step-definition.js';
import type { AdvanceStepParams } from '../src/step-engine/step-runner.js';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';

// Three level coders, review off. FREE dies before its run starts and CHARGED dies after, so
// each is re-dispatched, and only CHARGED spends an infrastructure retry. PROSE exits 0 with
// no result block, which fails the level; the ledger must carry what the coders reported and
// nothing Haive wrote in PROSE's place.

const log = logger.child({ module: 'dag-coder-infra-smoke' });

for (const k of ['DATABASE_URL', 'REDIS_URL', 'CONFIG_ENCRYPTION_KEY'] as const) {
  if (!process.env[k]) {
    console.error(`[smoke] missing env ${k}`);
    process.exit(2);
  }
}

const BRANCH = 'feat-infra';
const KEYS = ['ISSUE-FREE', 'ISSUE-CHARGED', 'ISSUE-PROSE'] as const;
const concernOf = (key: string) => `${key} learned the fixture has no build step`;

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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'haive-dag-infra-'));
  await writeFile(path.join(dir, 'README.md'), '# fixture\n');
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'smoke@test.local']);
  git(dir, ['config', 'user.name', 'Smoke']);
  git(dir, ['config', 'gc.auto', '0']);
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
      emailEncrypted: 'dag-infra@test.local',
      emailBlindIndex: `dagi-${randomBytes(4).toString('hex')}`,
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
        label: 'infra smoke',
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
        name: 'dag-infra',
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
        title: 'dag coder infra smoke',
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
    const levels = [[...KEYS]];
    const [plan] = await db
      .insert(schema.taskDagPlans)
      .values({
        taskId: task!.id,
        taskStepId: planStep!.id,
        mode: 'dag',
        maxParallel: KEYS.length,
        levels,
        planJson: {},
        reviewEnabled: false,
      })
      .returning();
    await db.insert(schema.taskDagLevels).values({
      dagPlanId: plan!.id,
      level: 0,
      issueKeys: levels[0],
      phase: 'pending',
    });
    for (const key of KEYS) {
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

    const attempts = new Map<string, number>();
    const enqueueCliInvocation = async (payload: CliExecJobPayload): Promise<void> => {
      const end = (set: Partial<typeof schema.cliInvocations.$inferInsert>) =>
        db
          .update(schema.cliInvocations)
          .set({ endedAt: new Date(), ...set })
          .where(eq(schema.cliInvocations.id, payload.invocationId));
      const issue = await db.query.taskDagIssues.findFirst({
        where: eq(schema.taskDagIssues.cliInvocationId, payload.invocationId),
      });
      if (!issue?.worktreePath) throw new Error(`no issue for ${payload.invocationId}`);
      const attempt = attempts.get(issue.issueKey) ?? 0;
      attempts.set(issue.issueKey, attempt + 1);
      if (issue.issueKey === 'ISSUE-FREE' && attempt === 0) {
        await end({ exitCode: null, errorMessage: 'the worker restarted before the run began' });
        return;
      }
      if (issue.issueKey === 'ISSUE-CHARGED' && attempt === 0) {
        await end({ startedAt: new Date(), exitCode: 137 });
        return;
      }
      if (issue.issueKey === 'ISSUE-PROSE') {
        await end({ startedAt: new Date(), exitCode: 0, rawOutput: 'done, all implemented' });
        return;
      }
      await writeFile(
        path.join(issue.worktreePath, `${issue.issueKey}.txt`),
        `impl ${issue.issueKey}\n`,
      );
      await end({
        startedAt: new Date(),
        exitCode: 0,
        rawOutput: fence({
          issue_id: issue.issueKey,
          outcome: 'completed',
          files_modified: [`${issue.issueKey}.txt`],
          debt_items: [],
          concerns: concernOf(issue.issueKey),
          similar_sites: [],
        }),
      });
    };

    const controller = new AbortController();
    const ctx: StepContext = {
      round: 0,
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
    let failure: string | null = null;
    for (let i = 0; i < 16 && failure === null; i += 1) {
      const r = await resolveDagPhase(db, dagExecuteStep, current, ctx, params);
      if (r.resolved) throw new Error('the level resolved, though ISSUE-PROSE left no result');
      if (r.result.status === 'failed') {
        failure = (r.result as { error: string }).error;
        break;
      }
      current = r.result.row;
    }

    const checks: [string, boolean, unknown][] = [];
    const check = (name: string, ok: boolean, detail?: unknown) => checks.push([name, ok, detail]);
    check('the level fails on the coder that left no result', /ISSUE-PROSE/.test(failure ?? ''), {
      failure,
    });

    const issues = await db
      .select()
      .from(schema.taskDagIssues)
      .where(eq(schema.taskDagIssues.dagPlanId, plan!.id));
    const byKey = new Map(issues.map((i) => [i.issueKey, i]));
    const free = byKey.get('ISSUE-FREE');
    const charged = byKey.get('ISSUE-CHARGED');
    const prose = byKey.get('ISSUE-PROSE');
    check(
      'a coder that died before starting is re-run for free',
      free?.outcome === 'completed' && free.infraRetries === 0 && attempts.get('ISSUE-FREE') === 2,
      { outcome: free?.outcome, infraRetries: free?.infraRetries },
    );
    check(
      'a coder that died after starting is re-run on one retry',
      charged?.outcome === 'completed' &&
        charged.infraRetries === 1 &&
        attempts.get('ISSUE-CHARGED') === 2,
      { outcome: charged?.outcome, infraRetries: charged?.infraRetries },
    );
    check(
      'a coder that left no result fails, its row saying so',
      prose?.outcome === 'failed_unrecoverable' &&
        /without a valid ISSUE_RESULT_JSON/.test(prose.concerns ?? ''),
      { outcome: prose?.outcome, concerns: prose?.concerns },
    );

    const ledger = await loadLedgerEntries(db, task!.id);
    const texts = (key: string) =>
      ledger.filter((e) => e.stepId === `06c-dag-execute/${key}`).map((e) => e.text);
    check(
      'what each finishing coder reported reaches the ledger',
      ['ISSUE-FREE', 'ISSUE-CHARGED'].every(
        (k) => JSON.stringify(texts(k)) === JSON.stringify([concernOf(k)]),
      ),
      ledger,
    );
    check(
      'a coder that left no result adds nothing to the ledger',
      texts('ISSUE-PROSE').length === 0,
      ledger,
    );

    const failed = checks.filter(([, ok]) => !ok);
    for (const [name, ok, detail] of checks) {
      if (ok) log.info({ check: name }, 'ok');
      else log.error({ check: name, detail }, 'FAILED');
    }
    if (failed.length > 0) throw new Error(`${failed.length} of ${checks.length} checks failed`);
    console.log(JSON.stringify({ smoke: 'DAG_CODER_INFRA_OK', checks: checks.length }));
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
