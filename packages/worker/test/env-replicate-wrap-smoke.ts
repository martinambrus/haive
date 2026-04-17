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

const log = logger.child({ module: 'env-replicate-wrap-smoke' });

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
  envTemplateId?: string;
  worker?: Awaited<ReturnType<typeof startTaskWorker>>;
  queue?: Queue<TaskJobPayload>;
}

async function pollUntil<T>(
  fn: () => Promise<T | null>,
  predicate: (val: T) => boolean,
  label: string,
  timeoutMs = 45000,
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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'haive-envwrap-'));
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'envwrap-fixture',
        dependencies: { next: '^16.0.0', react: '^19.0.0' },
        engines: { node: '^22.0.0' },
      },
      null,
      2,
    ),
  );
  await writeFile(path.join(dir, 'README.md'), '# envwrap fixture\n');
  await mkdir(path.join(dir, '__tests__'), { recursive: true });
  await writeFile(
    path.join(dir, '__tests__', 'sanity.test.ts'),
    "import { describe, it, expect } from 'vitest'; describe('s', () => { it('p', () => { expect(1).toBe(1); }); });\n",
  );
  return dir;
}

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

async function main(): Promise<void> {
  const state: State = {};
  let exitCode = 0;
  try {
    log.info('bootstrapping env-replicate wrap smoke');
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
      emailEncrypted: 'envwrap-smoke@test.local',
      emailBlindIndex: `envwrap-${randomBytes(4).toString('hex')}`,
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
        name: 'envwrap-fixture',
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
        title: 'env-replicate wrap smoke',
        description: 'Workflow task with mandatory env_replicate prelude.',
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
    log.info('fake docker runner injected');

    state.queue = new Queue<TaskJobPayload>(QUEUE_NAMES.TASK, {
      connection: getBullRedis(),
    });

    await state.queue.add(TASK_JOB_NAMES.START, { taskId: task.id, userId });

    const minimalDockerfile =
      'FROM busybox\nENV DEBIAN_FRONTEND=noninteractive\nWORKDIR /workspace\nCMD ["sh"]\n';
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
      '02-generate-dockerfile': { dockerfile: minimalDockerfile },
      '03-build-image': {
        imageTag: 'haive-envwrap:latest',
        forceRebuild: true,
      },
      '04-verify-environment': {
        selectedChecks: ['node', 'bash'],
      },
      '02-detection-confirmation': {
        projectName: 'envwrap-fixture',
        framework: 'nextjs',
        primaryLanguage: 'typescript',
        localUrl: 'http://localhost:3000',
        projectDescription: 'envwrap smoke.',
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
        customNotes: '',
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
        reviewerNotes: 'envwrap smoke',
      },
      '12-post-onboarding': {
        commit: false,
        commitMessage: '',
      },
    };

    const submitted = new Set<string>();
    let lastStepId: string | null = null;
    for (let iter = 0; iter < 60; iter += 1) {
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
        45000,
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
      .orderBy(asc(schema.taskSteps.startedAt));

    const expectedEnv = [
      '01-declare-deps',
      '02-generate-dockerfile',
      '03-build-image',
      '04-verify-environment',
    ];
    const expectedWorkflow = [
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
    const expected = [...expectedEnv, ...expectedWorkflow];
    for (const id of expected) {
      const row = allSteps.find((s) => s.stepId === id);
      if (!row) throw new Error(`missing step row ${id}`);
      if (row.status !== 'done') {
        throw new Error(`step ${id} status ${row.status}, expected done`);
      }
    }

    const envIndex = allSteps.findIndex((s) => s.stepId === '04-verify-environment');
    const workflowIndex = allSteps.findIndex((s) => s.stepId === '01-worktree-setup');
    if (envIndex < 0 || workflowIndex < 0 || envIndex > workflowIndex) {
      throw new Error(
        `env_replicate prelude did not precede workflow: envIndex=${envIndex}, workflowIndex=${workflowIndex}`,
      );
    }

    const envTemplate = await db.query.envTemplates.findFirst({
      where: eq(schema.envTemplates.userId, userId),
    });
    if (!envTemplate) throw new Error('env_template row missing');
    state.envTemplateId = envTemplate.id;
    if (envTemplate.status !== 'ready') {
      throw new Error(`env_template status ${envTemplate.status}, expected ready`);
    }

    log.info(
      {
        envSteps: expectedEnv.length,
        onboardingSteps: expectedOnboarding.length,
        totalSteps: allSteps.length,
      },
      'env-replicate wrap smoke assertions passed',
    );
    console.log(
      JSON.stringify({
        smoke: 'ENV_WRAP_OK',
        envSteps: expectedEnv.length,
        onboardingSteps: expectedOnboarding.length,
        totalSteps: allSteps.length,
        imageId: envTemplate.builtImageId,
      }),
    );
  } catch (err) {
    exitCode = 1;
    log.error({ err }, 'env-replicate wrap smoke failed');
    console.error('[smoke] FAILED:', err);
  } finally {
    try {
      const db = getDb();
      if (state.envTemplateId) {
        await db.delete(schema.envTemplates).where(eq(schema.envTemplates.id, state.envTemplateId));
      }
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
