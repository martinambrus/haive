import { randomBytes } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { configService, TASK_JOB_NAMES, type WorkflowType } from '@haive/shared';
import { handleResult, processTaskJob, resolveFixLoopGate } from '../src/queues/task-queue.js';
import { resolvePreferredCli } from '../src/step-engine/step-runner.js';
import { stepRegistry } from '../src/step-engine/registry.js';
import type { ResolvedTaskContext } from '../src/queues/run-list.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';
import {
  FIX_LOOP_TARGET_STEP_ID,
  recordFixLoopRequest,
} from '../src/step-engine/steps/workflow/_fix-loop.js';
import { fixRoundCliRole } from '../src/step-engine/steps/workflow/_fix-round-cli.js';

const h = vi.hoisted(() => ({ db: undefined as unknown, adds: [] as unknown[] }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/redis.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getBullRedis: () => ({}),
}));
vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Queue: class {
    async add(name: string, data: unknown) {
      h.adds.push({ name, data });
    }
  },
}));

const url = process.env.FIX_ROUND_CLI_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/fix_round_cli_test'))
  throw new Error('Use a dedicated fix_round_cli_test database');
const TYPE = 'nrc_fix_round_test';
const REVIEW = 'nrc-review';
const B = 'nrc-other-check';
type StepRow = typeof schema.taskSteps.$inferSelect;

describe.skipIf(!url)('next-round CLI transaction on Postgres', () => {
  let db: Database;
  let userId: string;
  let repositoryId: string;
  beforeAll(async () => {
    db = createDatabase(url!);
    h.db = db;
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'nrc@test.local',
        emailBlindIndex: randomBytes(16).toString('hex'),
        passwordHash: randomBytes(32).toString('hex'),
        status: 'active',
        role: 'user',
      })
      .returning();
    userId = user!.id;
    const [repository] = await db
      .insert(schema.repositories)
      .values({
        userId,
        name: 'round CLI fixture',
        source: 'local_path',
        localPath: '/tmp',
        storagePath: '/tmp',
        status: 'ready',
      })
      .returning();
    repositoryId = repository!.id;
    await db
      .insert(schema.taskTypeDefinitions)
      .values({ slug: TYPE, displayName: TYPE, source: 'test', runListStrategy: 'static' });
    for (const [index, id] of [FIX_LOOP_TARGET_STEP_ID, REVIEW, B].entries()) {
      stepRegistry.register({
        metadata: {
          id,
          workflowType: TYPE as WorkflowType,
          index,
          title: id,
          description: id,
          requiresCli: false,
        },
        async detect() {
          return {};
        },
        form() {
          return null;
        },
        async apply() {
          return {};
        },
      } satisfies StepDefinition);
    }
  });
  beforeEach(async () => {
    h.adds.length = 0;
    vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.delete(schema.taskTypeDefinitions).where(eq(schema.taskTypeDefinitions.slug, TYPE));
    await db.$client.end({ timeout: 5 });
  });
  const make = async (over: Partial<typeof schema.tasks.$inferInsert> = {}) => {
    const [made] = await db
      .insert(schema.tasks)
      .values({
        userId,
        type: TYPE,
        title: 'round CLI',
        repositoryId,
        metadata: { anchorRepositoryId: null },
        status: 'running',
        orchestrationEpoch: 3,
        currentStepId: REVIEW,
        currentRound: 0,
        runListSnapshot: [FIX_LOOP_TARGET_STEP_ID, REVIEW],
        ...over,
      })
      .returning();
    return made!.id;
  };
  const ctxFor = (
    taskId: string,
    snapshot: string[],
    over: Partial<ResolvedTaskContext> = {},
  ): ResolvedTaskContext => ({
    taskId,
    userId,
    workflowType: TYPE as WorkflowType,
    repoPath: '/tmp',
    workspacePath: '/tmp',
    cliProviderId: null,
    ignoreSavedStepClis: false,
    executionPath: null,
    metadata: null,
    orchestrationEpoch: 3,
    currentStepId: REVIEW,
    currentRound: 0,
    status: 'running',
    completedAt: null,
    runListStrategy: 'static',
    runListSnapshot: snapshot,
    fixLoop: null,
    ...over,
  });
  const stepRow = async (id: string) =>
    (await db.select().from(schema.taskSteps).where(eq(schema.taskSteps.id, id)))[0]!;
  const events = (id: string, eventType: string) =>
    db
      .select()
      .from(schema.taskEvents)
      .where(and(eq(schema.taskEvents.taskId, id), eq(schema.taskEvents.eventType, eventType)));
  const job = (name: string, data: object) =>
    ({
      name,
      data,
      timestamp: Date.now(),
      moveToDelayed: async () => undefined,
    }) as unknown as Parameters<typeof processTaskJob>[0];
  const LOOP = [FIX_LOOP_TARGET_STEP_ID, REVIEW];
  const parked = async (
    stepId: string,
    snapshot: string[],
    over: Partial<typeof schema.tasks.$inferInsert> = {},
  ) => {
    const id = await make({ currentStepId: stepId, runListSnapshot: snapshot, ...over });
    const [gate] = await db
      .insert(schema.taskSteps)
      .values({ taskId: id, stepId, stepIndex: 1, round: 0, title: stepId, status: 'waiting_form' })
      .returning();
    return { id, gate: gate! };
  };
  const expectParked = async (id: string, gate: StepRow) => {
    expect(await stepRow(gate.id)).toMatchObject({ status: 'waiting_form', endedAt: null });
    for (const event of ['fix_loop.accepted', 'fix_loop.continued', 'fix_loop.requested'])
      expect(await events(id, event)).toEqual([]);
    expect(h.adds).toEqual([]);
  };

  it.each(['cap', 'oscillation'])(
    'populates the %s gate from eligible CLI-consuming providers',
    async (kind) => {
      const target = stepRegistry.require(FIX_LOOP_TARGET_STEP_ID);
      stepRegistry.override({
        ...target,
        llm: { requiredCapabilities: ['tool_use'], buildPrompt: () => 'fix' },
      });
      const providers = await db
        .insert(schema.cliProviders)
        .values([
          { userId, name: 'codex', label: 'eligible' },
          { userId, name: 'claude-code', label: 'disabled', enabled: false },
          { userId, name: 'ollama', label: 'not configured' },
        ])
        .returning();
      try {
        const { id, gate } = await parked(REVIEW, LOOP, { maxFixRounds: kind === 'cap' ? 0 : 5 });
        if (kind === 'oscillation') {
          await recordFixLoopRequest(db, id, gate.id, {
            round: 1,
            sourceStepId: REVIEW,
            diagnosis: 'same defect',
          });
          await recordFixLoopRequest(db, id, gate.id, {
            round: 2,
            sourceStepId: B,
            diagnosis: 'other defect',
          });
        }
        await handleResult(db, ctxFor(id, LOOP), REVIEW, {
          status: 'loop_back',
          row: { ...gate, round: kind === 'cap' ? 0 : 2 },
          diagnosis: 'same defect',
          sourceStepId: REVIEW,
        });
        const form = (await stepRow(gate.id)).formSchema as {
          fields: { id: string; options?: { value: string }[] }[];
        };
        expect(
          form.fields.find((f) => f.id === 'fixRoundCliProviderId')?.options?.map((o) => o.value),
        ).toEqual(['same', providers[0]!.id]);
        expect(
          await events(id, kind === 'cap' ? 'fix_loop.escalated' : 'fix_loop.oscillation_detected'),
        ).toHaveLength(1);
      } finally {
        stepRegistry.override(target);
        await db.delete(schema.cliProviders).where(
          inArray(
            schema.cliProviders.id,
            providers.map((p) => p.id),
          ),
        );
      }
    },
  );

  it('saves the next-round CLI with the handoff, preserves both preference tables, and ignores redelivery', async () => {
    const target = stepRegistry.require(FIX_LOOP_TARGET_STEP_ID);
    stepRegistry.override({
      ...target,
      llm: { requiredCapabilities: ['tool_use', 'file_write'], buildPrompt: () => 'fix' },
    });
    const providers = await db
      .insert(schema.cliProviders)
      .values([
        { userId, name: 'claude-code', label: 'usual' },
        { userId, name: 'codex', label: 'next round' },
      ])
      .returning();
    const [usual, picked] = providers;
    const preferences = async () => ({
      step: await db
        .select()
        .from(schema.userStepCliPreferences)
        .where(eq(schema.userStepCliPreferences.userId, userId)),
      role: await db
        .select()
        .from(schema.userStepCliRolePreferences)
        .where(eq(schema.userStepCliRolePreferences.userId, userId)),
    });
    try {
      await db.insert(schema.userStepCliPreferences).values({
        userId,
        stepId: FIX_LOOP_TARGET_STEP_ID,
        cliProviderId: usual!.id,
        explicit: true,
      });
      await db.insert(schema.userStepCliRolePreferences).values({
        userId,
        stepId: FIX_LOOP_TARGET_STEP_ID,
        role: 'fixer',
        cliProviderId: usual!.id,
        explicit: true,
      });
      const before = await preferences();
      const { id, gate } = await parked(REVIEW, LOOP);
      await db.update(schema.taskSteps).set({ round: 1 }).where(eq(schema.taskSteps.id, gate.id));
      gate.round = 1;
      const c = ctxFor(id, LOOP, { currentStepId: REVIEW });
      await resolveFixLoopGate(db, c, gate, 'continue', 1, '', picked!.id);
      expect(
        await db
          .select()
          .from(schema.taskStepCliChoices)
          .where(eq(schema.taskStepCliChoices.taskId, id)),
      ).toMatchObject([
        { stepId: FIX_LOOP_TARGET_STEP_ID, role: fixRoundCliRole(2), cliProviderId: picked!.id },
      ]);
      const resolve = (taskId: string, round: number) =>
        resolvePreferredCli(
          db,
          userId,
          FIX_LOOP_TARGET_STEP_ID,
          null,
          providers,
          'default',
          taskId,
          false,
          round,
        );
      expect((await resolve(id, 2)).cliProviderId).toBe(picked!.id);
      expect((await resolve(id, 3)).cliProviderId).toBe(usual!.id);
      const other = await make();
      expect((await resolve(other, 2)).cliProviderId).toBe(usual!.id);
      expect(await preferences()).toEqual(before);
      // A lost acknowledgement re-delivers the gate answer after the pointer moved.
      await processTaskJob(
        job(TASK_JOB_NAMES.ADVANCE_STEP, {
          taskId: id,
          userId,
          stepId: REVIEW,
          round: 1,
          formValues: { fixLoopAction: 'continue', fixRoundCliProviderId: picked!.id },
        }),
      );
      expect(h.adds).toHaveLength(1);
      expect(await events(id, 'fix_loop.continued')).toHaveLength(1);
      expect(await preferences()).toEqual(before);
      // A person can re-answer a reoffered gate after a provider disappears or is disabled.
      for (const next of [usual!.id, 'same']) {
        await db
          .update(schema.taskSteps)
          .set({ status: 'waiting_form', endedAt: null })
          .where(eq(schema.taskSteps.id, gate.id));
        await db
          .update(schema.tasks)
          .set({
            status: 'waiting_user',
            currentStepId: REVIEW,
            currentRound: 1,
            orchestrationEpoch: 4,
          })
          .where(eq(schema.tasks.id, id));
        await resolveFixLoopGate(
          db,
          { ...c, orchestrationEpoch: 4 },
          gate,
          'continue',
          1,
          '',
          next,
        );
        const choices = await db
          .select()
          .from(schema.taskStepCliChoices)
          .where(eq(schema.taskStepCliChoices.taskId, id));
        expect(choices.map((v) => v.cliProviderId)).toEqual(next === 'same' ? [] : [usual!.id]);
        expect(await preferences()).toEqual(before);
      }
    } finally {
      stepRegistry.override(target);
      await db.delete(schema.cliProviders).where(
        inArray(
          schema.cliProviders.id,
          providers.map((p) => p.id),
        ),
      );
    }
  });

  it.each(['enabled', 'disabled', 'deleted'])(
    'a later step-card choice replaces an %s gate choice in the same round',
    async (state) => {
      const target = stepRegistry.require(FIX_LOOP_TARGET_STEP_ID);
      stepRegistry.override({
        ...target,
        llm: { requiredCapabilities: ['tool_use'], buildPrompt: () => 'fix' },
      });
      const providers = await db
        .insert(schema.cliProviders)
        .values([
          { userId, name: 'claude-code', label: 'card pick' },
          { userId, name: 'codex', label: 'gate pick' },
        ])
        .returning();
      const [card, picked] = providers;
      try {
        const { id, gate } = await parked(REVIEW, LOOP);
        await db.insert(schema.taskStepCliChoices).values({
          taskId: id,
          stepId: FIX_LOOP_TARGET_STEP_ID,
          role: 'default',
          cliProviderId: card!.id,
          updatedAt: new Date(0),
        });
        await resolveFixLoopGate(db, ctxFor(id, LOOP), gate, 'continue', 0, '', picked!.id);
        expect(
          (
            await resolvePreferredCli(
              db,
              userId,
              FIX_LOOP_TARGET_STEP_ID,
              null,
              providers,
              'default',
              id,
              false,
              1,
            )
          ).cliProviderId,
        ).toBe(picked!.id);
        if (state === 'disabled')
          await db
            .update(schema.cliProviders)
            .set({ enabled: false })
            .where(eq(schema.cliProviders.id, picked!.id));
        if (state === 'deleted')
          await db.delete(schema.cliProviders).where(eq(schema.cliProviders.id, picked!.id));
        // The step-card writer updates its default slot at the time of the new pick.
        await db
          .update(schema.taskStepCliChoices)
          .set({
            cliProviderId: card!.id,
            effortLevel: 'high',
            updatedAt: new Date(Date.now() + 1000),
          })
          .where(
            and(
              eq(schema.taskStepCliChoices.taskId, id),
              eq(schema.taskStepCliChoices.stepId, FIX_LOOP_TARGET_STEP_ID),
              eq(schema.taskStepCliChoices.role, 'default'),
            ),
          );
        expect(
          await resolvePreferredCli(
            db,
            userId,
            FIX_LOOP_TARGET_STEP_ID,
            null,
            providers,
            'default',
            id,
            false,
            1,
          ),
        ).toEqual({ cliProviderId: card!.id, effortLevel: 'high' });
      } finally {
        stepRegistry.override(target);
        await db.delete(schema.cliProviders).where(
          inArray(
            schema.cliProviders.id,
            providers.map((p) => p.id),
          ),
        );
      }
    },
  );

  it('rolls the next-round CLI back when Retry wins the task fence', async () => {
    const target = stepRegistry.require(FIX_LOOP_TARGET_STEP_ID);
    stepRegistry.override({
      ...target,
      llm: { requiredCapabilities: ['tool_use'], buildPrompt: () => 'fix' },
    });
    const [picked] = await db
      .insert(schema.cliProviders)
      .values({ userId, name: 'codex', label: 'next round' })
      .returning();
    try {
      const { id, gate } = await parked(REVIEW, LOOP, { orchestrationEpoch: 4 });
      await resolveFixLoopGate(
        db,
        ctxFor(id, LOOP, { currentStepId: REVIEW }),
        gate,
        'continue',
        1,
        '',
        picked!.id,
      );
      expect(
        await db
          .select()
          .from(schema.taskStepCliChoices)
          .where(eq(schema.taskStepCliChoices.taskId, id)),
      ).toEqual([]);
      await expectParked(id, gate);
    } finally {
      stepRegistry.override(target);
      await db.delete(schema.cliProviders).where(eq(schema.cliProviders.id, picked!.id));
    }
  });
});
