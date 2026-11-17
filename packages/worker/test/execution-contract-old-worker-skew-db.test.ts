import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { CONFIG_KEYS, configService, TASK_JOB_NAMES, type WorkflowType } from '@haive/shared';
import { moduleManifestSchema } from '@haive/shared/modularity';
import { z } from 'zod';
import { processTaskJob, setContainerCleanupRunner } from '../src/queues/task-queue.js';
import { redriveStalledTasks, type StalledRedriveDeps } from '../src/queues/stalled-redrive.js';
import { stepRegistry } from '../src/step-engine/registry.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  userId: '',
  adds: [] as { name: string; data: Record<string, unknown>; opts: Record<string, unknown> }[],
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/redis.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/redis.js')>()),
  getBullRedis: () => ({}),
  getRedis: () => ({ scan: async () => ['0', []], del: async () => 0 }),
}));
vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('bullmq')>()),
  Queue: class {
    async add(name: string, data: Record<string, unknown>, opts?: Record<string, unknown>) {
      h.adds.push({ name, data, opts: opts ?? {} });
    }
  },
}));
vi.mock('../src/sandbox/sandbox-kill.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/sandbox-kill.js')>()),
  killCliSandboxesForTask: async () => 0,
}));
vi.mock('../src/sandbox/task-auth-volume.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/task-auth-volume.js')>()),
  cleanupTaskAuthVolumes: async () => ({ removed: [], failed: [] }),
  syncRefreshedAuthToUserVolumes: async () => undefined,
}));
vi.mock('../src/sandbox/ollama-provision.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/ollama-provision.js')>()),
  unloadTaskOllamaCliModels: async () => undefined,
}));
vi.mock('@haive/shared/rag', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/rag')>()),
  resolveTaskEmbedTarget: async () => null,
}));
vi.mock('../src/step-engine/execution-contract-support.js', async () => {
  const { ExecutionContractError, parseExecutionContract } =
    await import('@haive/shared/modularity');
  // Frozen copy of the legacy fence at aae9ebb48: an old worker refuses every guarded span and fix target.
  return {
    assertWorkerExecutionContractSupported: (raw: unknown, ..._rest: unknown[]): void => {
      if (raw == null) return;
      const contract = parseExecutionContract(raw);
      if (contract.guardedSpans.length || contract.fixTarget)
        throw new ExecutionContractError(
          'guarded spans or custom fix target not yet supported by this worker',
        );
    },
  };
});
vi.mock('../../api/src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../../api/src/queues.js', () => ({
  getTaskQueue: () => ({
    add: async (name: string, data: Record<string, unknown>, opts?: Record<string, unknown>) => {
      h.adds.push({ name, data, opts: opts ?? {} });
    },
  }),
}));
vi.mock('../../api/src/lib/sandbox-kill.js', () => ({ killTaskSandboxes: async () => 0 }));
vi.mock('../../api/src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
    c.set('userId', h.userId);
    c.set('userRole', 'user');
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => Promise<void>) => next(),
}));

// Runtime cross-package test seam; keep the API source out of the worker's tsc root.
const apiSource = (rel: string) => new URL(`../../api/src/${rel}`, import.meta.url).pathname;

const url = process.env.GUARD_OLD_WORKER_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/guard_old_worker_test'))
  throw new Error('Use a dedicated guard_old_worker_test database');

const EMAIL_INDEX = 'guard-old-worker-test-user';
const TYPE = 'guard_old_worker';
const ADVANCE = TASK_JOB_NAMES.ADVANCE_STEP;
const IDS = [
  'fx-plan',
  'fx-sync',
  'fx-remediate',
  'fx-fix',
  'fx-cleanup',
  'fx-no-change',
  'fx-report',
];
const CONTRACT = {
  version: 1,
  guardedSpans: [
    {
      id: 'planned-span',
      firstStepId: 'fx-sync',
      lastStepId: 'fx-remediate',
      predicateId: 'module.fx.planned',
      args: {},
    },
    {
      id: 'merged-span',
      firstStepId: 'fx-fix',
      lastStepId: 'fx-cleanup',
      predicateId: 'module.fx.merged',
      args: {},
      requiresSpan: 'planned-span',
    },
    {
      id: 'no-change-span',
      firstStepId: 'fx-no-change',
      lastStepId: 'fx-no-change',
      predicateId: 'module.fx.merged',
      args: {},
      when: false,
      requiresSpan: 'planned-span',
    },
  ],
};
const ran = { detect: [] as string[], apply: [] as string[] };

function stub(id: string, index: number): StepDefinition {
  return {
    metadata: {
      id,
      workflowType: 'module.fx' as WorkflowType,
      index,
      title: id,
      description: 'old worker skew stub',
      requiresCli: false,
    },
    async detect() {
      ran.detect.push(id);
      return {};
    },
    async apply() {
      ran.apply.push(id);
      return {};
    },
  } as StepDefinition;
}

const job = (name: string, data: Record<string, unknown>) =>
  ({
    id: randomUUID(),
    name,
    data,
    timestamp: Date.now(),
    moveToDelayed: async () => undefined,
  }) as unknown as Parameters<typeof processTaskJob>[0];

describe.skipIf(!url)(
  'an old worker behind a new API refuses a guarded pin without running it',
  () => {
    let db: Database;
    let userId: string;
    let repositoryId: string;
    let app: { request: (path: string, init?: RequestInit) => Promise<Response> };

    beforeAll(async () => {
      db = createDatabase(url as string);
      h.db = db;
      vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
      vi.spyOn(configService, 'getBoolean').mockImplementation(
        async (key: string) => key === CONFIG_KEYS.CUSTOM_TASK_TYPES_ENABLED,
      );
      await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, EMAIL_INDEX));
      const [user] = await db
        .insert(schema.users)
        .values({
          emailEncrypted: 'guard-old-worker-test@test.local',
          emailBlindIndex: EMAIL_INDEX,
          passwordHash: 'not-real',
          role: 'user',
          status: 'active',
          tokenVersion: 0,
        })
        .returning();
      userId = user!.id;
      h.userId = userId;
      const [repo] = await db
        .insert(schema.repositories)
        .values({
          userId,
          name: 'guard-old-worker',
          source: 'local_path',
          localPath: os.tmpdir(),
          storagePath: os.tmpdir(),
          status: 'ready',
        })
        .returning();
      repositoryId = repo!.id;
      await db.delete(schema.taskTypeDefinitions).where(eq(schema.taskTypeDefinitions.slug, TYPE));
      await db.insert(schema.taskTypeDefinitions).values({
        slug: TYPE,
        displayName: TYPE,
        runListStrategy: 'static',
        source: 'admin',
        stepIds: IDS,
        executionContract: CONTRACT,
        enabled: true,
        selectable: true,
        requiresRepository: false,
      });
      await db.delete(schema.stepCatalog).where(inArray(schema.stepCatalog.stepId, IDS));
      await db.insert(schema.stepCatalog).values(
        IDS.map((stepId, index) => ({
          stepId,
          source: 'core',
          title: stepId,
          workflowType: 'module.fx',
          dispatchesCli: false,
          allowSkip: false,
          providerSensitive: false,
          composable: true,
          entry: {
            stepId,
            label: stepId,
            group: 'fx',
            requires: [],
            provides: [],
            dispatchesCli: false,
          },
          stepIndex: index,
        })),
      );
      const { registerModuleExecutionPredicates } = await import(
        apiSource('modules/execution-predicates.ts')
      );
      registerModuleExecutionPredicates(
        [
          {
            executionPredicates: [
              { id: 'planned', argsSchema: z.strictObject({}) },
              { id: 'merged', argsSchema: z.strictObject({}) },
            ],
          },
        ],
        [
          {
            manifest: moduleManifestSchema.parse({
              id: 'fx',
              name: 'Fx',
              version: '1',
              schemaVersion: 1,
            }),
          },
        ],
      );
      const { taskRoutes } = await import(apiSource('routes/tasks/index.ts'));
      const { errorHandler } = await import(apiSource('middleware/error-handler.ts'));
      taskRoutes.onError(errorHandler);
      app = taskRoutes;
      IDS.forEach((id, index) => stepRegistry.override(stub(id, index)));
      setContainerCleanupRunner(async () => 0);
    });

    beforeEach(async () => {
      h.adds.length = 0;
      ran.detect.length = 0;
      ran.apply.length = 0;
      await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
    });

    afterAll(async () => {
      setContainerCleanupRunner(null);
      await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
      await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, EMAIL_INDEX));
      await db.delete(schema.taskTypeDefinitions).where(eq(schema.taskTypeDefinitions.slug, TYPE));
      await db.delete(schema.stepCatalog).where(inArray(schema.stepCatalog.stepId, IDS));
      await db.$client.end({ timeout: 5 });
      vi.restoreAllMocks();
    });

    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(path, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return {
        status: res.status,
        body: (text.startsWith('{') ? JSON.parse(text) : { raw: text }) as Record<string, any>,
      };
    };
    const task = async (taskId: string) =>
      (await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)))[0]!;
    const rowsOf = (taskId: string) =>
      db
        .select()
        .from(schema.taskSteps)
        .where(eq(schema.taskSteps.taskId, taskId))
        .orderBy(schema.taskSteps.runSeq);
    const events = (taskId: string, type?: string) =>
      db
        .select()
        .from(schema.taskEvents)
        .where(
          type
            ? and(eq(schema.taskEvents.taskId, taskId), eq(schema.taskEvents.eventType, type))
            : eq(schema.taskEvents.taskId, taskId),
        );
    const create = async () => {
      const res = await call('POST', '/', { type: TYPE, title: 'guard old worker', repositoryId });
      expect({ status: res.status, code: res.body.code ?? null }).toEqual({
        status: 201,
        code: null,
      });
      const taskId = res.body.task.id as string;
      const made = await task(taskId);
      const [definition] = await db
        .select()
        .from(schema.taskTypeDefinitions)
        .where(eq(schema.taskTypeDefinitions.slug, TYPE));
      expect(made.executionContract).toEqual(definition!.executionContract);
      expect(made.runListSnapshot).toEqual(IDS);
      expect(made.status).toBe('queued');
      return taskId;
    };
    const startJob = (taskId: string) => {
      const at = h.adds.findIndex(
        (a) => a.name === TASK_JOB_NAMES.START && a.data.taskId === taskId,
      );
      expect(at, 'the API recorded the START job').toBeGreaterThanOrEqual(0);
      return h.adds.splice(at, 1)[0]!;
    };
    const snapshot = async (taskId: string) => ({
      task: await task(taskId),
      rows: await rowsOf(taskId),
      events: await events(taskId),
    });
    const rig = () => {
      const deps: StalledRedriveDeps = {
        enqueueAdvance: async (
          tid: string,
          uid: string,
          stepId: string,
          round: number,
          epoch: number,
        ) => {
          h.adds.push({
            name: ADVANCE,
            data: { taskId: tid, userId: uid, stepId, round, epoch },
            opts: {},
          });
        },
        failTask: async () => true,
        enqueueStart: async (tid: string, uid: string) => {
          h.adds.push({ name: TASK_JOB_NAMES.START, data: { taskId: tid, userId: uid }, opts: {} });
        },
        queuedTaskJobs: async () => ({ steps: new Set(), starts: new Set() }),
        queuedInvocationIds: async () => new Set(),
        redriveRetryDelaysMs: [],
      } as unknown as StalledRedriveDeps;
      return deps;
    };
    const age = async (taskId: string) => {
      const old = new Date(Date.now() - 60_000);
      await db.update(schema.tasks).set({ updatedAt: old }).where(eq(schema.tasks.id, taskId));
    };
    const expectDeadOnce = async (taskId: string, before: Awaited<ReturnType<typeof snapshot>>) => {
      const after = await task(taskId);
      expect(after.deadAt, 'the task is dead').not.toBeNull();
      expect(after.status).toBe(before.task.status);
      expect(after.executionContract).toEqual(before.task.executionContract);
      expect(after.runListSnapshot).toEqual(before.task.runListSnapshot);
      expect(await rowsOf(taskId)).toEqual(before.rows);
      const dead = await events(taskId, 'task.dead');
      expect(dead).toHaveLength(1);
      expect((dead[0]!.payload as { reason: string }).reason).toContain(
        'invalid-execution-contract',
      );
      expect(ran.detect).toEqual([]);
      expect(ran.apply).toEqual([]);
      expect(
        await db
          .select()
          .from(schema.cliInvocations)
          .where(eq(schema.cliInvocations.taskId, taskId)),
      ).toEqual([]);
    };
    const expectInert = async (taskId: string, redeliver: () => Promise<unknown>) => {
      const settled = await snapshot(taskId);
      await redeliver();
      expect(await snapshot(taskId)).toEqual(settled);
      await age(taskId);
      const aged = await snapshot(taskId);
      h.adds.length = 0;
      await redriveStalledTasks(db, rig(), { staleMs: 0 });
      expect(await snapshot(taskId)).toEqual(aged);
      expect(h.adds).toEqual([]);
      expect(ran.apply).toEqual([]);
    };

    it('B1 START marks the task dead once and a second delivery and the stalled sweep change nothing', async () => {
      const taskId = await create();
      const before = await snapshot(taskId);
      const start = startJob(taskId);
      await processTaskJob(job(start.name, start.data));
      await expectDeadOnce(taskId, before);
      await expectInert(taskId, () => processTaskJob(job(start.name, start.data)));
    });

    it('B2 an ADVANCE for a started guarded task marks it dead once', async () => {
      const taskId = await create();
      startJob(taskId);
      await db
        .update(schema.tasks)
        .set({ status: 'running', currentStepId: 'fx-plan', currentRound: 0 })
        .where(eq(schema.tasks.id, taskId));
      const before = await snapshot(taskId);
      const advance = {
        taskId,
        userId,
        stepId: 'fx-plan',
        round: 0,
        epoch: before.task.orchestrationEpoch,
      };
      await processTaskJob(job(ADVANCE, advance));
      await expectDeadOnce(taskId, before);
      await expectInert(taskId, () => processTaskJob(job(ADVANCE, advance)));
    });
  },
);
