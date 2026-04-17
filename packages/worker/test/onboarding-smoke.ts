import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { and, asc, eq } from 'drizzle-orm';
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

const log = logger.child({ module: 'onboarding-smoke' });

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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'haive-onboarding-smoke-'));
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify(
      { name: 'smoke-fixture', dependencies: { next: '^16.0.0', react: '^19.0.0' } },
      null,
      2,
    ),
  );
  await mkdir(path.join(dir, '__tests__'));
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
      emailEncrypted: 'onboarding-smoke@test.local',
      emailBlindIndex: `onboarding-${randomBytes(4).toString('hex')}`,
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
        name: 'smoke-fixture',
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
        title: 'onboarding smoke',
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

    log.info({ taskId: task.id }, 'enqueueing start-task');
    await state.queue.add(TASK_JOB_NAMES.START, { taskId: task.id, userId });

    const formPayloads: Record<string, Record<string, unknown>> = {
      '02-detection-confirmation': {
        projectName: 'smoke-fixture',
        framework: 'nextjs',
        primaryLanguage: 'javascript',
        localUrl: 'http://localhost:3000',
        projectDescription: 'Smoke test project for the deterministic onboarding loop.',
      },
      '04-tooling-infrastructure': {
        ragMode: 'none',
        ragConnectionString: '',
        mcpSettingsJson: '',
        lspLanguages: ['typescript'],
      },
      '06-workflow-prefs': {
        verificationLevel: 'standard',
        autoCommit: false,
        maxIterations: 5,
        customNotes: '',
      },
      '06_5-agent-discovery': {
        acceptedAgents: [],
      },
      '07-generate-files': {
        overwrite: true,
      },
      '08-knowledge-acquisition': {
        manualTopics: 'testing\ndeployment\ndatabase\ndocumentation',
      },
      '09-qa': {},
      '09_2-qa-resolve': { userQuestions: '' },
      '09_5-skill-generation': {
        maxSkills: 5,
      },
      '09_7-rag-source-selection': { selectedDirs: [] },
      '10-rag-populate': {
        truncateExisting: true,
      },
      '11-final-review': {
        acknowledged: true,
        reviewerNotes: 'Smoke run; stubs expected due to missing CLI.',
      },
      '12-post-onboarding': {
        commit: false,
        commitMessage: '',
      },
    };

    const submitted = new Set<string>();
    let lastStepId: string | null = null;
    let iterations = 0;
    while (iterations < 30) {
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
      '01-env-detect',
      '01_5-ripgrep-config',
      '02-detection-confirmation',
      '04-tooling-infrastructure',
      '06-workflow-prefs',
      '06_5-agent-discovery',
      '07-generate-files',
      '07_5-verify-files',
      '08-knowledge-acquisition',
      '09-qa',
      '09_2-qa-resolve',
      '09_5-skill-generation',
      '09_6-skill-verification',
      '09_7-rag-source-selection',
      '10-rag-populate',
      '11-final-review',
      '12-post-onboarding',
    ];
    for (const id of expected) {
      const row = allSteps.find((s) => s.stepId === id);
      if (!row) throw new Error(`missing step row ${id}`);
      if (row.status !== 'done' && row.status !== 'skipped') {
        throw new Error(`step ${id} status ${row.status}, expected done or skipped`);
      }
    }

    const events = await db
      .select()
      .from(schema.taskEvents)
      .where(eq(schema.taskEvents.taskId, task.id));
    log.info({ eventCount: events.length }, 'task events recorded');

    console.log(
      JSON.stringify({
        smoke: 'ONBOARDING_OK',
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
