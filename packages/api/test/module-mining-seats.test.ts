import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('@haive/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared')>();
  return { ...actual, configService: { ...actual.configService, getBoolean: async () => true } };
});
vi.mock('../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (_c: unknown, next: () => unknown) => {
    await next();
  },
}));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: vi.fn() }) }));
vi.mock('../src/lib/sandbox-kill.js', () => ({
  killTaskSandboxes: vi.fn(async () => ({ killed: 0, killConfirmed: true })),
}));

import { Hono } from 'hono';
import { eq, isNull } from 'drizzle-orm';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { STEP_MINING_SEATS } from '@haive/shared';
import type { AppEnv } from '../src/context.js';
import { mountModules } from '../src/modules/loader.js';
import { stepRoutes } from '../src/routes/tasks/steps.js';
import { taskTypeRoutes } from '../src/routes/task-types.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import {
  buildUpcomingCliSteps,
  enrichStepsWithCliPreferences,
  resolveCurrentStepCliProviderIds,
} from '../src/routes/tasks/_helpers.js';
import { seedStepCatalog, staticStepFlags } from './step-flags-fixture.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-000000000001';
const DEFAULT = '00000000-0000-4000-8000-0000000000b1';
const SAVED = '00000000-0000-4000-8000-0000000000b2';
const PICKED = '00000000-0000-4000-8000-0000000000b3';
const STEP = 'module.fx.analyze';
const seats = [
  { id: 'security', label: 'Security' },
  { id: 'coherence', label: 'Coherence' },
];
const entry = (miningSeats: unknown = { analyze: seats }) => ({
  packageName: '@haive/module-fx',
  manifest: { id: 'fx', name: 'Fixture', version: '1', schemaVersion: 1, miningSeats },
});

async function setup() {
  const fake = createFakeDb({
    taskTypeDefinitions: schema.taskTypeDefinitions,
    modules: schema.modules,
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
    cliProviders: schema.cliProviders,
    taskStepCliChoices: schema.taskStepCliChoices,
    userStepCliPreferences: schema.userStepCliPreferences,
    userStepCliRolePreferences: schema.userStepCliRolePreferences,
    stepCatalog: schema.stepCatalog,
  });
  const db = fake.db as unknown as Parameters<typeof mountModules>[2]['db'];
  h.db = db;
  fake.insert(schema.modules, { moduleId: 'fx', deactivatedAt: null });
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    status: 'running',
    type: 'fx__scan',
    runListSnapshot: [STEP],
    orchestrationEpoch: 1,
  });
  for (const id of [DEFAULT, SAVED, PICKED])
    fake.insert(schema.cliProviders, { id, userId: USER, name: 'codex', enabled: true });
  seedStepCatalog(fake);
  // A fully synced worker catalog gives every step an index; otherwise the API
  // deliberately uses the core-only startup fallback.
  await db
    .update(schema.stepCatalog)
    .set({ stepIndex: 0 })
    .where(isNull(schema.stepCatalog.stepIndex));
  const flags = staticStepFlags();
  const moduleFlag = {
    ...flags.get('08c-code-review')!,
    stepId: STEP,
    title: 'Analyze',
    workflowType: 'module.fx',
    stepIndex: 999,
    cliRoles: null,
  };
  flags.set(STEP, moduleFlag);
  fake.insert(schema.stepCatalog, { ...moduleFlag, source: 'module:fx', composable: false });
  fake.insert(schema.userStepCliRolePreferences, {
    userId: USER,
    stepId: STEP,
    role: 'security',
    cliProviderId: SAVED,
    effortLevel: 'low',
    explicit: true,
  });
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', USER);
    await next();
  });
  app.route('/', stepRoutes);
  app.route('/task-types', taskTypeRoutes);
  app.onError(errorHandler);
  await mountModules(app, [entry()], { db });
  const card = async () =>
    (await enrichStepsWithCliPreferences(db, flags, USER, [{ stepId: STEP }], TASK))[0]!;
  const providers = async () =>
    (
      await resolveCurrentStepCliProviderIds(db, flags, USER, [
        { id: TASK, currentStepId: STEP, cliProviderId: DEFAULT, ignoreSavedStepClis: false },
      ])
    ).get(TASK);
  return { fake, db, flags, app, card, providers };
}

afterEach(async () => {
  await mountModules(new Hono<AppEnv>(), [], {
    db: h.db as Parameters<typeof mountModules>[2]['db'],
  });
});

describe('installed module mining seats in API task readers', () => {
  it('annotates cards and upcoming steps with the declared seats and saved preferences, without loop roles', async () => {
    const { db, flags, card, providers } = await setup();
    const expected = {
      miningSeats: seats,
      miningSeatProviders: { security: SAVED, coherence: null },
      miningSeatEfforts: { security: 'low', coherence: null },
    };
    expect(await card()).toMatchObject(expected);
    expect(await card()).not.toHaveProperty('cliRoles');
    expect(
      await buildUpcomingCliSteps(db, flags, USER, TASK, 'fx__scan', [], false, [STEP]),
    ).toMatchObject([{ stepId: STEP, ...expected }]);
    expect(await providers()).toEqual([DEFAULT, SAVED]);
  });
  it('returns module seats and saved seat choices from the New Task CLI endpoint', async () => {
    const { fake, app } = await setup();
    fake.insert(schema.taskTypeDefinitions, {
      slug: 'fx__scan',
      displayName: 'Scan',
      description: '',
      source: 'module:fx',
      enabled: true,
      selectable: true,
      runListStrategy: 'static',
      stepIds: [STEP],
      promptSteps: {},
      preAnswerDefaults: {},
      stepLoopLimitDefaults: {},
      requiresRepository: false,
    });
    const response = await app.request('/task-types/fx__scan/saved-step-clis');
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({
      steps: [
        {
          stepId: STEP,
          miningSeats: seats,
          miningSeatProviders: { security: SAVED, coherence: null },
        },
      ],
    });
  });
  it('persists a picked seat through the real choice route and remembers it only when requested', async () => {
    const { app, fake, card, providers } = await setup();
    const pick = (remember: boolean) =>
      app.request(`/${TASK}/steps/${STEP}/cli-provider`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cliProviderId: PICKED, role: 'security', remember }),
      });
    expect((await pick(false)).status).toBe(200);
    expect(fake.rows(schema.taskStepCliChoices)).toMatchObject([
      { stepId: STEP, role: 'security', cliProviderId: PICKED },
    ]);
    expect(fake.rows(schema.userStepCliRolePreferences)).toMatchObject([{ cliProviderId: SAVED }]);
    expect(await card()).toMatchObject({
      miningSeatProviders: { security: PICKED, coherence: null },
    });
    expect(await providers()).toEqual([DEFAULT, PICKED]);
    expect((await pick(true)).status).toBe(200);
    expect(fake.rows(schema.userStepCliRolePreferences)).toMatchObject([
      { role: 'security', cliProviderId: PICKED },
    ]);
  });
  it('hides deactivated and removed seats immediately, retains choices, and restores them on activation', async () => {
    const { db, fake, card, providers } = await setup();
    fake.insert(schema.taskStepCliChoices, {
      taskId: TASK,
      stepId: STEP,
      role: 'coherence',
      cliProviderId: PICKED,
    });
    const saved = structuredClone(fake.rows(schema.userStepCliRolePreferences));
    const chosen = structuredClone(fake.rows(schema.taskStepCliChoices));
    await db
      .update(schema.modules)
      .set({ deactivatedAt: new Date() })
      .where(eq(schema.modules.moduleId, 'fx'));
    expect(await card()).not.toHaveProperty('miningSeats');
    expect(await providers()).toEqual([DEFAULT]);
    await db
      .update(schema.modules)
      .set({ deactivatedAt: null })
      .where(eq(schema.modules.moduleId, 'fx'));
    expect(await card()).toMatchObject({
      miningSeats: seats,
      miningSeatProviders: { security: SAVED, coherence: PICKED },
    });
    await mountModules(new Hono<AppEnv>(), [], { db });
    expect(await card()).not.toHaveProperty('miningSeats');
    expect(await providers()).toEqual([DEFAULT]);
    expect(fake.rows(schema.userStepCliRolePreferences)).toEqual(saved);
    expect(fake.rows(schema.taskStepCliChoices)).toEqual(chosen);
  });
  it('leaves every core card byte-identical and never overrides a core step with a local name', async () => {
    const { db, flags } = await setup();
    const steps = Object.keys(STEP_MINING_SEATS).map((stepId) => ({ stepId }));
    await mountModules(new Hono<AppEnv>(), [], { db });
    const before = JSON.stringify(
      await enrichStepsWithCliPreferences(db, flags, USER, steps, TASK),
    );
    await mountModules(new Hono<AppEnv>(), [entry({ '08c-code-review': seats })], { db });
    expect(JSON.stringify(await enrichStepsWithCliPreferences(db, flags, USER, steps, TASK))).toBe(
      before,
    );
  });
  it.each(['module.fx.analyze', 'module.gx.analyze', 'custom.mine.analyze'])(
    'refuses a namespace claim at API load: %s',
    async (key) => {
      const { db } = await setup();
      await expect(
        mountModules(new Hono<AppEnv>(), [entry({ [key]: seats })], { db }),
      ).rejects.toThrow(/Invalid manifest.*miningSeats/);
    },
  );

  it.each([
    [false, [DEFAULT], ['implementer']],
    [true, [DEFAULT, SAVED], ['triage', 'implementer']],
  ] as const)(
    'lists the insight Triage seat only for a task that acts on insights automatically (auto %s)',
    async (auto, spend, cardSeats) => {
      const { fake, db, flags } = await setup();
      await db
        .update(schema.tasks)
        .set({ autoActOnInsights: auto })
        .where(eq(schema.tasks.id, TASK));
      fake.insert(schema.userStepCliRolePreferences, {
        userId: USER,
        stepId: '08e-insights-triage',
        role: 'triage',
        cliProviderId: SAVED,
        effortLevel: null,
        explicit: true,
      });
      const listing = await resolveCurrentStepCliProviderIds(db, flags, USER, [
        {
          id: TASK,
          currentStepId: '08e-insights-triage',
          cliProviderId: DEFAULT,
          ignoreSavedStepClis: false,
          autoActOnInsights: auto,
        },
      ]);
      expect(listing.get(TASK)).toEqual(spend);
      const [insight] = await enrichStepsWithCliPreferences(
        db,
        flags,
        USER,
        [{ stepId: '08e-insights-triage' }],
        TASK,
      );
      expect(insight?.miningSeats?.map((s) => s.id)).toEqual(cardSeats);
    },
  );
});
