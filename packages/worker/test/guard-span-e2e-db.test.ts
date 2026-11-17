import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, hasPgCode, schema, type Database } from '@haive/database';
import { configService, logger, TASK_JOB_NAMES, type WorkflowType } from '@haive/shared';
import type { StepContext } from '@haive/shared/step';
import { z } from 'zod';
import { resetStepAndDownstream } from '../src/queues/_step-reset.js';
import { processTaskJob, setContainerCleanupRunner } from '../src/queues/task-queue.js';
import { redriveStalledTasks, type StalledRedriveDeps } from '../src/queues/stalled-redrive.js';
import { evaluateGuardDecision, parseGuardDecision } from '../src/step-engine/guard-decisions.js';
import {
  advanceGuardSpan,
  isRetryableGuardError,
  skipGuardSpan,
} from '../src/step-engine/guard-span-skip.js';
import { stepRegistry } from '../src/step-engine/registry.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
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
vi.mock('../src/step-engine/guard-span-skip.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/step-engine/guard-span-skip.js')>();
  return { ...real, advanceGuardSpan: vi.fn(real.advanceGuardSpan) };
});

const url = process.env.GUARD_SPAN_E2E_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/guard_span_e2e_test'))
  throw new Error('Use a dedicated guard_span_e2e_test database');

const EMAIL_INDEX = 'guard-span-e2e-test-user';
const TYPE = 'guard_span_e2e';
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
const MEMBERS = {
  'planned-span': ['fx-sync', 'fx-remediate'],
  'merged-span': ['fx-fix', 'fx-cleanup'],
  'no-change-span': ['fx-no-change'],
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
    name: 'planned=false',
    planned: false,
    merged: false,
    executed: ['fx-plan', 'fx-report'],
    skipped: ['fx-sync', 'fx-remediate', 'fx-fix', 'fx-cleanup', 'fx-no-change'],
    runs: { 'fx-sync': false, 'fx-fix': false, 'fx-no-change': false },
    mergedCalls: 0,
  },
  {
    name: 'planned=true merged=false',
    planned: true,
    merged: false,
    executed: ['fx-plan', 'fx-sync', 'fx-remediate', 'fx-no-change', 'fx-report'],
    skipped: ['fx-fix', 'fx-cleanup'],
    runs: { 'fx-sync': true, 'fx-fix': false, 'fx-no-change': true },
    mergedCalls: 1,
  },
  {
    name: 'planned=true merged=true',
    planned: true,
    merged: true,
    executed: ['fx-plan', 'fx-sync', 'fx-remediate', 'fx-fix', 'fx-cleanup', 'fx-report'],
    skipped: ['fx-no-change'],
    runs: { 'fx-sync': true, 'fx-fix': true, 'fx-no-change': false },
    mergedCalls: 1,
  },
];
const ALL_SKIPPED = CASES[0]!;

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
      description: 'guard span e2e stub',
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
    attemptsMade: 0,
    opts: { attempts: 3 },
    moveToDelayed: async () => undefined,
  }) as unknown as Parameters<typeof processTaskJob>[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!url)('guarded spans end to end through the step engine, on Postgres', () => {
  let db: Database;
  let userId: string;
  let repositoryId: string;

  beforeAll(async () => {
    db = createDatabase(url as string);
    h.db = db;
    vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, EMAIL_INDEX));
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'guard-span-e2e-test@test.local',
        emailBlindIndex: EMAIL_INDEX,
        passwordHash: 'not-real',
        role: 'user',
        status: 'active',
        tokenVersion: 0,
      })
      .returning();
    userId = user!.id;
    const [repo] = await db
      .insert(schema.repositories)
      .values({
        userId,
        name: 'guard-span-e2e',
        source: 'local_path',
        localPath: os.tmpdir(),
        storagePath: os.tmpdir(),
        status: 'ready',
      })
      .returning();
    repositoryId = repo!.id;
    await db
      .insert(schema.taskTypeDefinitions)
      .values({ slug: TYPE, displayName: TYPE, runListStrategy: 'static', source: 'test' })
      .onConflictDoNothing();
    IDS.forEach((id, index) => stepRegistry.override(stub(id, index)));
    setContainerCleanupRunner(async () => 0);
  });

  beforeEach(async () => {
    h.adds.length = 0;
    ran.detect.length = 0;
    ran.apply.length = 0;
    planned.mockClear();
    merged.mockClear();
    vi.mocked(advanceGuardSpan).mockClear();
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
  });

  afterAll(async () => {
    setContainerCleanupRunner(null);
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, EMAIL_INDEX));
    await db.$client.end({ timeout: 5 });
    vi.restoreAllMocks();
  });

  const make = async (contract: unknown, set: { planned: boolean; merged: boolean }) => {
    flags.planned = set.planned;
    flags.merged = set.merged;
    const [made] = await db
      .insert(schema.tasks)
      .values({
        userId,
        repositoryId,
        type: TYPE,
        title: 'guard span e2e',
        metadata: { anchorRepositoryId: null },
        status: 'queued',
        runListSnapshot: IDS,
        executionContract: contract,
        dataEdgePlan: null,
      })
      .returning({ id: schema.tasks.id });
    return made!.id;
  };
  const start = async (taskId: string) => {
    await processTaskJob(job(TASK_JOB_NAMES.START, { taskId, userId }));
    expect((await task(taskId)).deadAt, 'START left the task alive').toBeNull();
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
  const runAll = async (contract: unknown, set: { planned: boolean; merged: boolean }) => {
    const taskId = await make(contract, set);
    await start(taskId);
    const jobs = await pump();
    return { taskId, jobs };
  };
  const entryJob = () => {
    const found = h.adds.find((a) => a.name === ADVANCE && a.data.stepId === 'fx-sync');
    expect(found, 'START left the advance job for the planned span entry').toBeDefined();
    h.adds.splice(h.adds.indexOf(found!), 1);
    return found!;
  };
  const skippedEvents = async (taskId: string) => {
    const counts = new Map<string, number>();
    for (const e of await events(taskId, 'step.skipped'))
      counts.set(e.taskStepId!, (counts.get(e.taskStepId!) ?? 0) + 1);
    return counts;
  };

  async function verify(taskId: string, c: PathCase) {
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
    expect(ran.apply).toEqual(c.executed);
    for (const [entry, run] of Object.entries(c.runs)) {
      const decision = parseGuardDecision(byId[entry]!.guardState);
      expect(decision.run, entry).toBe(run);
      expect(decision.spanId, entry).toBe(SPAN_OF[entry]);
    }
    const final = await task(taskId);
    expect(final.status).toBe('completed');
    expect(final.deadAt).toBeNull();
    expect(final.currentStepId).toBe('fx-report');
    const counts = await skippedEvents(taskId);
    for (const r of rows)
      expect(counts.get(r.id) ?? 0, r.stepId).toBe(c.skipped.includes(r.stepId) ? 1 : 0);
    expect(
      await db.select().from(schema.cliInvocations).where(eq(schema.cliInvocations.taskId, taskId)),
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

  describe('E1 path matrix', () => {
    it.each(CASES)('$name', async (c) => {
      const { taskId } = await runAll(CONTRACT, c);
      await verify(taskId, c);
    });
  });

  describe('E2 ordinary parity', () => {
    it('an unguarded pin runs every step and never reaches the guard services', async () => {
      const { taskId } = await runAll(null, { planned: false, merged: false });
      expect(ran.apply).toEqual(IDS);
      expect((await task(taskId)).status).toBe('completed');
      expect(advanceGuardSpan).toHaveBeenCalledTimes(0);
    });

    it('a guarded pin reaches the guard services at every decided entry', async () => {
      await runAll(CONTRACT, CASES[2]!);
      expect(vi.mocked(advanceGuardSpan).mock.calls.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('E3 duplicates', () => {
    it('a redelivered entry advance after a finished run changes nothing', async () => {
      const { taskId, jobs } = await runAll(CONTRACT, ALL_SKIPPED);
      const again = jobs.find((j) => j.data.stepId === 'fx-sync');
      expect(again, 'the run delivered an advance for the planned span entry').toBeDefined();
      const rows = await rowsOf(taskId);
      const log = await events(taskId);
      const applied = [...ran.apply];
      const adds = h.adds.length;
      await processTaskJob(job(ADVANCE, again!.data));
      expect(await rowsOf(taskId)).toEqual(rows);
      expect(await events(taskId)).toEqual(log);
      expect(ran.apply).toEqual(applied);
      expect(h.adds).toHaveLength(adds);
    });

    it('two concurrent deliveries of the entry advance decide and skip once', async () => {
      const taskId = await make(CONTRACT, ALL_SKIPPED);
      await start(taskId);
      const entry = entryJob();
      const settled = await Promise.allSettled([
        processTaskJob(job(ADVANCE, entry.data)),
        processTaskJob(job(ADVANCE, entry.data)),
      ]);
      for (const s of settled)
        if (s.status === 'rejected') expect(hasPgCode(s.reason, '40P01')).toBe(false);
      await pump();
      const rows = await rowsOf(taskId);
      expect(rows.some((r) => r.status === 'failed')).toBe(false);
      await verify(taskId, ALL_SKIPPED);
    });
  });

  describe('E4 recovery cuts', () => {
    const seed = async (taskId: string) => {
      await start(taskId);
      const t = await task(taskId);
      expect(t.currentStepId).toBe('fx-sync');
      const existing = await rowsOf(taskId);
      for (const [index, stepId] of IDS.entries())
        if (!existing.some((r) => r.stepId === stepId && r.round === 0))
          await db
            .insert(schema.taskSteps)
            .values({ taskId, stepId, title: stepId, stepIndex: index, runSeq: index, round: 0 });
      const entry = (await rowsOf(taskId)).find((r) => r.stepId === 'fx-sync')!;
      return {
        t,
        ctx: {
          taskId,
          taskStepId: entry.id,
          userId,
          db,
          round: 0,
          epoch: t.orchestrationEpoch,
          rerunGeneration: entry.rerunGeneration,
          signal: new AbortController().signal,
          throwIfCancelled() {},
          logger,
        } as unknown as StepContext,
      };
    };
    const rig = () => {
      const deps: StalledRedriveDeps = {
        enqueueAdvance: async (taskId, uid, stepId, round, epoch) => {
          h.adds.push({
            name: ADVANCE,
            data: { taskId, userId: uid, stepId, round, epoch },
            opts: {},
          });
        },
        failTask: async () => true,
        enqueueStart: async () => undefined,
        queuedTaskJobs: async () => ({ steps: new Set(), starts: new Set() }),
        queuedInvocationIds: async () => new Set(),
        redriveRetryDelaysMs: [],
      };
      return deps;
    };
    const age = async (taskId: string) => {
      const old = new Date(Date.now() - 60_000);
      await db.update(schema.tasks).set({ updatedAt: old }).where(eq(schema.tasks.id, taskId));
      await db
        .update(schema.taskSteps)
        .set({ updatedAt: old })
        .where(eq(schema.taskSteps.taskId, taskId));
      await sleep(20);
    };

    it('a: a committed decision alone is completed by one entry job', async () => {
      const taskId = await make(CONTRACT, ALL_SKIPPED);
      const { ctx } = await seed(taskId);
      await evaluateGuardDecision(ctx, 'planned-span', predicateMap);
      await pump();
      await verify(taskId, ALL_SKIPPED);
    });

    it('b: a committed skip with the pointer on the entry and nothing queued is re-driven', async () => {
      const taskId = await make(CONTRACT, ALL_SKIPPED);
      const { ctx } = await seed(taskId);
      await evaluateGuardDecision(ctx, 'planned-span', predicateMap);
      await skipGuardSpan(ctx, 'planned-span', predicateMap);
      h.adds.length = 0;
      await age(taskId);
      await expect(redriveStalledTasks(db, rig(), { staleMs: 0 })).resolves.toBe(1);
      await pump();
      await verify(taskId, ALL_SKIPPED);
    });

    it('c: a committed skip with the pointer on a middle member and nothing queued is re-driven', async () => {
      const taskId = await make(CONTRACT, ALL_SKIPPED);
      const { ctx } = await seed(taskId);
      await evaluateGuardDecision(ctx, 'planned-span', predicateMap);
      await skipGuardSpan(ctx, 'planned-span', predicateMap);
      h.adds.length = 0;
      await db
        .update(schema.tasks)
        .set({ currentStepId: 'fx-remediate' })
        .where(eq(schema.tasks.id, taskId));
      await age(taskId);
      await expect(redriveStalledTasks(db, rig(), { staleMs: 0 })).resolves.toBe(1);
      await pump();
      const rows = await rowsOf(taskId);
      const counts = await skippedEvents(taskId);
      for (const r of rows.filter((x) => ALL_SKIPPED.skipped.includes(x.stepId)))
        expect(counts.get(r.id) ?? 0, r.stepId).toBeLessThanOrEqual(1);
      for (const r of rows.filter(
        (x) => ALL_SKIPPED.skipped.includes(x.stepId) && x.stepId !== 'fx-sync',
      ))
        expect(counts.get(r.id), r.stepId).toBe(1);
      expect(ran.apply).toEqual(ALL_SKIPPED.executed);
      const final = await task(taskId);
      expect(final.status).toBe('completed');
      expect(final.currentStepId).toBe('fx-report');
      expect(planned).toHaveBeenCalledTimes(1);
      expect(merged).toHaveBeenCalledTimes(0);
    });
  });

  describe('E5 lock interleave', () => {
    const retryable = (err: unknown) =>
      isRetryableGuardError(err) ||
      isRetryableGuardError((err as { cause?: unknown } | null)?.cause) ||
      /retry/i.test((err as { name?: string } | null)?.name ?? '');
    const peers: Record<string, (taskId: string) => Promise<unknown>> = {
      'a retry-like reset': (taskId) => resetStepAndDownstream(db, taskId, 'fx-sync', 0),
      'a stop-like status write': (taskId) =>
        db.execute(sql`UPDATE tasks SET status = 'failed' WHERE id = ${taskId}`),
    };
    it.each(Object.keys(peers))('stays all-or-nothing against %s', async (peer) => {
      for (const set of [true, false]) {
        for (let i = 0; i < 10; i++) {
          const taskId = await make(CONTRACT, { planned: set, merged: false });
          await start(taskId);
          const entry = entryJob();
          const settled = await Promise.allSettled([
            processTaskJob(job(ADVANCE, entry.data)),
            peers[peer]!(taskId),
          ]);
          for (const s of settled) {
            if (s.status !== 'rejected') continue;
            expect(hasPgCode(s.reason, '40P01'), 'no deadlock').toBe(false);
            expect(retryable(s.reason), 'only a retry may be thrown').toBe(true);
          }
          const rows = await rowsOf(taskId);
          const entryRow = rows.find((r) => r.stepId === 'fx-sync');
          const span = rows.filter((r) => MEMBERS['planned-span'].includes(r.stepId));
          if (entryRow?.guardState == null) {
            expect(span.every((r) => r.guardState == null)).toBe(true);
          } else if (!parseGuardDecision(entryRow.guardState).run) {
            expect(span.every((r) => r.status === 'skipped' && r.guardState != null)).toBe(true);
          }
        }
      }
    });
  });
});
