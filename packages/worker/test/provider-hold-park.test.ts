import { randomBytes } from 'node:crypto';
import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { configService, TASK_JOB_NAMES, type WorkflowType } from '@haive/shared';
import { processTaskJob, setContainerCleanupRunner } from '../src/queues/task-queue.js';
import { stepRegistry } from '../src/step-engine/registry.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  adds: [] as { name: string; data: Record<string, unknown>; opts: { delay?: number } }[],
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
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

const url = process.env.PROVIDER_HOLD_PARK_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/provider_hold_park_test'))
  throw new Error('Use a dedicated provider_hold_park_test database for provider hold tests');

const SUFFIX = randomBytes(3).toString('hex');
const SENSITIVE = `provider-hold-${SUFFIX}.sensitive`;
const LLM = `provider-hold-${SUFFIX}.llm`;
const PLAIN = `provider-hold-${SUFFIX}.plain`;
const SKIPPED = `provider-hold-${SUFFIX}.skipped`;
const EMAIL_INDEX = 'provider-hold-park-test-user';
const START_TYPE = 'provider-hold-park';

const phases = {
  shouldRun: vi.fn(async () => true),
  detect: vi.fn(async () => ({})),
  apply: vi.fn(async () => ({})),
};
const skippedPhases = {
  shouldRun: vi.fn(async () => false),
  detect: vi.fn(async () => ({})),
  apply: vi.fn(async () => ({})),
};
const define = (
  id: string,
  index: number,
  extra: { providerSensitive?: boolean; llm?: StepDefinition['llm'] },
  own: typeof phases,
) =>
  stepRegistry.register({
    metadata: {
      id,
      workflowType: `provider-hold-${SUFFIX}` as WorkflowType,
      index,
      title: id,
      description: 'a step for the provider hold test',
      requiresCli: false,
      ...(extra.providerSensitive ? { providerSensitive: true } : {}),
    },
    ...(extra.llm ? { llm: extra.llm } : {}),
    ...own,
  } as StepDefinition);
define(SENSITIVE, 0, { providerSensitive: true }, phases);
define(LLM, 1, { llm: { requiredCapabilities: [], buildPrompt: () => 'a prompt' } }, phases);
define(PLAIN, 2, {}, phases);
define(SKIPPED, 3, { providerSensitive: true }, skippedPhases);

const advances = () => h.adds.filter((add) => add.name === TASK_JOB_NAMES.ADVANCE_STEP);

describe.skipIf(!url)('a fresh step on a disabled explicit CLI provider, on Postgres', () => {
  let db: Database;
  let userId: string;
  let taskId: string;
  let ownId: string;
  let otherId: string;
  let ran = 0;

  const jobOf = (name: string, data: Record<string, unknown>) =>
    ({
      id: `job-${h.adds.length}-${Math.random()}`,
      name,
      data,
      timestamp: Date.now(),
      moveToDelayed: async () => undefined,
    }) as unknown as Job;
  const task = async () =>
    (await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)))[0]!;
  const start = () => processTaskJob(jobOf(TASK_JOB_NAMES.START, { taskId, userId }), 'tok');
  const runningTask = (stepId = SENSITIVE) =>
    db
      .update(schema.tasks)
      .set({ status: 'running', currentStepId: stepId, currentRound: 0 })
      .where(eq(schema.tasks.id, taskId));
  const tick = async (stepId = SENSITIVE, extra: Record<string, unknown> = {}) =>
    processTaskJob(
      jobOf(TASK_JOB_NAMES.ADVANCE_STEP, {
        taskId,
        userId,
        stepId,
        round: 0,
        epoch: (await task()).orchestrationEpoch,
        ...extra,
      }),
      'tok',
    );
  const runNext = async () => {
    const next = advances()[ran];
    if (!next) throw new Error('no queued advance to run');
    ran += 1;
    await processTaskJob(jobOf(TASK_JOB_NAMES.ADVANCE_STEP, next.data), 'tok');
  };
  const rows = () => db.select().from(schema.taskSteps).where(eq(schema.taskSteps.taskId, taskId));
  const events = (type: string) =>
    db
      .select()
      .from(schema.taskEvents)
      .where(eq(schema.taskEvents.taskId, taskId))
      .then((all) => all.filter((ev) => ev.eventType === type));
  const setProvider = (id: string, enabled: boolean) =>
    db.update(schema.cliProviders).set({ enabled }).where(eq(schema.cliProviders.id, id));
  const noDetectOrApply = () => {
    expect(phases.detect).not.toHaveBeenCalled();
    expect(phases.apply).not.toHaveBeenCalled();
  };
  const expectNotHeld = async () => {
    expect(advances().some((add) => add.opts.delay === 30_000)).toBe(false);
    expect((await rows()).some((row) => row.statusMessage?.includes('Own CLI'))).toBe(false);
  };

  beforeAll(async () => {
    db = createDatabase(url as string);
    h.db = db;
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, EMAIL_INDEX));
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'provider-hold-park-test@test.local',
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
        displayName: 'Provider hold',
        runListStrategy: 'static',
        stepIds: [SENSITIVE, LLM, PLAIN, SKIPPED],
        source: 'admin',
      })
      .onConflictDoNothing();
  });

  beforeEach(async () => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    setContainerCleanupRunner(async () => 0);
    [phases, skippedPhases].forEach((own) => Object.values(own).forEach((fn) => fn.mockClear()));
    h.adds.length = 0;
    ran = 0;
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
    await db
      .delete(schema.userStepCliPreferences)
      .where(eq(schema.userStepCliPreferences.userId, userId));
    await db.delete(schema.cliProviders).where(eq(schema.cliProviders.userId, userId));
    await db.delete(schema.repositories).where(eq(schema.repositories.userId, userId));
    const [own] = await db
      .insert(schema.cliProviders)
      .values({
        userId,
        name: 'claude-code',
        label: 'Own CLI',
        enabled: false,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      })
      .returning();
    const [other] = await db
      .insert(schema.cliProviders)
      .values({
        userId,
        name: 'codex',
        label: 'Other CLI',
        enabled: true,
        createdAt: new Date('2026-02-01T00:00:00Z'),
      })
      .returning();
    ownId = own!.id;
    otherId = other!.id;
    const [repo] = await db
      .insert(schema.repositories)
      .values({ userId, name: 'provider-hold', source: 'blank', storagePath: '/tmp/provider-hold' })
      .returning();
    const [made] = await db
      .insert(schema.tasks)
      .values({
        userId,
        repositoryId: repo!.id,
        type: START_TYPE,
        title: 'provider hold',
        status: 'queued',
        cliProviderId: ownId,
        runListSnapshot: [SENSITIVE, LLM, PLAIN, SKIPPED],
      })
      .returning();
    taskId = made!.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    setContainerCleanupRunner(null);
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
    await db
      .delete(schema.userStepCliPreferences)
      .where(eq(schema.userStepCliPreferences.userId, userId));
    await db.delete(schema.cliProviders).where(eq(schema.cliProviders.userId, userId));
    await db.delete(schema.repositories).where(eq(schema.repositories.userId, userId));
    await db
      .delete(schema.taskTypeDefinitions)
      .where(eq(schema.taskTypeDefinitions.slug, START_TYPE));
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, EMAIL_INDEX));
    await db.$client.end({ timeout: 5 });
  });

  it('H1: the first tick parks the row pending with a marker, the provider label and a 30 s poll', async () => {
    await runningTask();
    await tick();
    const found = await rows();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ stepId: SENSITIVE, status: 'pending' });
    expect(found[0]!.waitingStartedAt).toBeInstanceOf(Date);
    expect(found[0]!.statusMessage).toContain('Own CLI');
    expect(advances()).toHaveLength(1);
    expect(advances()[0]!.opts.delay).toBe(30_000);
    noDetectOrApply();
    expect(found.some((row) => row.status === 'failed')).toBe(false);
    expect(await events('step.failed')).toEqual([]);
  });

  it('H2: a second tick keeps the marker and the words and only moves updated_at', async () => {
    await runningTask();
    await tick();
    const [first] = await rows();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runNext();
    const [second] = await rows();
    expect(second!.status).toBe('pending');
    expect(second!.waitingStartedAt).toEqual(first!.waitingStartedAt);
    expect(second!.statusMessage).toBe(first!.statusMessage);
    expect(second!.updatedAt.getTime()).toBeGreaterThan(first!.updatedAt.getTime());
    expect(advances()).toHaveLength(2);
    expect(advances()[1]!.opts.delay).toBe(30_000);
    noDetectOrApply();
  });

  it('H3: enabling the provider again lets the next tick run the step and clears the marker', async () => {
    await runningTask();
    await tick();
    await runNext();
    await setProvider(ownId, true);
    await runNext();
    expect(phases.detect).toHaveBeenCalledTimes(1);
    const [row] = await rows();
    expect(row!.startedAt).toBeInstanceOf(Date);
    expect(row!.waitingStartedAt).toBeNull();
  });

  it('H4: an enabled CLI picked for the step in this task releases the park', async () => {
    await runningTask();
    await tick();
    await db
      .insert(schema.taskStepCliChoices)
      .values({ taskId, stepId: SENSITIVE, role: 'default', cliProviderId: otherId });
    await runNext();
    expect(phases.detect).toHaveBeenCalledTimes(1);
    expect((await rows())[0]!.waitingStartedAt).toBeNull();
  });

  it('H5: a global pause wins over the provider hold and shows the pause words', async () => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
    await runningTask();
    await tick();
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'pending' });
    expect(row!.statusMessage).toMatch(/^Paused/);
    expect(row!.statusMessage).not.toContain('Own CLI');
    expect(advances()[0]!.opts.delay).toBe(30_000);
    noDetectOrApply();
  });

  it('H6: a waiting_form row is a continuation and is not held', async () => {
    await runningTask();
    await db.insert(schema.taskSteps).values({
      taskId,
      stepId: SENSITIVE,
      stepIndex: 100,
      runSeq: 0,
      round: 0,
      title: SENSITIVE,
      status: 'waiting_form',
      formSchema: { title: 'x', fields: [] },
      formValues: { saved: 'yes' },
    });
    await tick(SENSITIVE, { formValues: { answer: 'now' } });
    const [row] = await rows();
    expect(row!.waitingStartedAt).toBeNull();
    expect(phases.detect).toHaveBeenCalledTimes(1);
    expect(phases.apply).toHaveBeenCalledTimes(1);
    expect(row!.status).toBe('done');
    await expectNotHeld();
  });

  it('H7: an implicit task whose oldest provider is disabled runs on the next enabled one', async () => {
    await db.update(schema.tasks).set({ cliProviderId: null }).where(eq(schema.tasks.id, taskId));
    await runningTask();
    await tick();
    expect(phases.detect).toHaveBeenCalledTimes(1);
    expect((await rows())[0]!.waitingStartedAt).toBeNull();
    await expectNotHeld();
  });

  it('H8: a step that dispatches no CLI and is not provider-sensitive is not held', async () => {
    await runningTask(PLAIN);
    await tick(PLAIN);
    expect(phases.detect).toHaveBeenCalledTimes(1);
    expect((await rows())[0]!.waitingStartedAt).toBeNull();
    await expectNotHeld();
  });

  it('H9: a step with an llm phase is held on the disabled own CLI and never runs', async () => {
    await runningTask(LLM);
    await tick(LLM);
    const [row] = await rows();
    expect(row).toMatchObject({ stepId: LLM, status: 'pending' });
    expect(row!.waitingStartedAt).toBeInstanceOf(Date);
    expect(row!.statusMessage).toContain('Own CLI');
    expect(advances()[0]!.opts.delay).toBe(30_000);
    noDetectOrApply();
  });

  it('H10: a step whose shouldRun says skip is not held', async () => {
    await runningTask(SKIPPED);
    await tick(SKIPPED);
    const [row] = await rows();
    expect(row).toMatchObject({ stepId: SKIPPED, status: 'skipped' });
    expect(row!.waitingStartedAt).toBeNull();
    expect(skippedPhases.detect).not.toHaveBeenCalled();
    await expectNotHeld();
  });

  it('H11: START on a first step with a disabled own CLI runs no phase and queues one undelayed advance', async () => {
    await start();
    const found = await rows();
    expect(found.every((row) => row.status === 'pending' && row.waitingStartedAt === null)).toBe(
      true,
    );
    expect(advances()).toHaveLength(1);
    expect(advances()[0]!.data).toMatchObject({ taskId, stepId: SENSITIVE });
    expect(advances()[0]!.opts.delay).toBeUndefined();
    noDetectOrApply();
  });

  it('H12: a saved explicit preference for a disabled provider holds a task whose own CLI is enabled, unless the task ignores saved choices', async () => {
    await db
      .update(schema.tasks)
      .set({ cliProviderId: otherId })
      .where(eq(schema.tasks.id, taskId));
    await db
      .insert(schema.userStepCliPreferences)
      .values({ userId, stepId: SENSITIVE, cliProviderId: ownId, explicit: true });
    await runningTask();
    await tick();
    const [held] = await rows();
    expect(held).toMatchObject({ stepId: SENSITIVE, status: 'pending' });
    expect(held!.waitingStartedAt).toBeInstanceOf(Date);
    expect(held!.statusMessage).toContain('Own CLI');
    noDetectOrApply();

    await db.delete(schema.taskSteps).where(eq(schema.taskSteps.taskId, taskId));
    h.adds.length = 0;
    await db
      .update(schema.tasks)
      .set({ ignoreSavedStepClis: true })
      .where(eq(schema.tasks.id, taskId));
    await tick();
    expect(phases.detect).toHaveBeenCalledTimes(1);
    expect((await rows())[0]!.waitingStartedAt).toBeNull();
    await expectNotHeld();
  });
});
