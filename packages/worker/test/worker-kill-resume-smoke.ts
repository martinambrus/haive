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

process.env.HAIVE_TEST_BYPASS_LLM = '1';

const log = logger.child({ module: 'worker-kill-resume-smoke' });

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
  worker?: Awaited<ReturnType<typeof startTaskWorker>> | null;
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

async function createFixture(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'haive-kill-resume-'));
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'kill-resume-fixture',
        dependencies: { next: '^16.0.0', react: '^19.0.0' },
      },
      null,
      2,
    ),
  );
  await writeFile(path.join(dir, 'README.md'), '# Worker-kill resume fixture\n');
  await mkdir(path.join(dir, '__tests__'), { recursive: true });
  await writeFile(
    path.join(dir, '__tests__', 'sanity.test.ts'),
    "import { describe, it, expect } from 'vitest'; describe('s', () => { it('p', () => { expect(1).toBe(1); }); });\n",
  );
  return dir;
}

async function main(): Promise<void> {
  const state: State = {};
  let exitCode = 0;
  try {
    log.info('bootstrapping worker-kill resume smoke');
    initRedis(process.env.REDIS_URL!);
    await configService.initialize(process.env.REDIS_URL!);
    const db = initDatabase(process.env.DATABASE_URL!);
    await secretsService.initialize(db);
    const masterKek = await secretsService.getMasterKek();
    await userSecretsService.initialize(db, masterKek);

    state.fixtureDir = await createFixture();
    log.info({ fixture: state.fixtureDir }, 'fixture created');

    const now = new Date();
    const userId = randomUUID();
    state.userId = userId;
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'kill-resume-smoke@test.local',
      emailBlindIndex: `killres-${randomBytes(4).toString('hex')}`,
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
        name: 'kill-resume-fixture',
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
        type: 'onboarding',
        title: 'worker-kill resume smoke',
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

    const formPayloads: Record<string, Record<string, unknown>> = {
      '02-detection-confirmation': {
        projectName: 'kill-resume-fixture',
        framework: 'nextjs',
        primaryLanguage: 'typescript',
        localUrl: 'http://localhost:3000',
        projectDescription: 'Resume fixture.',
      },
      '04-tooling-infrastructure': {
        ragMode: 'none',
        ragConnectionString: '',
        mcpSettingsJson: '',
        lspLanguages: ['typescript'],
        installNotes: '',
      },
      '06-workflow-prefs': {
        verificationLevel: 'standard',
        autoCommit: false,
        maxIterations: 3,
        customNotes: 'resume smoke',
      },
      '06_5-agent-discovery': { acceptedAgents: [] },
      '07-generate-files': { overwrite: true },
      '08-knowledge-acquisition': {
        manualTopics: 'testing\ndocumentation',
      },
      '09-qa': {},
      '09_5-skill-generation': { selectedSkills: [] },
      '09_7-rag-source-selection': { selectedDirs: [] },
      '10-rag-populate': { truncateExisting: true },
      '11-final-review': {
        acknowledged: true,
        reviewerNotes: 'resume smoke',
      },
      '12-post-onboarding': {
        commit: false,
        commitMessage: '',
      },
    };

    const killAfterStep = '06-workflow-prefs';
    const submitted = new Set<string>();
    let lastStepId: string | null = null;
    let killed = false;
    let resumedAfterKill = false;
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

      if (stepId === killAfterStep && !killed) {
        log.info({ stepId }, 'killing worker mid-run (closing worker instance)');
        if (state.worker) {
          await state.worker.close();
          state.worker = null;
        }
        killed = true;

        log.info({ stepId }, 'enqueueing advance-step while worker is down');
        await state.queue.add(TASK_JOB_NAMES.ADVANCE_STEP, {
          taskId: task.id,
          userId,
          stepId,
          formValues: values,
        });
        submitted.add(stepId);
        lastStepId = stepId;

        await new Promise((r) => setTimeout(r, 500));
        const stillWaiting = await db.query.tasks.findFirst({
          where: eq(schema.tasks.id, task.id),
        });
        if (!stillWaiting) throw new Error('task vanished after kill');
        if (stillWaiting.status !== 'waiting_user') {
          throw new Error(
            `expected task to remain waiting_user while worker down; got ${stillWaiting.status}`,
          );
        }
        if (stillWaiting.currentStepId !== killAfterStep) {
          throw new Error(
            `expected currentStepId=${killAfterStep}, got ${stillWaiting.currentStepId}`,
          );
        }
        log.info(
          { currentStepId: stillWaiting.currentStepId, status: stillWaiting.status },
          'task state preserved while worker down',
        );

        log.info('restarting worker');
        state.worker = startTaskWorker();
        resumedAfterKill = true;
        continue;
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

    if (!killed) throw new Error('never killed worker');
    if (!resumedAfterKill) throw new Error('never resumed after kill');

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

    const killStep = allSteps.find((s) => s.stepId === killAfterStep);
    if (!killStep || killStep.status !== 'done') {
      throw new Error(
        `kill step ${killAfterStep} not done after resume; status=${killStep?.status}`,
      );
    }
    const doneCount = allSteps.filter((s) => s.status === 'done').length;
    if (doneCount < 10) {
      throw new Error(`expected at least 10 done steps, got ${doneCount}`);
    }

    log.info({ doneCount, totalSteps: allSteps.length }, 'resume smoke assertions passed');
    console.log(
      JSON.stringify({
        smoke: 'WORKER_RESUME_OK',
        killedAt: killAfterStep,
        doneCount,
        totalSteps: allSteps.length,
      }),
    );
  } catch (err) {
    exitCode = 1;
    log.error({ err }, 'worker-kill resume smoke failed');
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
