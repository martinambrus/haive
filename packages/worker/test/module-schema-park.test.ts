import { randomBytes } from 'node:crypto';
import type { Job } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { configService, TASK_JOB_NAMES, type WorkflowType } from '@haive/shared';
import { computeTaskTiming } from '@haive/shared/timing';
import {
  markModuleSchemaFailed,
  markModuleSchemaReady,
  markModuleSchemaUnready,
} from '../src/modules/schema-ready.js';
import { processTaskJob, setContainerCleanupRunner } from '../src/queues/task-queue.js';
import { stepRegistry } from '../src/step-engine/registry.js';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  adds: [] as { name: string; data: Record<string, unknown>; opts: { delay?: number } }[],
  afterLockedRead: undefined as undefined | (() => Promise<void>),
  afterPlainRead: undefined as undefined | (() => Promise<void>),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/modules/activation.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/modules/activation.js')>();
  return {
    ...real,
    moduleDeactivationMessage: async (
      ...args: Parameters<typeof real.moduleDeactivationMessage>
    ) => {
      const message = await real.moduleDeactivationMessage(...args);
      if (args[2]?.lock) await h.afterLockedRead?.();
      else await h.afterPlainRead?.();
      return message;
    },
  };
});
vi.mock('../src/redis.js', () => ({
  getBullRedis: () => ({}),
  getRedis: () => ({ scan: async () => ['0', []], del: async () => 0 }),
}));
vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('bullmq')>()),
  Queue: class {
    async add(name: string, data: Record<string, unknown>, opts: { delay?: number }) {
      h.adds.push({ name, data, opts: opts ?? {} });
      return undefined;
    }
  },
}));
vi.mock('../src/sandbox/task-auth-volume.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/task-auth-volume.js')>()),
  cleanupTaskAuthVolumes: vi.fn(async () => ({ removed: [], failed: [] })),
  syncRefreshedAuthToUserVolumes: vi.fn(async () => undefined),
}));

const url = process.env.MODULE_SCHEMA_PARK_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/module_schema_park_test'))
  throw new Error('Use a dedicated module_schema_park_test database for module schema park tests');

const MODULE = `alpha-${randomBytes(3).toString('hex')}`;
const STEP = `module.${MODULE}.x`;
const EMAIL_INDEX = 'module-schema-park-test-user';
const START_TYPE = 'module-schema-park';
const OFF = new Date('2026-10-14T08:00:00.000Z');

const phases = {
  shouldRun: vi.fn(async () => true),
  detect: vi.fn(async () => ({})),
  apply: vi.fn(async () => ({})),
};
stepRegistry.register({
  metadata: {
    id: STEP,
    workflowType: `module.${MODULE}` as WorkflowType,
    index: 0,
    title: STEP,
    description: 'the first step of a module run list',
    requiresCli: false,
  },
  ...phases,
});

const advances = () => h.adds.filter((add) => add.name === TASK_JOB_NAMES.ADVANCE_STEP);

describe.skipIf(!url)('a module step whose schema is unready, on Postgres', () => {
  let db: Database;
  let userId: string;
  let taskId: string;
  let ran = 0;

  const jobOf = (name: string, data: Record<string, unknown>) =>
    ({
      id: `job-${h.adds.length}-${Math.random()}`,
      name,
      data,
      timestamp: Date.now(),
      moveToDelayed: async () => undefined,
    }) as unknown as Job;
  const start = () => processTaskJob(jobOf(TASK_JOB_NAMES.START, { taskId, userId }), 'tok');
  const runningTask = () =>
    db
      .update(schema.tasks)
      .set({ status: 'running', currentStepId: STEP, currentRound: 0 })
      .where(eq(schema.tasks.id, taskId));
  const tick = async () =>
    processTaskJob(
      jobOf(TASK_JOB_NAMES.ADVANCE_STEP, {
        taskId,
        userId,
        stepId: STEP,
        round: 0,
        epoch: (await task()).orchestrationEpoch,
      }),
      'tok',
    );
  const runNext = async () => {
    const next = advances()[ran];
    if (!next) throw new Error('no queued advance to run');
    ran += 1;
    await processTaskJob(jobOf(TASK_JOB_NAMES.ADVANCE_STEP, next.data), 'tok');
  };
  const task = async () =>
    (await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)))[0]!;
  const rows = () => db.select().from(schema.taskSteps).where(eq(schema.taskSteps.taskId, taskId));
  const events = (type: string) =>
    db
      .select()
      .from(schema.taskEvents)
      .where(eq(schema.taskEvents.taskId, taskId))
      .then((all) => all.filter((ev) => ev.eventType === type));
  const setModule = (deactivatedAt: Date | null) =>
    db.insert(schema.modules).values({
      moduleId: MODULE,
      packageName: `@haive/module-${MODULE}`,
      name: MODULE,
      installedVersion: '1.0.0',
      deactivatedAt,
    });
  const noPhaseRan = () => {
    expect(phases.shouldRun).not.toHaveBeenCalled();
    expect(phases.detect).not.toHaveBeenCalled();
    expect(phases.apply).not.toHaveBeenCalled();
  };

  beforeAll(async () => {
    db = createDatabase(url as string);
    h.db = db;
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, EMAIL_INDEX));
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'module-schema-park-test@test.local',
        emailBlindIndex: EMAIL_INDEX,
        passwordHash: 'not-real',
        role: 'user',
        status: 'active',
        tokenVersion: 0,
      })
      .returning();
    userId = user!.id;
    await db
      .insert(schema.taskTypeDefinitions)
      .values({
        slug: START_TYPE,
        displayName: 'Schema park',
        runListStrategy: 'static',
        stepIds: [STEP],
        source: 'admin',
      })
      .onConflictDoNothing();
  });

  beforeEach(async () => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    setContainerCleanupRunner(async () => 0);
    Object.values(phases).forEach((phase) => phase.mockClear());
    h.adds.length = 0;
    h.afterLockedRead = undefined;
    h.afterPlainRead = undefined;
    ran = 0;
    await db.delete(schema.modules);
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
    await db.delete(schema.repositories).where(eq(schema.repositories.userId, userId));
    const [repo] = await db
      .insert(schema.repositories)
      .values({ userId, name: 'schema-park', source: 'blank', storagePath: '/tmp/schema-park' })
      .returning();
    const [made] = await db
      .insert(schema.tasks)
      .values({
        userId,
        repositoryId: repo!.id,
        type: START_TYPE,
        title: 'schema park',
        status: 'queued',
        runListSnapshot: [STEP],
      })
      .returning();
    taskId = made!.id;
    await setModule(null);
    markModuleSchemaUnready(MODULE);
  });

  afterEach(() => {
    markModuleSchemaReady(MODULE);
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    setContainerCleanupRunner(null);
    await db.delete(schema.modules);
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
    await db.delete(schema.repositories).where(eq(schema.repositories.userId, userId));
    await db
      .delete(schema.taskTypeDefinitions)
      .where(eq(schema.taskTypeDefinitions.slug, START_TYPE));
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, EMAIL_INDEX));
    await db.$client.end({ timeout: 5 });
  });

  it('F1: START hands the first step to an advance and writes no step row', async () => {
    await start();
    expect(await rows()).toEqual([]);
    expect(advances()).toHaveLength(1);
    expect(advances()[0]!.data).toMatchObject({
      taskId,
      stepId: STEP,
      epoch: (await task()).orchestrationEpoch,
    });
    expect(advances()[0]!.opts.delay).toBeUndefined();
    expect(await task()).toMatchObject({ status: 'running', currentStepId: STEP });
    noPhaseRan();
  });

  it('F2: the first tick parks the row pending with a marker and queues a 5 s poll', async () => {
    await runningTask();
    await tick();
    const found = await rows();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ stepId: STEP, status: 'pending' });
    expect(found[0]!.waitingStartedAt).toBeInstanceOf(Date);
    expect(found[0]!.statusMessage).toMatch(/schema is being set up/);
    expect(found[0]!.statusMessage).toContain(MODULE);
    expect(await task()).toMatchObject({ status: 'running', currentStepId: STEP });
    expect(advances()).toHaveLength(1);
    expect(advances()[0]!.opts.delay).toBe(5000);
    noPhaseRan();
    expect(found.some((row) => row.status === 'failed')).toBe(false);
    expect(await events('step.failed')).toEqual([]);
  });

  it('F3: a second tick keeps the marker and the words and only moves updated_at', async () => {
    await runningTask();
    await tick();
    expect(advances()).toHaveLength(1);
    const [first] = await rows();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runNext();
    const [second] = await rows();
    expect(first!.status).toBe('pending');
    expect(second!.waitingStartedAt).toEqual(first!.waitingStartedAt);
    expect(second!.statusMessage).toBe(first!.statusMessage);
    expect(second!.updatedAt.getTime()).toBeGreaterThan(first!.updatedAt.getTime());
    expect(advances()).toHaveLength(2);
    expect(advances()[1]!.opts.delay).toBe(5000);
    noPhaseRan();
  });

  it('F4: once the flag clears the next tick runs the step and folds the park as idle', async () => {
    await runningTask();
    await tick();
    expect(advances()).toHaveLength(1);
    await runNext();
    await db
      .update(schema.taskSteps)
      .set({ waitingStartedAt: sql`now() - interval '90 seconds'` })
      .where(eq(schema.taskSteps.taskId, taskId));
    markModuleSchemaReady(MODULE);
    await runNext();
    expect(phases.detect).toHaveBeenCalledTimes(1);
    const [row] = await rows();
    expect(row!.startedAt).toBeInstanceOf(Date);
    expect(row!.waitingStartedAt).toBeNull();
    const idle = computeTaskTiming([row!], Date.now()).idleMs;
    expect(idle).toBeGreaterThanOrEqual(89_000);
    expect(idle).toBeLessThan(120_000);
  });

  it('F5: a deactivated module fails its row with the deactivation words and parks nothing', async () => {
    await db.delete(schema.modules);
    await setModule(OFF);
    await runningTask();
    await tick();
    const found = await rows();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ status: 'failed', waitingStartedAt: null });
    expect(found[0]!.errorMessage).toMatch(/deactivated/);
    expect(advances()).toHaveLength(0);
    noPhaseRan();
  });

  it('F5b: a START on a deactivated module fails the first step at once and queues no advance', async () => {
    await db.delete(schema.modules);
    await setModule(OFF);
    await start();
    const found = await rows();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ status: 'failed', waitingStartedAt: null });
    expect(found[0]!.errorMessage).toMatch(/deactivated/);
    expect(advances()).toHaveLength(0);
    noPhaseRan();
  });

  it('F6: a started row is left untouched, its advance deferred once without the answer', async () => {
    await runningTask();
    await db.insert(schema.taskSteps).values({
      taskId,
      stepId: STEP,
      stepIndex: 100,
      runSeq: 0,
      round: 0,
      title: STEP,
      status: 'waiting_form',
      formSchema: { title: 'x', fields: [] },
      formValues: { saved: 'yes' },
    });
    const [before] = await rows();
    const epoch = (await task()).orchestrationEpoch;
    const adds = advances().length;
    await processTaskJob(
      jobOf(TASK_JOB_NAMES.ADVANCE_STEP, {
        taskId,
        userId,
        stepId: STEP,
        round: 0,
        formValues: { answer: 'now' },
      }),
      'tok',
    );
    const [after] = await rows();
    expect(after).toEqual(before);
    expect(after).toMatchObject({
      status: 'waiting_form',
      formValues: { saved: 'yes' },
      waitingStartedAt: null,
    });
    expect(advances()).toHaveLength(adds + 1);
    const deferred = advances()[adds]!;
    expect(deferred.opts.delay).toBe(5000);
    expect(deferred.data.epoch).toBe(epoch);
    expect(deferred.data.formValues).toBeUndefined();
    noPhaseRan();

    markModuleSchemaReady(MODULE);
    ran = adds;
    await runNext();
    expect(phases.detect.mock.calls.length + phases.apply.mock.calls.length).toBeGreaterThan(0);
  });

  it('G1: when the setup is spent, a parked row fails on its next poll with the setup-failed words and the task fails', async () => {
    await runningTask();
    await tick();
    await runNext();
    expect((await rows())[0]).toMatchObject({ status: 'pending' });
    markModuleSchemaFailed(MODULE);
    const adds = advances().length;
    await runNext();
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'failed', waitingStartedAt: null });
    expect(row!.errorMessage).toMatch(/no longer being retried/);
    expect(row!.errorMessage).toContain(MODULE);
    expect(row!.errorMessage).toMatch(/reactivating the module/);
    expect(advances()).toHaveLength(adds);
    expect((await task()).status).toBe('failed');
    noPhaseRan();
  });

  it('G2: a fresh step on a module whose setup is spent fails at once and does not park', async () => {
    markModuleSchemaFailed(MODULE);
    await runningTask();
    await tick();
    const found = await rows();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ status: 'failed', waitingStartedAt: null });
    expect(found[0]!.errorMessage).toMatch(/no longer being retried/);
    expect(advances()).toHaveLength(0);
    expect((await task()).status).toBe('failed');
    noPhaseRan();
  });

  it('G2b: a START on a module whose setup is spent fails the first step at once', async () => {
    markModuleSchemaFailed(MODULE);
    await start();
    const found = await rows();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ status: 'failed' });
    expect(found[0]!.errorMessage).toMatch(/no longer being retried/);
    expect(advances()).toHaveLength(0);
    noPhaseRan();
  });

  it('G3: a reactivation that resets the attempts leaves a parked row parked, and a ready schema runs it', async () => {
    await runningTask();
    await tick();
    markModuleSchemaFailed(MODULE);
    markModuleSchemaUnready(MODULE);
    await runNext();
    expect((await rows())[0]).toMatchObject({ status: 'pending' });
    expect((await rows())[0]!.errorMessage).toBeNull();
    expect((await task()).status).toBe('running');
    markModuleSchemaReady(MODULE);
    await runNext();
    expect(phases.detect).toHaveBeenCalledTimes(1);
    expect((await rows())[0]!.status).not.toBe('failed');
  });

  it('G4: a setup that failed at admission and was reset before the runner read it parks the row and runs once ready', async () => {
    markModuleSchemaFailed(MODULE);
    await runningTask();
    h.afterLockedRead = async () => markModuleSchemaUnready(MODULE);
    const epoch = (await task()).orchestrationEpoch;
    await tick();
    const [row] = await rows();
    expect(row!.status).not.toBe('failed');
    expect(row!.errorMessage).toBeNull();
    expect((await task()).status).toBe('running');
    expect(advances()).toHaveLength(1);
    expect(advances()[0]!.opts.delay).toBe(5000);
    expect(advances()[0]!.data.epoch).toBe(epoch);
    noPhaseRan();

    h.afterLockedRead = undefined;
    await runNext();
    expect((await rows())[0]).toMatchObject({ status: 'pending' });
    markModuleSchemaReady(MODULE);
    await runNext();
    expect(phases.detect).toHaveBeenCalledTimes(1);
    expect((await rows())[0]!.status).not.toBe('failed');
  });

  it('G5: a setup still failed when the runner reads it fails the row with the setup-failed words', async () => {
    markModuleSchemaFailed(MODULE);
    await runningTask();
    h.afterLockedRead = async () => undefined;
    await tick();
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'failed' });
    expect(row!.errorMessage).toMatch(/no longer being retried/);
    expect(advances()).toHaveLength(0);
    noPhaseRan();
  });

  it('G6: a deactivation read at admission still fails the row though the module is back since', async () => {
    await db.update(schema.modules).set({ deactivatedAt: OFF });
    await runningTask();
    h.afterLockedRead = async () => {
      await db.update(schema.modules).set({ deactivatedAt: null });
    };
    await tick();
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'failed' });
    expect(row!.errorMessage).toMatch(/is deactivated/);
    noPhaseRan();
  });

  it('H1: a setup failed at the wait read and reset during the deactivation read does not run the step, which defers and runs once ready', async () => {
    markModuleSchemaFailed(MODULE);
    await runningTask();
    h.afterPlainRead = async () => markModuleSchemaUnready(MODULE);
    const epoch = (await task()).orchestrationEpoch;
    await tick();
    noPhaseRan();
    expect((await rows())[0]!.status).not.toBe('failed');
    expect(advances()).toHaveLength(1);
    expect(advances()[0]!.opts.delay).toBe(5000);
    expect(advances()[0]!.data.epoch).toBe(epoch);

    h.afterPlainRead = undefined;
    markModuleSchemaReady(MODULE);
    await runNext();
    expect(phases.detect).toHaveBeenCalledTimes(1);
    expect((await rows())[0]!.status).not.toBe('failed');
  });

  it('H2: a START whose setup is reset after its wait read does not run the first step, which defers and runs once ready', async () => {
    markModuleSchemaFailed(MODULE);
    h.afterLockedRead = async () => markModuleSchemaUnready(MODULE);
    await start();
    noPhaseRan();
    expect((await rows())[0]?.status).not.toBe('failed');
    expect(advances()).toHaveLength(1);
    expect(advances()[0]!.opts.delay).toBe(5000);

    h.afterLockedRead = undefined;
    markModuleSchemaReady(MODULE);
    await runNext();
    expect(phases.detect).toHaveBeenCalledTimes(1);
  });

  it('F7: a paused task holds with the pause words and the 30 s poll, not the schema ones', async () => {
    await db.update(schema.tasks).set({ pausedAt: new Date() }).where(eq(schema.tasks.id, taskId));
    await start();
    await runNext();
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'pending' });
    expect(row!.statusMessage).toMatch(/^Paused/);
    expect(advances().at(-1)!.opts.delay).toBe(30_000);
    noPhaseRan();
  });
});
