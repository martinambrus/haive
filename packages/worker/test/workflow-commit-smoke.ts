import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { asc, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  configService,
  secretsService,
  userSecretsService,
  logger,
  QUEUE_NAMES,
  TASK_JOB_NAMES,
  type TaskJobPayload,
} from '@haive/shared';
import { initDatabase, getDb } from '../src/db.js';
import { initRedis, getBullRedis, closeRedis } from '../src/redis.js';
import { closeTaskQueue, startTaskWorker } from '../src/queues/task-queue.js';

const log = logger.child({ module: 'workflow-commit-smoke' });
const exec = promisify(execFile);

const REQUIRED_ENV = ['DATABASE_URL', 'REDIS_URL', 'CONFIG_ENCRYPTION_KEY'] as const;
for (const k of REQUIRED_ENV) {
  if (!process.env[k]) {
    console.error(`[smoke] missing env ${k}`);
    process.exit(2);
  }
}

interface State {
  fixtureDir?: string;
  userId?: string;
  repoId?: string;
  taskId?: string;
  worker?: Awaited<ReturnType<typeof startTaskWorker>>;
  queue?: Queue<TaskJobPayload>;
}

async function pollUntil<T>(
  fn: () => Promise<T | null>,
  predicate: (val: T) => boolean,
  label: string,
  timeoutMs = 30000,
  intervalMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val !== null && predicate(val)) return val;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout.toString().trim();
}

async function createGitFixture(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'haive-workflow-commit-'));
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'workflow-commit-smoke-fixture',
        scripts: { test: 'echo no-tests' },
      },
      null,
      2,
    ),
  );
  await mkdir(path.join(dir, '.claude', 'knowledge_base'), { recursive: true });
  await writeFile(
    path.join(dir, '.claude', 'knowledge_base', 'testing.md'),
    '# Testing conventions\n\nUnit tests live under __tests__. Use vitest.\n',
  );
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'smoke@test.local']);
  await git(dir, ['config', 'user.name', 'Workflow Smoke']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'initial']);
  return dir;
}

async function main(): Promise<void> {
  const state: State = {};
  let exitCode = 0;
  try {
    log.info('bootstrapping workflow-commit smoke');
    initRedis(process.env.REDIS_URL!);
    await configService.initialize(process.env.REDIS_URL!);
    const db = initDatabase(process.env.DATABASE_URL!);
    await secretsService.initialize(db);
    const masterKek = await secretsService.getMasterKek();
    await userSecretsService.initialize(db, masterKek);

    state.fixtureDir = await createGitFixture();
    const fixtureDir = state.fixtureDir;
    log.info({ fixture: fixtureDir }, 'git fixture created');

    const baseSha = await git(fixtureDir, ['rev-parse', 'HEAD']);
    log.info({ baseSha }, 'initial commit');

    const now = new Date();
    const userId = randomUUID();
    state.userId = userId;
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'workflow-commit-smoke@test.local',
      emailBlindIndex: `wfcommit-${randomBytes(4).toString('hex')}`,
      passwordHash: 'smoke-not-real',
      role: 'user',
      status: 'active',
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now,
    });

    const [repo] = await db
      .insert(schema.repositories)
      .values({
        userId,
        name: 'workflow-commit-smoke-fixture',
        source: 'local_path',
        localPath: fixtureDir,
        storagePath: fixtureDir,
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
        type: 'workflow',
        title: 'Add a logout button',
        description: 'Smoke test: real commit path.',
        status: 'created',
        metadata: null,
      })
      .returning();
    if (!task) throw new Error('task insert failed');
    state.taskId = task.id;

    state.worker = startTaskWorker();
    state.queue = new Queue<TaskJobPayload>(QUEUE_NAMES.TASK, {
      connection: getBullRedis(),
    });

    await state.queue.add(TASK_JOB_NAMES.START, { taskId: task.id, userId });

    const commitMessage = 'feat: logout button stub (workflow-commit smoke)';
    const formPayloads: Record<string, Record<string, unknown>> = {
      '01-worktree-setup': {
        branchName: 'feature/logout-button',
        useWorktree: false,
        baseBranch: 'main',
      },
      '02-pre-rag-sync': { runSync: false },
      '03-phase-0a-discovery': { extraContext: '' },
      '04-phase-0b-pre-planning': {
        scope: 'Keep changes confined to a single file for smoke purposes.',
      },
      '05-phase-0b5-spec-quality': { focusAreas: '' },
      '06-gate-1-spec-approval': {
        decision: 'approve',
        feedback: 'Smoke approval.',
      },
      '07-phase-2-implement': { instructions: '' },
      '08-phase-5-verify': {
        runTest: false,
        runLint: false,
        runTypecheck: false,
      },
      '09-gate-2-verify-approval': {
        decision: 'approve',
        feedback: 'Smoke approval.',
      },
      '10-gate-3-commit': {
        commit: true,
        commitMessage,
      },
      '11-phase-8-learning': {
        observations: 'Real-commit smoke.',
        writeFiles: true,
      },
      '12-worktree-cleanup': { removeWorktree: false },
    };

    const submitted = new Set<string>();
    let lastStepId: string | null = null;
    let fabricatedDiff = false;
    for (let iter = 0; iter < 40; iter += 1) {
      const updated = await pollUntil(
        async () => {
          const row = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, task.id) });
          return row ?? null;
        },
        (t) => {
          if (t.status === 'completed' || t.status === 'failed') return true;
          if (t.status === 'waiting_user' && t.currentStepId !== lastStepId) return true;
          return false;
        },
        `task transition (iter ${iter})`,
        30000,
      );

      if (updated.status === 'completed') break;
      if (updated.status === 'failed') {
        throw new Error(`task failed: ${updated.errorMessage ?? 'unknown'}`);
      }
      const stepId = updated.currentStepId;
      if (!stepId) throw new Error('waiting_user but no currentStepId');
      if (submitted.has(stepId)) {
        throw new Error(`already submitted ${stepId} but task still waiting`);
      }
      const values = formPayloads[stepId];
      if (!values) throw new Error(`no canned form values for step ${stepId}`);

      if (stepId === '10-gate-3-commit' && !fabricatedDiff) {
        const worktreeStep = await db.query.taskSteps.findFirst({
          where: eq(schema.taskSteps.taskId, task.id),
          columns: { output: true },
          orderBy: asc(schema.taskSteps.stepIndex),
        });
        const wtOutput = worktreeStep?.output as { worktreePath?: string } | null;
        const targetDir = wtOutput?.worktreePath ?? fixtureDir;
        await writeFile(
          path.join(targetDir, 'LOGOUT.md'),
          '# Logout button\n\nStub feature file added for smoke commit.\n',
        );
        fabricatedDiff = true;
        log.info({ targetDir }, 'fabricated diff for gate-3 commit');
        await new Promise((r) => setTimeout(r, 150));
      }

      await state.queue.add(TASK_JOB_NAMES.ADVANCE_STEP, {
        taskId: task.id,
        userId,
        stepId,
        formValues: values,
      });
      submitted.add(stepId);
      lastStepId = stepId;
    }

    const finalTask = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, task.id) });
    if (!finalTask) throw new Error('final task vanished');
    if (finalTask.status !== 'completed') {
      throw new Error(`expected completed, got ${finalTask.status}`);
    }

    const allSteps = await db
      .select()
      .from(schema.taskSteps)
      .where(eq(schema.taskSteps.taskId, task.id))
      .orderBy(asc(schema.taskSteps.stepIndex));

    const commitStep = allSteps.find((s) => s.stepId === '10-gate-3-commit');
    if (!commitStep) throw new Error('commit step row missing');
    const commitOutput = commitStep.output as {
      committed?: boolean;
      commitSha?: string | null;
      message?: string;
    } | null;
    if (!commitOutput?.committed) {
      throw new Error(`gate-3 did not commit; output: ${JSON.stringify(commitOutput)}`);
    }
    const commitSha = commitOutput.commitSha;
    if (!commitSha) throw new Error('commit step missing commitSha');

    const worktreeSetup = allSteps.find((s) => s.stepId === '01-worktree-setup');
    const wtOut = worktreeSetup?.output as { worktreePath?: string } | null;
    const verifyDir = wtOut?.worktreePath ?? fixtureDir;

    const head = await git(verifyDir, ['rev-parse', 'HEAD']);
    if (head !== commitSha) {
      throw new Error(`HEAD ${head} != commitSha ${commitSha}`);
    }
    if (head === baseSha) {
      throw new Error('HEAD unchanged; no new commit created');
    }
    const headMsg = await git(verifyDir, ['log', '-1', '--pretty=%s']);
    if (!headMsg.includes('logout button')) {
      throw new Error(`commit message mismatch: ${headMsg}`);
    }
    const logoutExists = await git(verifyDir, ['ls-files', 'LOGOUT.md']);
    if (logoutExists !== 'LOGOUT.md') {
      throw new Error('LOGOUT.md not in git index after commit');
    }

    const learningStep = allSteps.find((s) => s.stepId === '11-phase-8-learning');
    if (!learningStep || learningStep.status !== 'done') {
      throw new Error('learning step not done');
    }

    log.info({ commitSha, head, headMsg }, 'workflow-commit smoke assertions passed');
    console.log(
      JSON.stringify({
        smoke: 'WORKFLOW_COMMIT_OK',
        baseSha,
        commitSha,
        message: headMsg,
      }),
    );
  } catch (err) {
    exitCode = 1;
    log.error({ err }, 'workflow-commit smoke failed');
    console.error('[smoke] FAILED:', err);
  } finally {
    try {
      const db = getDb();
      if (state.taskId) {
        await db.delete(schema.tasks).where(eq(schema.tasks.id, state.taskId));
      }
      if (state.repoId) {
        await db.delete(schema.repositories).where(eq(schema.repositories.id, state.repoId));
      }
      if (state.userId) {
        await db.delete(schema.users).where(eq(schema.users.id, state.userId));
      }
    } catch (cleanupErr) {
      log.warn({ err: cleanupErr }, 'cleanup failed');
    }
    if (state.queue) await state.queue.close().catch(() => {});
    if (state.worker) await state.worker.close().catch(() => {});
    await closeTaskQueue().catch(() => {});
    await closeRedis().catch(() => {});
    if (state.fixtureDir) {
      await rm(state.fixtureDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  process.exit(exitCode);
}

void main();
