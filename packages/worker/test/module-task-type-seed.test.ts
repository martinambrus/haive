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

const seedOf = (over: Record<string, unknown> = {}) => ({
  slug: 'weekly',
  displayName: 'Weekly report',
  description: 'Builds the weekly report.',
  runListStrategy: 'static',
  stepIds: ['module.fx.report'],
  selectable: true,
  requiresRepository: false,
  preAnswerDefaults: { 'module.fx.report': { depth: 'brief' } },
  stepLoopLimitDefaults: { 'module.fx.report': 3 },
  sortOrder: 7,
  ...over,
});

function moduleOf(taskTypes: unknown[] | undefined, id = 'fx'): LoadedWorkerModule {
  const steps = ['report', 'extra'].map(
    (local) =>
      ({ metadata: { id: local, workflowType: 'x', title: local } }) as unknown as StepDefinition,
  );
  const [loaded] = registerModuleSteps(new StepRegistry(), [
    {
      packageName: `@haive/module-${id}`,
      manifest: {
        id,
        name: id,
        version: '1.0.0',
        schemaVersion: 1,
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
