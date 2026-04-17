import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
import { stepRegistry } from '../src/step-engine/registry.js';
import { createBuildImageStep } from '../src/step-engine/steps/env-replicate/03-build-image.js';
import { createVerifyEnvironmentStep } from '../src/step-engine/steps/env-replicate/04-verify-environment.js';
import type {
  DockerBuildOpts,
  DockerBuildResult,
  DockerRunOpts,
  DockerRunResult,
  DockerRunner,
} from '../src/sandbox/docker-runner.js';

function createFakeRunner(): DockerRunner {
  return {
    async build(opts: DockerBuildOpts): Promise<DockerBuildResult> {
      return {
        exitCode: 0,
        imageTag: opts.tag,
        imageId: `sha256:${randomBytes(16).toString('hex')}`,
        durationMs: 50,
        stderr: '',
        timedOut: false,
      };
    },
    async run(opts: DockerRunOpts): Promise<DockerRunResult> {
      return {
        exitCode: 0,
        stdout: `fake-ok ${opts.cmd.join(' ')}`,
        stderr: '',
        durationMs: 7,
        timedOut: false,
      };
    },
  };
}

const log = logger.child({ module: 'workflow-smoke' });

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

async function createFixtureRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'haive-workflow-smoke-'));
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'workflow-smoke-fixture',
        scripts: {
          test: 'echo no-tests',
        },
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
  await writeFile(
    path.join(dir, '.claude', 'knowledge_base', 'architecture.md'),
    '# Architecture\n\nMonolith with API, worker, and web layers.\n',
  );
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'smoke@test.local']);
  git(['config', 'user.name', 'Smoke Test']);
  git(['add', '.']);
  git(['commit', '-m', 'initial']);
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

    state.fixtureDir = await createFixtureRepo();
    log.info({ fixture: state.fixtureDir }, 'fixture created');

    const now = new Date();
    const userId = randomUUID();
    state.userId = userId;
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'workflow-smoke@test.local',
      emailBlindIndex: `workflow-${randomBytes(4).toString('hex')}`,
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
        name: 'workflow-smoke-fixture',
        source: 'local_path',
        localPath: state.fixtureDir,
        storagePath: state.fixtureDir,
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
        description:
          'Users have asked for an explicit logout button in the top-right navigation. Keep the change minimal.',
        status: 'created',
        metadata: null,
      })
      .returning();
    if (!task) throw new Error('task insert failed');
    state.taskId = task.id;

    state.worker = startTaskWorker();

    const fakeRunner = createFakeRunner();
    stepRegistry.override(createBuildImageStep(fakeRunner));
    stepRegistry.override(createVerifyEnvironmentStep(fakeRunner));

    state.queue = new Queue<TaskJobPayload>(QUEUE_NAMES.TASK, {
      connection: getBullRedis(),
    });

    log.info({ taskId: task.id }, 'enqueueing start-task');
    await state.queue.add(TASK_JOB_NAMES.START, { taskId: task.id, userId });

    const formPayloads: Record<string, Record<string, unknown>> = {
      '01-declare-deps': {
        runtimes: ['node'],
        nodeVersion: '22',
        phpVersion: '8.3',
        pythonVersion: '3.12',
        containerTool: 'none',
        databaseKind: 'none',
        databaseVersion: '',
        lspServers: [],
        browserTesting: false,
        extraPackages: '',
      },
      '02-generate-dockerfile': {
        dockerfile:
          'FROM busybox\nENV DEBIAN_FRONTEND=noninteractive\nWORKDIR /workspace\nCMD ["sh"]\n',
      },
      '03-build-image': {
        imageTag: 'haive-workflow:latest',
        forceRebuild: true,
      },
      '04-verify-environment': {
        selectedChecks: ['node', 'bash'],
      },
      '01-worktree-setup': {
        branchName: 'feature/logout-button',
        useWorktree: false,
        baseBranch: 'main',
      },
      '02-pre-rag-sync': {
        runSync: false,
      },
      '03-phase-0a-discovery': {
        extraContext: '',
      },
      '04-phase-0b-pre-planning': {
        scope: 'Keep changes confined to the top-right navigation component.',
      },
      '05-phase-0b5-spec-quality': {
        focusAreas: '',
      },
      '06-gate-1-spec-approval': {
        decision: 'approve',
        feedback: 'Smoke run; proceeding with stub spec.',
      },
      '07-phase-2-implement': {
        instructions: '',
      },
      '08-phase-5-verify': {
        runTest: false,
        runLint: false,
        runTypecheck: false,
      },
      '09-gate-2-verify-approval': {
        decision: 'approve',
        feedback: 'Verification skipped; stub approval.',
      },
      '10-gate-3-commit': {
        commit: false,
        commitMessage: '',
      },
      '11-phase-8-learning': {
        observations: 'Smoke test: stub pipeline end-to-end.',
        writeFiles: true,
      },
      '12-worktree-cleanup': {
        removeWorktree: false,
      },
    };

    const submitted = new Set<string>();
    let lastStepId: string | null = null;
    let iterations = 0;
    while (iterations < 40) {
      iterations += 1;
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
        `task transition (iter ${iterations})`,
        30000,
      );

      log.info({ status: updated.status, currentStepId: updated.currentStepId }, 'task polled');

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

      log.info({ stepId }, 'submitting form');
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

    const stepSummary = allSteps.map((s) => ({
      stepId: s.stepId,
      status: s.status,
    }));
    log.info({ stepSummary }, 'all task_steps');

    const expected = [
      '01-worktree-setup',
      '02-pre-rag-sync',
      '03-phase-0a-discovery',
      '04-phase-0b-pre-planning',
      '05-phase-0b5-spec-quality',
      '06-gate-1-spec-approval',
      '07-phase-2-implement',
      '08-phase-5-verify',
      '09-gate-2-verify-approval',
      '10-gate-3-commit',
      '11-phase-8-learning',
      '12-worktree-cleanup',
    ];
    for (const id of expected) {
      const row = allSteps.find((s) => s.stepId === id);
      if (!row) throw new Error(`missing step row ${id}`);
      if (row.status !== 'done') {
        throw new Error(`step ${id} status ${row.status}, expected done`);
      }
    }

    const events = await db
      .select()
      .from(schema.taskEvents)
      .where(eq(schema.taskEvents.taskId, task.id));
    log.info({ eventCount: events.length }, 'task events recorded');

    console.log(
      JSON.stringify({
        smoke: 'WORKFLOW_OK',
        steps: stepSummary,
        events: events.length,
      }),
    );
  } catch (err) {
    exitCode = 1;
    log.error({ err }, 'smoke failed');
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
      log.warn({ err: cleanupErr }, 'cleanup db rows failed');
    }
    if (state.fixtureDir) {
      await rm(state.fixtureDir, { recursive: true, force: true }).catch(() => {});
    }
    if (state.worker) await state.worker.close().catch(() => {});
    if (state.queue) await state.queue.close().catch(() => {});
    await closeTaskQueue().catch(() => {});
    await closeRedis().catch(() => {});
    process.exit(exitCode);
  }
}

void main();
