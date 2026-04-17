import { cp, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { asc, eq, sql } from 'drizzle-orm';
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

const log = logger.child({ module: 'drupal7-onboarding-smoke' });

const REQUIRED_ENV = ['DATABASE_URL', 'REDIS_URL', 'CONFIG_ENCRYPTION_KEY'] as const;
for (const k of REQUIRED_ENV) {
  if (!process.env[k]) {
    console.error(`[smoke] missing env ${k}`);
    process.exit(2);
  }
}

const FIXTURE_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  '..',
  'tests',
  'fixtures',
  'drupal7',
);

interface State {
  fixtureDir?: string;
  userId?: string;
  repoId?: string;
  taskId?: string;
  worker?: Awaited<ReturnType<typeof startTaskWorker>>;
  queue?: Queue<TaskJobPayload>;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function countMarkdownFiles(dir: string, suffix = '.md'): Promise<number> {
  if (!(await pathExists(dir))) return 0;
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isFile() && e.name.endsWith(suffix)).length;
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

async function copyFixtureToTmp(): Promise<string> {
  const dest = await mkdtemp(path.join(os.tmpdir(), 'haive-drupal7-smoke-'));
  await cp(FIXTURE_ROOT, dest, { recursive: true });
  return dest;
}

interface RagChunkRow {
  source_path: string;
  chunk_index: number;
}

async function main(): Promise<void> {
  const state: State = {};
  let exitCode = 0;
  try {
    log.info({ fixtureRoot: FIXTURE_ROOT }, 'bootstrapping drupal7 smoke');
    initRedis(process.env.REDIS_URL!);
    await configService.initialize(process.env.REDIS_URL!);
    const db = initDatabase(process.env.DATABASE_URL!);
    await secretsService.initialize(db);
    const masterKek = await secretsService.getMasterKek();
    await userSecretsService.initialize(db, masterKek);

    if (!(await pathExists(FIXTURE_ROOT))) {
      throw new Error(`fixture not found at ${FIXTURE_ROOT}`);
    }
    state.fixtureDir = await copyFixtureToTmp();
    log.info({ fixture: state.fixtureDir }, 'fixture copied');

    const now = new Date();
    const userId = randomUUID();
    state.userId = userId;
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'drupal7-smoke@test.local',
      emailBlindIndex: `drupal7-${randomBytes(4).toString('hex')}`,
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
        name: 'drupal7-smoke-fixture',
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
        title: 'drupal7 onboarding smoke',
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
        projectName: 'haive-drupal7-fixture',
        framework: 'drupal7',
        primaryLanguage: 'php',
        localUrl: 'https://haive-drupal7-fixture.ddev.site',
        projectDescription: 'Drupal 7 fixture covering onboarding smoke end-to-end.',
      },
      '04-tooling-infrastructure': {
        ragMode: 'none',
        ragConnectionString: '',
        mcpSettingsJson: '',
        lspLanguages: ['php'],
        installNotes: 'intelephense for PHP LSP.',
      },
      '06-workflow-prefs': {
        verificationLevel: 'standard',
        autoCommit: false,
        maxIterations: 5,
        customNotes: 'Drupal 7 onboarding smoke.',
      },
      '06_5-agent-discovery': {
        acceptedAgents: ['drupal7-module-dev'],
      },
      '07-generate-files': {
        overwrite: true,
      },
      '08-knowledge-acquisition': {
        manualTopics: 'testing\ndatabase\ndocumentation\ndeployment',
      },
      '09-qa': {},
      '09_5-skill-generation': {
        selectedSkills: ['drupal7-project', 'testing-skill', 'documentation-skill'],
      },
      '09_7-rag-source-selection': { selectedDirs: [] },
      '10-rag-populate': {
        truncateExisting: true,
      },
      '11-final-review': {
        acknowledged: true,
        reviewerNotes: 'Drupal7 smoke; template content expected, no CLI.',
      },
      '12-post-onboarding': {
        commit: false,
        commitMessage: '',
      },
    };

    const submitted = new Set<string>();
    let lastStepId: string | null = null;
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
      .orderBy(asc(schema.taskSteps.stepIndex));

    const envDetectStep = allSteps.find((s) => s.stepId === '01-env-detect');
    const envDetect = envDetectStep?.detectOutput as
      | { data?: { project?: { framework?: string; primaryLanguage?: string } } }
      | null
      | undefined;
    const detectedFramework = envDetect?.data?.project?.framework;
    const detectedLanguage = envDetect?.data?.project?.primaryLanguage;
    if (detectedFramework !== 'drupal7') {
      throw new Error(`expected framework drupal7, got ${detectedFramework}`);
    }
    if (detectedLanguage !== 'php') {
      throw new Error(`expected primaryLanguage php, got ${detectedLanguage}`);
    }

    const agentDiscovery = allSteps.find((s) => s.stepId === '06_5-agent-discovery');
    const acceptedAgents =
      (
        agentDiscovery?.output as { accepted?: Array<{ id: string }> } | null | undefined
      )?.accepted?.map((a) => a.id) ?? [];
    if (!acceptedAgents.includes('drupal7-module-dev')) {
      throw new Error(
        `expected drupal7-module-dev in accepted agents, got ${JSON.stringify(acceptedAgents)}`,
      );
    }

    const fixtureDir = state.fixtureDir!;
    const agentsDir = path.join(fixtureDir, '.claude', 'agents');
    const agentFiles = (await readdir(agentsDir)).filter((f) => f.endsWith('.md'));
    if (!agentFiles.includes('drupal7-module-dev.md')) {
      throw new Error(
        `expected drupal7-module-dev.md in .claude/agents, got ${JSON.stringify(agentFiles)}`,
      );
    }

    const kbCount = await countMarkdownFiles(path.join(fixtureDir, '.claude', 'knowledge_base'));
    if (kbCount < 3) {
      throw new Error(`expected at least 3 knowledge base files, got ${kbCount}`);
    }

    // ragMode='none' in this smoke: 10-rag-populate short-circuits and the
    // ai_rag_embeddings table may not exist. Tolerate both missing table and
    // empty row set; only enforce the drupal agent assertion if rows exist.
    let ragRows: RagChunkRow[] = [];
    let ragTableExists = true;
    try {
      const ragResult = (await db.execute(
        sql`select source_path, chunk_index from ai_rag_embeddings where task_id = ${task.id} order by source_path, chunk_index`,
      )) as unknown;
      ragRows = Array.isArray(ragResult) ? (ragResult as RagChunkRow[]) : [];
    } catch (err) {
      const pgCode = (err as { cause?: { code?: string } })?.cause?.code;
      const parts: string[] = [];
      let cursor: unknown = err;
      for (let i = 0; i < 5 && cursor; i++) {
        if (cursor instanceof Error) {
          parts.push(cursor.message);
          cursor = (cursor as Error & { cause?: unknown }).cause;
        } else {
          parts.push(String(cursor));
          break;
        }
      }
      if (pgCode === '42P01' || /ai_rag_embeddings.* does not exist/.test(parts.join(' | '))) {
        ragTableExists = false;
      } else {
        throw err;
      }
    }
    const distinctFiles = new Set(ragRows.map((r) => r.source_path));
    if (ragTableExists && ragRows.length > 0) {
      const hasDrupalAgent = Array.from(distinctFiles).some(
        (f) => f === '.claude/agents/drupal7-module-dev.md',
      );
      if (!hasDrupalAgent) {
        throw new Error(
          `ai_rag_embeddings missing .claude/agents/drupal7-module-dev.md; indexed files: ${JSON.stringify(
            Array.from(distinctFiles).slice(0, 15),
          )}`,
        );
      }
    }

    const events = await db
      .select()
      .from(schema.taskEvents)
      .where(eq(schema.taskEvents.taskId, task.id));

    log.info(
      {
        steps: allSteps.length,
        agentFiles: agentFiles.length,
        ragChunks: ragRows.length,
        distinctFiles: distinctFiles.size,
        events: events.length,
      },
      'drupal7 smoke assertions passed',
    );

    console.log(
      JSON.stringify({
        smoke: 'DRUPAL7_ONBOARDING_OK',
        framework: detectedFramework,
        language: detectedLanguage,
        acceptedAgents,
        agentFiles: agentFiles.length,
        ragChunks: ragRows.length,
        distinctFiles: distinctFiles.size,
        events: events.length,
      }),
    );
  } catch (err) {
    exitCode = 1;
    log.error({ err }, 'drupal7 smoke failed');
    console.error('[smoke] FAILED:', err);
  } finally {
    const keepRows = exitCode !== 0 && process.env.SMOKE_KEEP_ON_FAIL === '1';
    try {
      if (!keepRows) {
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
      } else {
        log.warn({ taskId: state.taskId }, 'keeping db rows for inspection');
      }
    } catch (cleanupErr) {
      log.warn({ err: cleanupErr }, 'db cleanup failed');
    }
    if (state.queue) await state.queue.close().catch(() => {});
    if (state.worker) await state.worker.close().catch(() => {});
    await closeTaskQueue().catch(() => {});
    await closeRedis().catch(() => {});
    if (state.fixtureDir && !keepRows) {
      await rm(state.fixtureDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  process.exit(exitCode);
}

void main();
