import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { CONFIG_KEYS, configService, TASK_JOB_NAMES, type WorkflowType } from '@haive/shared';
import { moduleManifestSchema } from '@haive/shared/modularity';
import { z } from 'zod';
import { processTaskJob, setContainerCleanupRunner } from '../src/queues/task-queue.js';
import { parseGuardDecision } from '../src/step-engine/guard-decisions.js';
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

const url = process.env.GUARD_API_E2E_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/guard_api_e2e_test'))
  throw new Error('Use a dedicated guard_api_e2e_test database');

const EMAIL_INDEX = 'guard-api-e2e-test-user';
const TYPE = 'guard_api_e2e';
const ADVANCE = TASK_JOB_NAMES.ADVANCE_STEP;
const MAX_JOBS = 60;
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
const SPAN_OF: Record<string, string> = {
  'fx-sync': 'planned-span',
  'fx-fix': 'merged-span',
  'fx-no-change': 'no-change-span',
};

interface PathCase {
  name: string;
  planned: boolean;
  merged: boolean;
  executed: string[];
  skipped: string[];
  runs: Record<string, boolean>;
  mergedCalls: number;
}
const CASES: PathCase[] = [
  {
    name: 'A1 planned=false',
    planned: false,
    merged: false,
    executed: ['fx-plan', 'fx-report'],
    skipped: ['fx-sync', 'fx-remediate', 'fx-fix', 'fx-cleanup', 'fx-no-change'],
    runs: { 'fx-sync': false, 'fx-fix': false, 'fx-no-change': false },
    mergedCalls: 0,
  },
  {
    name: 'A2 planned=true merged=false',
    planned: true,
    merged: false,
    executed: ['fx-plan', 'fx-sync', 'fx-remediate', 'fx-no-change', 'fx-report'],
    skipped: ['fx-fix', 'fx-cleanup'],
    runs: { 'fx-sync': true, 'fx-fix': false, 'fx-no-change': true },
    mergedCalls: 1,
  },
  {
    name: 'A3 planned=true merged=true',
    planned: true,
    merged: true,
    executed: ['fx-plan', 'fx-sync', 'fx-remediate', 'fx-fix', 'fx-cleanup', 'fx-report'],
    skipped: ['fx-no-change'],
    runs: { 'fx-sync': true, 'fx-fix': true, 'fx-no-change': false },
    mergedCalls: 1,
  },
];
const ALL_SKIPPED = CASES[0]!;
const PLANNED_ONLY = CASES[1]!;

const flags = { planned: false, merged: false };
const ran = { detect: [] as string[], apply: [] as string[] };
const planned = vi.fn(async () => flags.planned);
const merged = vi.fn(async () => flags.merged);
const predicateMap = new Map([
  ['module.fx.planned', { argsSchema: z.strictObject({}), evaluate: planned }],
  ['module.fx.merged', { argsSchema: z.strictObject({}), evaluate: merged }],
]);

function stub(id: string, index: number): StepDefinition {
  return {
    metadata: {
      id,
      workflowType: 'module.fx' as WorkflowType,
      index,
      title: id,
      description: 'guard api e2e stub',
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
    ...(id === 'fx-plan'
      ? {
          guardPredicates: {
            planned: predicateMap.get('module.fx.planned')!,
            merged: predicateMap.get('module.fx.merged')!,
          },
        }
      : {}),
  } as StepDefinition;
}

type Row = typeof schema.taskSteps.$inferSelect;
const job = (name: string, data: Record<string, unknown>) =>
  ({
    id: randomUUID(),
    name,
    data,
    timestamp: Date.now(),
    moveToDelayed: async () => undefined,
  }) as unknown as Parameters<typeof processTaskJob>[0];

describe.skipIf(!url)(
  'guarded spans end to end through the real API admission, on Postgres',
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
          emailEncrypted: 'guard-api-e2e-test@test.local',
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
          name: 'guard-api-e2e',
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
      planned.mockClear();
      merged.mockClear();
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
    const pump = async () => {
      const processed: { name: string; data: Record<string, unknown> }[] = [];
      for (;;) {
        const next = h.adds.shift();
        if (!next) return processed;
        if (next.name !== ADVANCE) continue;
        if (processed.length >= MAX_JOBS) throw new Error(`more than ${MAX_JOBS} jobs ran`);
        processed.push(next);
        await processTaskJob(job(next.name, next.data));
      }
    };

    const create = async (set: { planned: boolean; merged: boolean }) => {
      flags.planned = set.planned;
      flags.merged = set.merged;
      const res = await call('POST', '/', {
        type: TYPE,
        title: 'guard api e2e',
        repositoryId,
      });
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
    const start = async (taskId: string) => {
      const started = h.adds.findIndex(
        (a) => a.name === TASK_JOB_NAMES.START && a.data.taskId === taskId,
      );
      expect(started, 'the API recorded the START job').toBeGreaterThanOrEqual(0);
      const [startJob] = h.adds.splice(started, 1);
      await processTaskJob(job(startJob!.name, startJob!.data));
      expect((await task(taskId)).deadAt, 'START left the task alive').toBeNull();
    };
    const runAll = async (set: { planned: boolean; merged: boolean }) => {
      const taskId = await create(set);
      await start(taskId);
      const jobs = await pump();
      return { taskId, jobs };
    };
    const skippedEvents = async (taskId: string) => {
      const counts = new Map<string, number>();
      for (const e of await events(taskId, 'step.skipped'))
        counts.set(e.taskStepId!, (counts.get(e.taskStepId!) ?? 0) + 1);
      return counts;
    };

    async function verify(
      taskId: string,
      c: PathCase,
      opts: { executed?: string[]; eventsOnce?: boolean } = {},
    ) {
      const rows = await rowsOf(taskId);
      expect(rows.map((r) => r.stepId)).toEqual(IDS);
      expect(rows.every((r) => r.round === 0)).toBe(true);
      const byId = Object.fromEntries(rows.map((r) => [r.stepId, r])) as Record<string, Row>;
      for (const id of IDS)
        expect(byId[id]!.status, id).toBe(c.skipped.includes(id) ? 'skipped' : 'done');
      for (const id of c.skipped) {
        expect(byId[id]!.output, id).toBeNull();
        expect(byId[id]!.summary, id).toBeNull();
        expect(byId[id]!.guardState, id).not.toBeNull();
        expect(ran.detect).not.toContain(id);
        expect(ran.apply).not.toContain(id);
      }
      expect(ran.apply).toEqual(opts.executed ?? c.executed);
      for (const [entry, run] of Object.entries(c.runs)) {
        const decision = parseGuardDecision(byId[entry]!.guardState);
        expect(decision.run, entry).toBe(run);
        expect(decision.spanId, entry).toBe(SPAN_OF[entry]);
      }
      const final = await task(taskId);
      expect(final.status).toBe('completed');
      expect(final.deadAt).toBeNull();
      expect(final.currentStepId).toBe('fx-report');
      if (opts.eventsOnce !== false) {
        const counts = await skippedEvents(taskId);
        for (const r of rows)
          expect(counts.get(r.id) ?? 0, r.stepId).toBe(c.skipped.includes(r.stepId) ? 1 : 0);
      }
      expect(
        await db
          .select()
          .from(schema.cliInvocations)
          .where(eq(schema.cliInvocations.taskId, taskId)),
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(schema.taskStepAgentMinings)
          .where(
            inArray(
              schema.taskStepAgentMinings.taskStepId,
              rows.map((r) => r.id),
            ),
          ),
      ).toEqual([]);
      expect(planned).toHaveBeenCalledTimes(1);
      expect(merged).toHaveBeenCalledTimes(c.mergedCalls);
      expect(h.adds).toEqual([]);
    }

    describe('A1-A3 path matrix through POST /tasks', () => {
      it.each(CASES)('$name', async (c) => {
        const { taskId } = await runAll(c);
        await verify(taskId, c);
      });
    });

    // A step action never moves a completed task back, so A4 and A5 stop the run right after the
    // planned span is skipped: its five rows settled, the report not yet applied, the task running.
    const runUntilSpanSkipped = async (taskId: string) => {
      for (let i = 0; i < MAX_JOBS; i++) {
        const rows = await rowsOf(taskId);
        if (rows.filter((r) => r.status === 'skipped').length === ALL_SKIPPED.skipped.length)
          return;
        const next = h.adds.shift();
        expect(next, 'the run reached the skipped span').toBeDefined();
        if (next!.name === ADVANCE) await processTaskJob(job(next!.name, next!.data));
      }
      throw new Error('the span was never skipped');
    };

    describe('A4 Retry re-decides', () => {
      it('Retry on the span entry of a suppressed span runs the span on the new decision', async () => {
        const taskId = await create(ALL_SKIPPED);
        await start(taskId);
        await runUntilSpanSkipped(taskId);
        expect(ran.apply).toEqual(['fx-plan']);
        expect((await task(taskId)).status).toBe('running');
        flags.planned = true;
        flags.merged = false;
        planned.mockClear();
        merged.mockClear();
        const res = await call('POST', `/${taskId}/steps/fx-sync/action`, {
          action: 'retry',
          round: 0,
        });
        expect({ status: res.status, code: res.body.code ?? null }).toEqual({
          status: 200,
          code: null,
        });
        await pump();
        await verify(taskId, PLANNED_ONLY, {
          executed: ['fx-plan', 'fx-sync', 'fx-remediate', 'fx-no-change', 'fx-report'],
          eventsOnce: false,
        });
      });
    });

    describe('A5 guard-owned skipped member', () => {
      it('Retry on a suppressed span member is refused and changes nothing', async () => {
        const taskId = await create(ALL_SKIPPED);
        await start(taskId);
        await runUntilSpanSkipped(taskId);
        expect((await task(taskId)).status).toBe('running');
        const before = {
          task: await task(taskId),
          rows: await rowsOf(taskId),
          events: await events(taskId),
          adds: structuredClone(h.adds),
        };
        const res = await call('POST', `/${taskId}/steps/fx-remediate/action`, {
          action: 'retry',
          round: 0,
        });
        expect({ status: res.status, code: res.body.code ?? null }).toEqual({
          status: 409,
          code: 'guard-owned-skip',
        });
        expect(await task(taskId)).toEqual(before.task);
        expect(await rowsOf(taskId)).toEqual(before.rows);
        expect(await events(taskId)).toEqual(before.events);
        expect(h.adds).toEqual(before.adds);
      });
    });

    describe('A6 owner pause and Resume', () => {
      it('a mid-span guarded task pauses, resumes through the route and completes', async () => {
        const taskId = await create(PLANNED_ONLY);
        await start(taskId);
        while (!ran.apply.includes('fx-sync')) {
          const next = h.adds.shift();
          expect(next, 'the run reached the span entry').toBeDefined();
          if (next!.name === ADVANCE) await processTaskJob(job(next!.name, next!.data));
        }
        expect(ran.apply).toEqual(['fx-plan', 'fx-sync']);
        const held = h.adds.filter((a) => a.name === ADVANCE);
        expect(held.length, 'the next advance is queued').toBe(1);
        expect((await task(taskId)).status).toBe('running');
        const paused = await call('POST', `/${taskId}/action`, { action: 'pause' });
        expect({ status: paused.status, code: paused.body.code ?? null }).toEqual({
          status: 200,
          code: null,
        });
        expect((await task(taskId)).pausedAt).not.toBeNull();
        const resumed = await call('POST', `/${taskId}/action`, { action: 'resume' });
        expect({ status: resumed.status, code: resumed.body.code ?? null }).toEqual({
          status: 200,
          code: null,
        });
        expect((await task(taskId)).pausedAt).toBeNull();
        await pump();
        await verify(taskId, PLANNED_ONLY);
      });
    });
  },
);
