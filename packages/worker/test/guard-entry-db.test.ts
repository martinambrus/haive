import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createDatabase, schema, type Database } from '@haive/database';
import { configService, logger, TASK_JOB_NAMES, type WorkflowType } from '@haive/shared';
import type { StepContext } from '@haive/shared/step';
import { decideGuardEntry, GuardRetry } from '../src/step-engine/guard-entry.js';
import { evaluateGuardDecision } from '../src/step-engine/guard-decisions.js';
import { advanceGuardSpan, skipGuardSpan } from '../src/step-engine/guard-span-skip.js';
import { processTaskJob } from '../src/queues/task-queue.js';
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
vi.mock('../src/step-engine/guard-span-skip.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/step-engine/guard-span-skip.js')>();
  return { ...real, advanceGuardSpan: vi.fn(real.advanceGuardSpan) };
});

const url = process.env.GUARD_ENTRY_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/guard_entry_test'))
  throw new Error('Use a dedicated guard_entry_test database');

const TYPE = 'guard_entry_type';
const EPOCH = 3;
const TOKEN = 'guard-member-refused';
const PREDICATE_ID = 'module.fx.guard';
const ids = ['plan', 'a', 'b', 'report'] as const;
type Id = (typeof ids)[number];
type Status = (typeof schema.taskSteps.$inferInsert)['status'];
const contract = {
  version: 1,
  guardedSpans: [
    { id: 'work', firstStepId: 'a', lastStepId: 'b', predicateId: PREDICATE_ID, args: {} },
  ],
};

const applied: string[] = [];
let verdict: () => unknown = () => true;
let memberNeedsInput = false;
const evaluate = vi.fn(async () => verdict() as boolean);
const predicate = { argsSchema: z.strictObject({}), evaluate };
const predicates = new Map([[PREDICATE_ID, predicate]]);

function stub(id: string, index: number): StepDefinition {
  return {
    metadata: {
      id,
      workflowType: 'module.fx' as WorkflowType,
      index,
      title: id,
      description: 'guard entry test stub',
      requiresCli: false,
    },
    async detect() {
      return {};
    },
    form() {
      return {
        title: id,
        fields:
          (id === 'b' || id === 'a') && memberNeedsInput
            ? [{ type: 'text', id: 'name', label: 'Name', required: true }]
            : [],
      };
    },
    shouldRun() {
      return true;
    },
    async apply() {
      applied.push(id);
      return {};
    },
    ...(id === 'plan' ? { guardPredicates: { guard: predicate } } : {}),
  } as StepDefinition;
}

describe.skipIf(!url)('the guard entry hook and membership check, on Postgres', () => {
  const EMAIL_INDEX = 'guard-entry-test-user';
  let db: Database;
  let userId: string;
  let repositoryId: string;
  let taskId: string;
  let rows: Record<string, typeof schema.taskSteps.$inferSelect>;

  const job = (name: string, data: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    ({
      id: randomUUID(),
      name,
      data,
      timestamp: Date.now(),
      moveToDelayed: async () => undefined,
      ...over,
    }) as unknown as Parameters<typeof processTaskJob>[0];
  const advance = (stepId: string, round = 0, over: Record<string, unknown> = {}) =>
    job(TASK_JOB_NAMES.ADVANCE_STEP, { taskId, userId, stepId, round, epoch: EPOCH }, over);

  async function seed(
    statuses: Record<Id, Status>,
    current: Id,
    over: Partial<typeof schema.tasks.$inferInsert> = {},
  ) {
    const [made] = await db
      .insert(schema.tasks)
      .values({
        userId,
        repositoryId,
        type: TYPE,
        title: 'guard entry',
        metadata: { anchorRepositoryId: null },
        status: 'running',
        orchestrationEpoch: EPOCH,
        currentStepId: current,
        currentRound: 0,
        runListSnapshot: [...ids],
        executionContract: contract,
        ...over,
      })
      .returning({ id: schema.tasks.id });
    taskId = made!.id;
    const inserted = await db
      .insert(schema.taskSteps)
      .values(
        ids.map((stepId, index) => ({
          taskId,
          stepId,
          title: stepId,
          stepIndex: index,
          runSeq: index,
          round: 0,
          status: statuses[stepId],
        })),
      )
      .returning();
    rows = Object.fromEntries(inserted.map((r) => [r.stepId, r]));
  }
  const ctxFor = (stepId: string, round = 0) =>
    ({
      taskId,
      taskStepId: rows[stepId]!.id,
      userId,
      db,
      round,
      epoch: EPOCH,
      rerunGeneration: 0,
      signal: new AbortController().signal,
      throwIfCancelled() {},
      logger,
    }) as unknown as StepContext;
  const decide = async (run: boolean) => {
    const pointer = (await taskRow()).currentStepId;
    const point = (currentStepId: string | null) =>
      db.update(schema.tasks).set({ currentStepId }).where(eq(schema.tasks.id, taskId));
    await point('a');
    verdict = () => run;
    await evaluateGuardDecision(ctxFor('a'), 'work', predicates);
    if (!run) await skipGuardSpan(ctxFor('a'), 'work', predicates);
    await point(pointer);
    evaluate.mockClear();
    verdict = () => true;
  };
  const setRow = (stepId: string, set: Partial<typeof schema.taskSteps.$inferInsert>) =>
    db.update(schema.taskSteps).set(set).where(eq(schema.taskSteps.id, rows[stepId]!.id));
  const rowOf = async (stepId: string, round = 0) => {
    const [found] = await db
      .select()
      .from(schema.taskSteps)
      .where(
        and(
          eq(schema.taskSteps.taskId, taskId),
          eq(schema.taskSteps.stepId, stepId),
          eq(schema.taskSteps.round, round),
        ),
      );
    return found!;
  };
  const taskRow = async () => {
    const [found] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId));
    return found!;
  };
  const events = (type?: string) =>
    db
      .select()
      .from(schema.taskEvents)
      .where(
        type
          ? and(eq(schema.taskEvents.taskId, taskId), eq(schema.taskEvents.eventType, type))
          : eq(schema.taskEvents.taskId, taskId),
      )
      .orderBy(asc(schema.taskEvents.createdAt));
  const pump = async (limit = 12) => {
    for (let i = 0; i < limit; i++) {
      const next = h.adds.find(
        (add) => add.name === TASK_JOB_NAMES.ADVANCE_STEP && !add.opts.delay,
      );
      if (!next) return;
      h.adds.splice(h.adds.indexOf(next), 1);
      await processTaskJob(job(TASK_JOB_NAMES.ADVANCE_STEP, { ...next.data }));
    }
  };
  const expectRefused = async (stepId: string, token: string, round = 0) => {
    const failed = await rowOf(stepId, round);
    expect(failed.status).toBe('failed');
    expect(failed.errorMessage).toContain(token);
    expect(await taskRow()).toMatchObject({ status: 'failed', deadAt: null });
    expect(applied).not.toContain(stepId);
  };

  beforeAll(async () => {
    db = createDatabase(url as string);
    h.db = db;
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, EMAIL_INDEX));
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'guard-entry-test@test.local',
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
        name: 'guard-entry',
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
    ids.forEach((id, index) => stepRegistry.override(stub(id, index)));
  });

  beforeEach(async () => {
    h.adds.length = 0;
    applied.length = 0;
    evaluate.mockClear();
    vi.mocked(advanceGuardSpan).mockClear();
    verdict = () => true;
    memberNeedsInput = false;
    vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
  });

  afterAll(async () => {
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
    await db.delete(schema.taskTypeDefinitions).where(eq(schema.taskTypeDefinitions.slug, TYPE));
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, EMAIL_INDEX));
    await db.$client.end({ timeout: 5 });
  });

  describe('membership of a fresh non-entry member', () => {
    it('M1 refuses a member whose entry was skipped by a run:false decision', async () => {
      await seed({ plan: 'done', a: 'pending', b: 'pending', report: 'pending' }, 'b');
      await decide(false);
      await setRow('b', { status: 'pending', guardState: null, endedAt: null });
      await processTaskJob(advance('b'));
      await expectRefused('b', TOKEN);
      expect((await rowOf('a')).status).toBe('skipped');
    });

    it('M2 refuses a member whose entry has no decision', async () => {
      await seed({ plan: 'done', a: 'pending', b: 'pending', report: 'pending' }, 'b');
      await processTaskJob(advance('b'));
      await expectRefused('b', TOKEN);
      expect((await rowOf('a')).guardState).toBeNull();
    });

    it('M3 runs a member whose entry decided run:true, and the run continues to the report', async () => {
      await seed({ plan: 'done', a: 'pending', b: 'pending', report: 'pending' }, 'b');
      await decide(true);
      await setRow('a', { status: 'done' });
      await processTaskJob(advance('b'));
      await pump();
      expect(applied).toEqual(['b', 'report']);
      expect((await rowOf('b')).status).toBe('done');
      expect((await rowOf('report')).status).toBe('done');
      expect(await taskRow()).toMatchObject({ deadAt: null });
      expect((await taskRow()).status).not.toBe('failed');
    });

    it('M4 runs a round 1 member against the round 0 entry decision', async () => {
      await seed({ plan: 'done', a: 'pending', b: 'pending', report: 'pending' }, 'b');
      await decide(true);
      await setRow('a', { status: 'done' });
      await setRow('b', { status: 'done' });
      await db.update(schema.tasks).set({ currentRound: 1 }).where(eq(schema.tasks.id, taskId));
      await db.insert(schema.taskSteps).values({
        taskId,
        stepId: 'b',
        title: 'b',
        stepIndex: 2,
        runSeq: 2,
        round: 1,
        status: 'pending',
      });
      await processTaskJob(advance('b', 1));
      expect(applied).toEqual(['b']);
      expect((await rowOf('b', 1)).status).toBe('done');
      expect(await taskRow()).toMatchObject({ deadAt: null });
      expect((await taskRow()).status).not.toBe('failed');
    });

    it('M5 refuses a member whose entry decision carries another contract hash', async () => {
      await seed({ plan: 'done', a: 'pending', b: 'pending', report: 'pending' }, 'b');
      await decide(true);
      const entry = await rowOf('a');
      await setRow('a', {
        status: 'done',
        guardState: { ...(entry.guardState as object), contractHash: 'f'.repeat(64) },
      });
      await processTaskJob(advance('b'));
      await expectRefused('b', TOKEN);
    });

    it('M6 runs a member whose entry was skipped by the user over a run:true decision', async () => {
      await seed({ plan: 'done', a: 'pending', b: 'pending', report: 'pending' }, 'b');
      await decide(true);
      await setRow('a', { status: 'skipped' });
      await processTaskJob(advance('b'));
      expect(applied).toEqual(['b']);
      expect((await rowOf('b')).status).toBe('done');
      expect(await taskRow()).toMatchObject({ deadAt: null });
      expect((await taskRow()).status).not.toBe('failed');
    });

    it('M7 leaves an already parked member to its own park under the entry decision', async () => {
      memberNeedsInput = true;
      await seed({ plan: 'done', a: 'pending', b: 'pending', report: 'pending' }, 'b');
      await decide(true);
      await setRow('a', { status: 'done' });
      await setRow('b', { status: 'waiting_form' });
      await processTaskJob(advance('b'));
      const parked = await rowOf('b');
      expect(parked.status).toBe('waiting_form');
      expect(parked.errorMessage).toBeNull();
      expect(await taskRow()).toMatchObject({ deadAt: null });
      expect((await taskRow()).status).not.toBe('failed');
      expect(applied).toEqual([]);
    });

    it('M7b refuses a parked member whose entry has no decision, so a form submit cannot run it', async () => {
      memberNeedsInput = true;
      await seed({ plan: 'done', a: 'pending', b: 'waiting_form', report: 'pending' }, 'b');
      await processTaskJob(advance('b'));
      await expectRefused('b', TOKEN);
      expect((await rowOf('b')).errorMessage).toContain('no-decision');
      expect(applied).toEqual([]);
    });

    it('M8 refuses a member whose entry generation moved on after its run:true decision', async () => {
      await seed({ plan: 'done', a: 'pending', b: 'pending', report: 'pending' }, 'b');
      await decide(true);
      await setRow('a', { status: 'done' });
      await db
        .update(schema.taskSteps)
        .set({ rerunGeneration: sql`${schema.taskSteps.rerunGeneration} + 1` })
        .where(eq(schema.taskSteps.id, rows.a!.id));
      expect((await rowOf('a')).guardState).toMatchObject({ run: true, generation: 0 });
      await processTaskJob(advance('b'));
      await expectRefused('b', TOKEN);
      expect((await rowOf('b')).errorMessage).toContain('decision-mismatch');
    });

    it('M9 refuses a reopened running member whose entry has no decision', async () => {
      await seed({ plan: 'done', a: 'pending', b: 'running', report: 'pending' }, 'b');
      await processTaskJob(advance('b'));
      await expectRefused('b', TOKEN);
    });

    it('M10 lets a reopened running member proceed under the entry run:true decision (negative control)', async () => {
      await seed({ plan: 'done', a: 'pending', b: 'pending', report: 'pending' }, 'b');
      await decide(true);
      await setRow('a', { status: 'done' });
      await setRow('b', { status: 'running' });
      await processTaskJob(advance('b'));
      expect((await rowOf('b')).status).not.toBe('failed');
      expect((await rowOf('b')).errorMessage).toBeNull();
      expect((await taskRow()).status).not.toBe('failed');
    });
  });

  describe('a reopened entry', () => {
    const expectReopenedRefused = async () => {
      await processTaskJob(advance('a'));
      const failed = await rowOf('a');
      expect(failed.status).toBe('failed');
      expect(failed.errorMessage).toContain('guard-decision-invalid');
      expect(evaluate).not.toHaveBeenCalled();
      expect(applied).toEqual([]);
      expect(await taskRow()).toMatchObject({ status: 'failed', deadAt: null });
    };

    it('E1 refuses an entry reopened as running without any decision', async () => {
      await seed({ plan: 'done', a: 'running', b: 'pending', report: 'pending' }, 'a');
      await expectReopenedRefused();
    });

    it('E2 refuses an entry reopened as running over a run:false decision', async () => {
      await seed({ plan: 'done', a: 'pending', b: 'pending', report: 'pending' }, 'a');
      await decide(false);
      await setRow('a', { status: 'running', endedAt: null });
      expect((await rowOf('a')).guardState).toMatchObject({ run: false });
      await expectReopenedRefused();
    });

    it('E3 lets an entry running under its run:true decision proceed (negative control)', async () => {
      await seed({ plan: 'done', a: 'pending', b: 'pending', report: 'pending' }, 'a');
      await decide(true);
      await setRow('a', { status: 'running' });
      await processTaskJob(advance('a'));
      expect(evaluate).not.toHaveBeenCalled();
      expect(applied).toContain('a');
      const after = await rowOf('a');
      expect(after.status).not.toBe('failed');
      expect(after.errorMessage).toBeNull();
      expect((await taskRow()).status).not.toBe('failed');
    });

    it('E4 leaves an entry parked on its form to its own park (negative control)', async () => {
      await seed({ plan: 'done', a: 'pending', b: 'pending', report: 'pending' }, 'a');
      await decide(true);
      memberNeedsInput = true;
      await setRow('a', { status: 'waiting_form' });
      await processTaskJob(advance('a'));
      const parked = await rowOf('a');
      expect(parked.status).toBe('waiting_form');
      expect(parked.errorMessage).toBeNull();
      expect(evaluate).not.toHaveBeenCalled();
      expect(applied).toEqual([]);
      expect((await taskRow()).status).not.toBe('failed');
    });
  });

  describe('stale outcomes of the entry decision', () => {
    const runList = () => ids.map((id, index) => stub(id, index));
    const scopeOf = async (over: { orchestrationEpoch?: number } = {}) => {
      const task = await taskRow();
      return {
        taskId,
        userId,
        orchestrationEpoch: over.orchestrationEpoch ?? task.orchestrationEpoch,
        executionContract: task.executionContract,
        runListSnapshot: task.runListSnapshot,
      };
    };
    const expectUntouched = async () => {
      expect(evaluate).not.toHaveBeenCalled();
      const entry = await db
        .select()
        .from(schema.taskSteps)
        .where(eq(schema.taskSteps.taskId, taskId));
      expect(entry.filter((r) => r.status === 'failed')).toEqual([]);
      expect(entry.filter((r) => r.guardState != null)).toEqual([]);
    };

    it('S1 reports stale when the orchestration epoch was superseded', async () => {
      await seed({ plan: 'done', a: 'pending', b: 'pending', report: 'pending' }, 'a');
      const outcome = await decideGuardEntry(
        db,
        await scopeOf({ orchestrationEpoch: EPOCH + 1 }),
        'a',
        0,
        await rowOf('a'),
        runList(),
      );
      expect(outcome.kind).toBe('stale');
      await expectUntouched();
    });

    it('S2 reports stale when the task is gone', async () => {
      await seed({ plan: 'done', a: 'pending', b: 'pending', report: 'pending' }, 'a');
      const real = vi.mocked(advanceGuardSpan).getMockImplementation()!;
      vi.mocked(advanceGuardSpan).mockImplementationOnce(async (...args) => {
        await db.delete(schema.tasks).where(eq(schema.tasks.id, taskId));
        return real(...args);
      });
      const outcome = await decideGuardEntry(
        db,
        await scopeOf(),
        'a',
        0,
        await rowOf('a'),
        runList(),
      );
      expect(advanceGuardSpan).toHaveBeenCalledTimes(1);
      expect(outcome.kind).toBe('stale');
      expect(evaluate).not.toHaveBeenCalled();
    });

    it('S3 reports stale when the task pointer is not on the entry', async () => {
      await seed({ plan: 'done', a: 'pending', b: 'pending', report: 'pending' }, 'plan');
      const outcome = await decideGuardEntry(
        db,
        await scopeOf(),
        'a',
        0,
        await rowOf('a'),
        runList(),
      );
      expect(outcome.kind).toBe('stale');
      await expectUntouched();
    });
  });

  describe('permanent refusals at the entry', () => {
    const expectEntryFailed = async (reason: string) => {
      const failed = await rowOf('a');
      expect(failed.status).toBe('failed');
      expect(failed.errorMessage).toContain(reason);
      expect(failed.guardState).toBeNull();
      expect(await taskRow()).toMatchObject({ status: 'failed', deadAt: null });
      expect(applied).not.toContain('a');
    };

    it('R1 fails the entry when its predecessor is not settled, without evaluating', async () => {
      await seed({ plan: 'skipped', a: 'pending', b: 'pending', report: 'pending' }, 'a');
      await expect(processTaskJob(advance('a'))).resolves.toBeUndefined();
      await expectEntryFailed('producer-not-settled');
      expect(evaluate).not.toHaveBeenCalled();
    });

    it('R2 fails the entry when the predicate throws, persisting no decision', async () => {
      await seed({ plan: 'done', a: 'pending', b: 'pending', report: 'pending' }, 'a');
      verdict = () => {
        throw new Error('predicate blew up');
      };
      await expect(processTaskJob(advance('a'))).resolves.toBeUndefined();
      await expectEntryFailed('predicate-evaluation-failed');
    });

    it('R3 fails the entry when the predicate returns a non-boolean', async () => {
      await seed({ plan: 'done', a: 'pending', b: 'pending', report: 'pending' }, 'a');
      verdict = () => 'yes';
      await expect(processTaskJob(advance('a'))).resolves.toBeUndefined();
      await expectEntryFailed('predicate-non-boolean');
    });
  });

  describe('transient guard errors', () => {
    it('T1 rejects for a retry while a member row is locked, then decides once it is free', async () => {
      await seed({ plan: 'done', a: 'pending', b: 'pending', report: 'pending' }, 'a');
      const peer = createDatabase(url!);
      let ready!: () => void;
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const taken = new Promise<void>((r) => {
        ready = r;
      });
      const holder = peer.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM task_steps WHERE id = ${rows.b!.id} FOR UPDATE`);
        ready();
        await gate;
      });
      await taken;
      const started = Date.now();
      try {
        await expect(
          processTaskJob(advance('a', 0, { attemptsMade: 0, opts: { attempts: 3 } })),
        ).rejects.toBeInstanceOf(GuardRetry);
        expect(Date.now() - started).toBeLessThan(4000);
        expect(await taskRow()).toMatchObject({ status: 'running', deadAt: null });
        const waiting = await rowOf('a');
        expect(waiting.status).toBe('pending');
        expect(waiting.guardState).toBeNull();
        expect(await events('step.failed')).toHaveLength(0);
        expect(await events('task.failed')).toHaveLength(0);
      } finally {
        release();
        await holder;
        await peer.$client.end({ timeout: 5 });
      }
      await processTaskJob(advance('a'));
      const decided = await rowOf('a');
      expect(decided.guardState).toMatchObject({ run: true, spanId: 'work' });
      expect(applied).toContain('a');
      expect(await taskRow()).toMatchObject({ deadAt: null });
      expect((await taskRow()).status).not.toBe('failed');
    }, 30_000);

    it('X1 fails the entry instead of rejecting when the last attempt meets a locked member', async () => {
      await seed({ plan: 'done', a: 'pending', b: 'pending', report: 'pending' }, 'a');
      const peer = createDatabase(url!);
      let ready!: () => void;
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const taken = new Promise<void>((r) => {
        ready = r;
      });
      const holder = peer.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM task_steps WHERE id = ${rows.b!.id} FOR UPDATE`);
        ready();
        await gate;
      });
      await taken;
      try {
        await expect(
          processTaskJob(advance('a', 0, { attemptsMade: 2, opts: { attempts: 3 } })),
        ).resolves.toBeUndefined();
      } finally {
        release();
        await holder;
        await peer.$client.end({ timeout: 5 });
      }
      const failed = await rowOf('a');
      expect(failed.status).toBe('failed');
      expect(failed.errorMessage).toContain('retries-exhausted');
      expect(await taskRow()).toMatchObject({ status: 'failed', deadAt: null });
      expect(applied).not.toContain('a');
    }, 30_000);
  });

  describe('the entry quick path', () => {
    const wrong: [string, (entry: typeof schema.taskSteps.$inferSelect) => Promise<unknown>][] = [
      ['generation', () => setRow('a', { rerunGeneration: 1 })],
      [
        'round',
        async (entry) => setRow('a', { guardState: { ...(entry.guardState as object), round: 1 } }),
      ],
      [
        'span id',
        async (entry) =>
          setRow('a', { guardState: { ...(entry.guardState as object), spanId: 'other' } }),
      ],
    ];

    it.each(wrong)(
      'Q1 does not take the quick path for a decision with the wrong %s',
      async (_n, corrupt) => {
        await seed({ plan: 'done', a: 'pending', b: 'pending', report: 'pending' }, 'a');
        await decide(true);
        await corrupt(await rowOf('a'));
        await processTaskJob(advance('a'));
        expect(advanceGuardSpan).toHaveBeenCalledTimes(1);
        const failed = await rowOf('a');
        expect(failed.status).toBe('failed');
        expect(failed.errorMessage).toContain('stale-decision');
        expect(applied).not.toContain('a');
      },
    );

    it('Q2 takes the quick path for a correct run:true decision, without evaluating again', async () => {
      await seed({ plan: 'done', a: 'pending', b: 'pending', report: 'pending' }, 'a');
      await decide(true);
      await processTaskJob(advance('a'));
      expect(evaluate).not.toHaveBeenCalled();
      expect(advanceGuardSpan).not.toHaveBeenCalled();
      expect(applied).toContain('a');
      expect((await rowOf('a')).status).toBe('done');
    });
  });

  describe('the entry decided by a newer pass', () => {
    const snapshot = async () => ({
      task: await taskRow(),
      rows: await db
        .select()
        .from(schema.taskSteps)
        .where(eq(schema.taskSteps.taskId, taskId))
        .orderBy(asc(schema.taskSteps.stepIndex)),
    });
    const advances = () => h.adds.filter((add) => add.name === TASK_JOB_NAMES.ADVANCE_STEP);
    const bumpAfterSkip = () => {
      const real = vi.mocked(advanceGuardSpan).getMockImplementation()!;
      let frozen: Awaited<ReturnType<typeof snapshot>> | undefined;
      vi.mocked(advanceGuardSpan).mockImplementationOnce(async (...args) => {
        const result = await real(...args);
        expect(result.kind).toBe('skipped');
        await db
          .update(schema.taskSteps)
          .set({ rerunGeneration: sql`${schema.taskSteps.rerunGeneration} + 1` })
          .where(eq(schema.taskSteps.id, rows.a!.id));
        frozen = await snapshot();
        return result;
      });
      return () => frozen!;
    };

    it('Q4 hands off nothing when the entry generation moved on after the skip', async () => {
      await seed({ plan: 'done', a: 'pending', b: 'pending', report: 'pending' }, 'a');
      verdict = () => false;
      const frozen = bumpAfterSkip();
      await expect(processTaskJob(advance('a'))).resolves.toBeUndefined();
      expect(advanceGuardSpan).toHaveBeenCalledTimes(1);
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(advances()).toEqual([]);
      const after = await snapshot();
      expect(after).toEqual(frozen());
      expect(after.rows.find((r) => r.stepId === 'a')).toMatchObject({
        status: 'skipped',
        rerunGeneration: 1,
      });
      expect(after.rows.filter((r) => r.status === 'failed')).toEqual([]);
      expect(applied).toEqual([]);
    });

    it('Q4b hands off to the next step when the generation did not move (negative control)', async () => {
      await seed({ plan: 'done', a: 'pending', b: 'pending', report: 'pending' }, 'a');
      verdict = () => false;
      await expect(processTaskJob(advance('a'))).resolves.toBeUndefined();
      expect(advanceGuardSpan).toHaveBeenCalledTimes(1);
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(advances()).toHaveLength(1);
      expect((await rowOf('a')).status).toBe('skipped');
    });
  });

  describe('steps outside spans', () => {
    it('Z1 never consults the guard for a step outside a span', async () => {
      await seed({ plan: 'pending', a: 'pending', b: 'pending', report: 'pending' }, 'plan');
      await processTaskJob(advance('plan'));
      expect(applied).toEqual(['plan']);
      expect(advanceGuardSpan).not.toHaveBeenCalled();
      await db.delete(schema.tasks).where(eq(schema.tasks.id, taskId));
      await seed({ plan: 'done', a: 'done', b: 'done', report: 'pending' }, 'report');
      await processTaskJob(advance('report'));
      expect(applied).toEqual(['plan', 'report']);
      expect(advanceGuardSpan).not.toHaveBeenCalled();
    });

    it('Z1 never consults the guard for an ordinary task with no contract', async () => {
      await seed({ plan: 'pending', a: 'pending', b: 'pending', report: 'pending' }, 'plan', {
        executionContract: null,
      });
      await processTaskJob(advance('plan'));
      await pump();
      expect(applied).toEqual([...ids]);
      expect(advanceGuardSpan).not.toHaveBeenCalled();
      expect(await taskRow()).toMatchObject({ deadAt: null });
      expect((await taskRow()).status).not.toBe('failed');
    });
  });
});
