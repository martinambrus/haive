import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { logger } from '@haive/shared';
import { registerModuleSteps, type LoadedWorkerModule } from '../src/modules/loader.js';
import { registerStepsOnce } from '../src/step-engine/boot.js';
import { StepRegistry, stepRegistry } from '../src/step-engine/registry.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';
import { syncTaskTypeDefinitions } from '../src/step-engine/task-type-seed.js';

const url = process.env.MODULE_TASK_TYPE_SEED_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/module_task_type_seed_test'))
  throw new Error('Use a dedicated module_task_type_seed_test database for module task type seeds');

registerStepsOnce();

const seedOf = (over: Record<string, unknown> = {}) => {
  const stepIds = (over.stepIds as string[] | undefined) ?? ['module.fx.report'];
  return {
    slug: 'weekly',
    displayName: 'Weekly report',
    description: 'Builds the weekly report.',
    runListStrategy: 'static',
    stepIds,
    selectable: true,
    requiresRepository: false,
    preAnswerDefaults: { [stepIds[0]!]: { depth: 'brief' } },
    stepLoopLimitDefaults: { [stepIds[0]!]: 3 },
    sortOrder: 7,
    ...over,
  };
};

const LOCAL_STEPS = ['report', 'extra', 'plain'];
const STEP_WITHOUT_ENTRY = 'internal';

function moduleOf(taskTypes: unknown[] | undefined, id = 'fx'): LoadedWorkerModule {
  const steps = [...LOCAL_STEPS, STEP_WITHOUT_ENTRY].map(
    (local) =>
      ({ metadata: { id: local, workflowType: 'x', title: local } }) as unknown as StepDefinition,
  );
  const composableSteps = LOCAL_STEPS.map((local) => ({
    stepId: local,
    label: local,
    group: 'build',
    dispatchesCli: false,
    requires: [],
    provides: [],
    loopBudgetEditable: local !== 'plain',
  }));
  const [loaded] = registerModuleSteps(new StepRegistry(), [
    {
      packageName: `@haive/module-${id}`,
      manifest: {
        id,
        name: id,
        version: '1.0.0',
        schemaVersion: 1,
        composableSteps,
        ...(taskTypes ? { taskTypes } : {}),
      },
      steps,
    },
  ]);
  return loaded!;
}

const hashOf = (stepIds: string[]) =>
  createHash('sha256')
    .update(JSON.stringify({ strategy: 'static', stepIds }))
    .digest('hex');

describe.skipIf(!url)('module task type seeds on Postgres', () => {
  let db: Database;

  const all = () =>
    db.select().from(schema.taskTypeDefinitions).orderBy(schema.taskTypeDefinitions.slug);
  const one = async (slug: string) => {
    const [row] = await db
      .select()
      .from(schema.taskTypeDefinitions)
      .where(eq(schema.taskTypeDefinitions.slug, slug));
    return row;
  };
  const withoutTime = <T extends { updatedAt: Date }>(row: T | undefined) =>
    ({ ...row, updatedAt: null }) as Omit<T, 'updatedAt'> & { updatedAt: null };
  const bySource = async (source: string) => (await all()).filter((r) => r.source === source);
  const sync = (...loaded: LoadedWorkerModule[]) =>
    syncTaskTypeDefinitions(db, stepRegistry, loaded);

  beforeAll(async () => {
    db = createDatabase(url as string);
  });

  beforeEach(async () => {
    await db.delete(schema.taskTypeDefinitions);
    await sync();
  });

  afterAll(async () => {
    await db.delete(schema.taskTypeDefinitions);
    await db.$client.end({ timeout: 5 });
  });

  it('stores a seed as <module>__<local> with every field', async () => {
    await sync(moduleOf([seedOf()]));
    const row = await one('fx__weekly');
    expect(row).toMatchObject({
      slug: 'fx__weekly',
      source: 'module:fx',
      runListStrategy: 'static',
      stepIds: ['module.fx.report'],
      displayName: 'Weekly report',
      description: 'Builds the weekly report.',
      enabled: true,
      selectable: true,
      requiresRepository: false,
      sortOrder: 7,
      preAnswerDefaults: { 'module.fx.report': { depth: 'brief' } },
      stepLoopLimitDefaults: { 'module.fx.report': 3 },
      fixLoop: null,
      promptSteps: {},
      contentHash: hashOf(['module.fx.report']),
    });
    expect(await one('weekly')).toBeUndefined();
  });

  it('stores the defaults for what a seed leaves out', async () => {
    await sync(
      moduleOf([
        seedOf({
          description: undefined,
          preAnswerDefaults: undefined,
          stepLoopLimitDefaults: undefined,
          sortOrder: undefined,
        }),
      ]),
    );
    expect(await one('fx__weekly')).toMatchObject({
      description: null,
      preAnswerDefaults: {},
      stepLoopLimitDefaults: {},
      sortOrder: 0,
    });
  });

  it('a second sync changes nothing but updated_at', async () => {
    const fx = moduleOf([seedOf(), seedOf({ slug: 'daily' })]);
    await sync(fx);
    const before = new Map((await all()).map((r) => [r.slug, r]));
    expect(before.has('fx__weekly') && before.has('fx__daily')).toBe(true);
    await sync(fx);
    const after = await all();
    expect(after.length).toBe(before.size);
    for (const row of after) {
      expect(withoutTime(row), row.slug).toEqual(withoutTime(before.get(row.slug)));
    }
  });

  it('keeps an admin edit to enabled, display_name and sort_order across a re-sync', async () => {
    const fx = moduleOf([seedOf()]);
    await sync(fx);
    await db
      .update(schema.taskTypeDefinitions)
      .set({ enabled: false, displayName: 'My name', sortOrder: 99 })
      .where(eq(schema.taskTypeDefinitions.slug, 'fx__weekly'));
    await sync(fx);
    expect(await one('fx__weekly')).toMatchObject({
      enabled: false,
      displayName: 'My name',
      sortOrder: 99,
    });
  });

  it('applies a changed seed to the fields the registry owns and keeps the admin ones', async () => {
    await sync(moduleOf([seedOf()]));
    await db
      .update(schema.taskTypeDefinitions)
      .set({ enabled: false, displayName: 'My name', sortOrder: 99 })
      .where(eq(schema.taskTypeDefinitions.slug, 'fx__weekly'));
    const stepIds = ['module.fx.report', 'module.fx.extra'];
    await sync(
      moduleOf([
        seedOf({
          stepIds,
          description: 'Changed.',
          selectable: false,
          requiresRepository: true,
          preAnswerDefaults: {},
          stepLoopLimitDefaults: { 'module.fx.extra': 1 },
          displayName: 'Renamed in code',
          sortOrder: 1,
        }),
      ]),
    );
    expect(await one('fx__weekly')).toMatchObject({
      source: 'module:fx',
      runListStrategy: 'static',
      stepIds,
      contentHash: hashOf(stepIds),
      description: 'Changed.',
      selectable: false,
      requiresRepository: true,
      preAnswerDefaults: {},
      stepLoopLimitDefaults: { 'module.fx.extra': 1 },
      enabled: false,
      displayName: 'My name',
      sortOrder: 99,
    });
  });

  it('leaves the rows of a module that is not loaded byte-identical', async () => {
    const fx = moduleOf([seedOf(), seedOf({ slug: 'daily' })]);
    const gx = moduleOf([seedOf({ stepIds: ['module.gx.report'] })], 'gx');
    await sync(fx, gx);
    const before = await bySource('module:fx');
    expect(before.map((r) => r.slug).sort()).toEqual(['fx__daily', 'fx__weekly']);

    await sync();
    expect(await bySource('module:fx')).toEqual(before);

    await sync(gx);
    expect(await bySource('module:fx')).toEqual(before);
    expect(await one('gx__weekly')).toMatchObject({ source: 'module:gx', selectable: true });
  });

  describe('a seed the loaded module no longer declares', () => {
    it('is made not selectable and kept, and comes back when it is declared again', async () => {
      const weekly = seedOf();
      const daily = seedOf({ slug: 'daily', stepIds: ['module.fx.extra'] });
      await sync(moduleOf([weekly, daily]));
      await db
        .update(schema.taskTypeDefinitions)
        .set({ enabled: false, displayName: 'My name', sortOrder: 99 })
        .where(eq(schema.taskTypeDefinitions.slug, 'fx__daily'));
      const keptWeekly = await one('fx__weekly');
      const before = await one('fx__daily');

      await sync(moduleOf([weekly]));
      expect(withoutTime(await one('fx__daily'))).toEqual({
        ...withoutTime(before),
        selectable: false,
      });
      expect(withoutTime(await one('fx__weekly'))).toEqual(withoutTime(keptWeekly));

      await sync(moduleOf([weekly, daily]));
      expect(await one('fx__daily')).toMatchObject({
        selectable: true,
        enabled: false,
        displayName: 'My name',
        sortOrder: 99,
      });
    });

    it('covers every row of a module that now declares no task type at all', async () => {
      await sync(moduleOf([seedOf(), seedOf({ slug: 'daily' })]));
      await sync(moduleOf(undefined));
      const rows = await bySource('module:fx');
      expect(rows.map((r) => [r.slug, r.selectable]).sort()).toEqual([
        ['fx__daily', false],
        ['fx__weekly', false],
      ]);
    });

    it("does not touch another module's rows, a built-in or an admin row", async () => {
      await db.insert(schema.taskTypeDefinitions).values({
        slug: 'custom-x',
        displayName: 'Custom',
        runListStrategy: 'static',
        stepIds: ['a'],
        source: 'admin',
      });
      const gx = moduleOf([seedOf({ stepIds: ['module.gx.report'] })], 'gx');
      await sync(moduleOf([seedOf()]), gx);
      const others = async () =>
        (await all()).filter((r) => r.source !== 'module:fx').map((r) => withoutTime(r));
      const before = await others();
      expect(before.some((r) => r.slug === 'gx__weekly')).toBe(true);

      await sync(moduleOf(undefined), gx);
      expect(await others()).toEqual(before);
    });
  });

  describe('a slug another row already holds', () => {
    it.each(['admin', 'builtin', 'module:other'])(
      'is left alone and reported when a %s row holds it, and the boot goes on',
      async (holder) => {
        await db.insert(schema.taskTypeDefinitions).values({
          slug: 'fx__weekly',
          displayName: 'Held',
          runListStrategy: 'static',
          stepIds: ['held-step'],
          source: holder,
          selectable: false,
          requiresRepository: false,
          sortOrder: 5,
        });
        const before = await one('fx__weekly');
        const warn = vi.spyOn(logger, 'warn');

        const outcome = await sync(moduleOf([seedOf(), seedOf({ slug: 'daily' })]));

        expect(await one('fx__weekly')).toEqual(before);
        expect(outcome).toEqual({
          fx: { seeded: ['fx__daily'], conflicts: [{ slug: 'fx__weekly', heldBy: holder }] },
        });
        expect(await one('fx__daily')).toMatchObject({ source: 'module:fx' });
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ module: 'fx', slug: 'fx__weekly', heldBy: holder }),
          expect.any(String),
        );
        warn.mockRestore();
      },
    );

    it('reports a held slug again at the next boot and never takes it over', async () => {
      await db.insert(schema.taskTypeDefinitions).values({
        slug: 'fx__weekly',
        displayName: 'Held',
        runListStrategy: 'static',
        stepIds: ['held-step'],
        source: 'admin',
      });
      const fx = moduleOf([seedOf()]);
      await sync(fx);
      const outcome = await sync(fx);
      expect(outcome.fx!.conflicts).toEqual([{ slug: 'fx__weekly', heldBy: 'admin' }]);
      expect(await one('fx__weekly')).toMatchObject({ source: 'admin', stepIds: ['held-step'] });
    });
  });

  describe('a seed whose defaults fail the checks an admin type gets', () => {
    const wrong: [string, Record<string, unknown>, Record<string, unknown>][] = [
      [
        'a preset answer for a step it does not run',
        { preAnswerDefaults: { 'module.fx.extra': { depth: 'brief' } } },
        { kind: 'default-key-not-in-steps', field: 'preAnswerDefaults', stepId: 'module.fx.extra' },
      ],
      [
        'a loop limit for a step it does not run',
        { stepLoopLimitDefaults: { 'module.fx.extra': 2 } },
        {
          kind: 'default-key-not-in-steps',
          field: 'stepLoopLimitDefaults',
          stepId: 'module.fx.extra',
        },
      ],
      [
        'a loop limit on a module step whose loop budget is not editable',
        { stepIds: ['module.fx.plain'], stepLoopLimitDefaults: { 'module.fx.plain': 2 } },
        { kind: 'loop-limit-not-editable', stepId: 'module.fx.plain' },
      ],
      [
        'a loop limit on a core step whose loop budget is not editable',
        {
          stepIds: ['04-phase-0b-pre-planning'],
          stepLoopLimitDefaults: { '04-phase-0b-pre-planning': 2 },
        },
        { kind: 'loop-limit-not-editable', stepId: '04-phase-0b-pre-planning' },
      ],
    ];

    it.each(wrong)(
      'is not written but reported and warned about, and a valid seed beside it is written: %s',
      async (_what, over, issue) => {
        const warn = vi.spyOn(logger, 'warn');

        const outcome = await sync(
          moduleOf([seedOf({ slug: 'bad', ...over }), seedOf({ slug: 'good' })]),
        );

        expect(await one('fx__bad')).toBeUndefined();
        expect(await one('fx__good')).toMatchObject({ source: 'module:fx', selectable: true });
        expect(outcome).toEqual({
          fx: {
            seeded: ['fx__good'],
            conflicts: [],
            invalid: [{ slug: 'fx__bad', issues: [issue] }],
          },
        });
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ module: 'fx', slug: 'fx__bad', issues: [issue] }),
          expect.any(String),
        );
        warn.mockRestore();
      },
    );

    it('writes a seed whose loop limit sits on a core step whose loop budget is editable', async () => {
      const stepIds = ['01-worktree-setup', '07-phase-2-implement', '07b-phase-4-validate'];
      const outcome = await sync(
        moduleOf([
          seedOf({
            stepIds,
            requiresRepository: true,
            stepLoopLimitDefaults: { '07b-phase-4-validate': 2 },
          }),
        ]),
      );
      expect(outcome).toEqual({ fx: { seeded: ['fx__weekly'], conflicts: [] } });
      expect(await one('fx__weekly')).toMatchObject({
        stepIds,
        stepLoopLimitDefaults: { '07b-phase-4-validate': 2 },
      });
    });

    it('leaves a row already stored under that slug exactly as it is', async () => {
      await sync(moduleOf([seedOf()]));
      await db
        .update(schema.taskTypeDefinitions)
        .set({ enabled: false, displayName: 'My name', sortOrder: 99 })
        .where(eq(schema.taskTypeDefinitions.slug, 'fx__weekly'));
      const before = await one('fx__weekly');

      const outcome = await sync(
        moduleOf([
          seedOf({
            description: 'Changed.',
            preAnswerDefaults: { 'module.fx.extra': { depth: 'deep' } },
          }),
        ]),
      );

      expect(await one('fx__weekly')).toEqual(before);
      expect(outcome.fx!.seeded).toEqual([]);
      expect(outcome.fx!.invalid?.map((i) => i.slug)).toEqual(['fx__weekly']);
    });
  });

  describe('how the steps of a seed compose', () => {
    const noDefaults = { preAnswerDefaults: undefined, stepLoopLimitDefaults: undefined };
    const unmet = (stepId: string, needs: string) =>
      expect.objectContaining({ kind: 'unmet-need', index: 0, stepId, needs });
    const broken: [string, Record<string, unknown>, unknown][] = [
      [
        'a repository-less run of only the implement step, which needs the worktree',
        { stepIds: ['07-phase-2-implement'] },
        unmet('07-phase-2-implement', 'worktree'),
      ],
      [
        'a repository-less run that starts at the worktree step, which needs the repository',
        { stepIds: ['01-worktree-setup', '07-phase-2-implement'] },
        unmet('01-worktree-setup', 'repository'),
      ],
    ];

    it.each(broken)(
      'a run list that does not compose is not written but reported and warned about, and a valid seed beside it is written: %s',
      async (_what, over, issue) => {
        const warn = vi.spyOn(logger, 'warn');

        const outcome = await sync(
          moduleOf([seedOf({ slug: 'bad', ...noDefaults, ...over }), seedOf({ slug: 'good' })]),
        );

        expect(await one('fx__bad')).toBeUndefined();
        expect(await one('fx__good')).toMatchObject({ source: 'module:fx', selectable: true });
        expect(outcome).toEqual({
          fx: {
            seeded: ['fx__good'],
            conflicts: [],
            invalid: [{ slug: 'fx__bad', issues: [issue] }],
          },
        });
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ module: 'fx', slug: 'fx__bad', issues: [issue] }),
          expect.any(String),
        );
        warn.mockRestore();
      },
    );

    it('a run list that composes is written', async () => {
      const stepIds = ['04-phase-0b-pre-planning', '05-phase-0b5-spec-quality'];
      const outcome = await sync(moduleOf([seedOf({ stepIds, ...noDefaults })]));
      expect(outcome).toEqual({ fx: { seeded: ['fx__weekly'], conflicts: [] } });
      expect(await one('fx__weekly')).toMatchObject({ stepIds });
    });

    it('a run list with a step that has no composable entry is not checked', async () => {
      const stepIds = [`module.fx.${STEP_WITHOUT_ENTRY}`, '07-phase-2-implement'];
      const outcome = await sync(moduleOf([seedOf({ stepIds, ...noDefaults })]));
      expect(outcome).toEqual({ fx: { seeded: ['fx__weekly'], conflicts: [] } });
      expect(await one('fx__weekly')).toMatchObject({ stepIds });
    });
  });

  describe('what a module seeding changes outside its own rows', () => {
    it('leaves every built-in row as a plain sync wrote it', async () => {
      const before = await bySource('builtin');
      expect(before).toHaveLength(11);
      await sync(moduleOf([seedOf()]));
      expect(await one('fx__weekly')).toBeDefined();
      expect((await bySource('builtin')).map((r) => withoutTime(r))).toEqual(
        before.map((r) => withoutTime(r)),
      );
    });

    it('writes no module row, and changes nothing else, while no loaded module declares a task type', async () => {
      const before = await all();
      const outcome = await sync(moduleOf(undefined), moduleOf([], 'gx'));
      const after = await all();
      expect(after.map((r) => withoutTime(r))).toEqual(before.map((r) => withoutTime(r)));
      expect(after.filter((r) => r.source.startsWith('module:'))).toEqual([]);
      expect(outcome).toEqual({
        fx: { seeded: [], conflicts: [] },
        gx: { seeded: [], conflicts: [] },
      });
    });

    it('reports what each module seeded', async () => {
      const outcome = await sync(
        moduleOf([seedOf(), seedOf({ slug: 'daily' })]),
        moduleOf([seedOf({ stepIds: ['module.gx.report'] })], 'gx'),
      );
      expect(outcome).toEqual({
        fx: { seeded: ['fx__weekly', 'fx__daily'], conflicts: [] },
        gx: { seeded: ['gx__weekly'], conflicts: [] },
      });
    });
  });
});
