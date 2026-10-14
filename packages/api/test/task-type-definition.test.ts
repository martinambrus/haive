import { eq, inArray, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { promptStepId } from '@haive/shared/modularity';
import { HttpError } from '../src/context.js';
import { definitionForCreate, restoresDatabase } from '../src/lib/task-type-definition.js';

vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: { getBoolean: async () => true },
}));

const url = process.env.TASK_TYPE_DEF_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/task_type_def_test'))
  throw new Error('Use a dedicated task_type_def_test database for task type definition tests');

const STEPS = ['00-a', '01-b'];
const SLUGS = ['ttd-static', 'ttd-dynamic', 'ttd-disabled', 'ttd-hidden', 'ttd-in-tx'];

const row = (slug: string, over: Partial<typeof schema.taskTypeDefinitions.$inferInsert> = {}) => ({
  slug,
  displayName: slug,
  runListStrategy: 'static' as const,
  stepIds: STEPS,
  source: 'test',
  ...over,
});

const CANARY = '00-model-health-workflow';
const QUIET = 'ttd-quiet';
const AGENT = 'ttd-agent';
const SIMPLIFY = '07a-code-simplify';
const RESTORE = '01c1-restore-database';
const SAVE = '11g-save-database';
const PRE_ANSWERS = { [QUIET]: { answer: 'yes' } };
const LOOP_LIMITS = { [QUIET]: 2 };

const catalogRow = (
  stepId: string,
  dispatchesCli = false,
): typeof schema.stepCatalog.$inferInsert => ({
  stepId,
  source: 'core',
  title: stepId,
  workflowType: 'workflow',
  dispatchesCli,
  allowSkip: false,
  providerSensitive: false,
  composable: true,
  entry: { stepId, label: stepId, group: 'build', dispatchesCli, requires: [], provides: [] },
});

const TRAIT_ROWS: Record<string, Partial<typeof schema.taskTypeDefinitions.$inferInsert>> = {
  quiet: { stepIds: [QUIET] },
  agent: { stepIds: [QUIET, AGENT] },
  canary: { stepIds: [CANARY, AGENT] },
  defaults: {
    stepIds: [QUIET],
    preAnswerDefaults: PRE_ANSWERS,
    stepLoopLimitDefaults: LOOP_LIMITS,
  },
  simplify: { stepIds: [QUIET, SIMPLIFY] },
  restore: { stepIds: [RESTORE, QUIET] },
  save: { stepIds: [QUIET, SAVE] },
};
const SOURCES = [
  { tag: 'adm', source: 'admin', traits: true },
  { tag: 'mod', source: 'module:fx', traits: true },
  { tag: 'bi', source: 'builtin', traits: false },
];
const traitSlug = (tag: string, name: string) => `ttd-t-${tag}-${name}`;

async function refusal(promise: Promise<unknown>): Promise<HttpError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  return err as HttpError;
}

describe.skipIf(!url)('definitionForCreate on Postgres', () => {
  let db: Database;

  beforeAll(async () => {
    db = createDatabase(url as string);
    await db.delete(schema.modules).where(eq(schema.modules.moduleId, 'fx'));
    await db.insert(schema.modules).values({
      moduleId: 'fx',
      packageName: '@haive/module-fx',
      name: 'Fx',
      installedVersion: '1.0.0',
    });
    await db
      .delete(schema.taskTypeDefinitions)
      .where(inArray(schema.taskTypeDefinitions.slug, SLUGS));
    await db
      .insert(schema.taskTypeDefinitions)
      .values([
        row('ttd-static'),
        row('ttd-dynamic', { runListStrategy: 'workflow_paths', stepIds: null }),
        row('ttd-disabled', { enabled: false }),
        row('ttd-hidden', { selectable: false }),
      ]);
  });

  afterAll(async () => {
    await db
      .delete(schema.taskTypeDefinitions)
      .where(inArray(schema.taskTypeDefinitions.slug, SLUGS));
    await db.delete(schema.modules).where(eq(schema.modules.moduleId, 'fx'));
    await db.$client.end({ timeout: 5 });
  });

  it('copies the step list of a static type', async () => {
    expect(await definitionForCreate(db, 'ttd-static', { generic: true })).toMatchObject({
      runListSnapshot: STEPS,
    });
  });

  it('pins nothing for a dynamic type', async () => {
    expect(await definitionForCreate(db, 'ttd-dynamic', { generic: true })).toMatchObject({
      runListSnapshot: null,
    });
  });

  it('refuses an unseeded built-in on the generic route unless it is a generic type', async () => {
    const err = await refusal(definitionForCreate(db, 'plan_merge', { generic: true }));
    expect([err.status, err.message]).toEqual([403, 'Task type plan_merge cannot be created here']);
    await expect(definitionForCreate(db, 'onboarding', { generic: true })).resolves.toMatchObject({
      runListSnapshot: null,
    });
  });

  it('lets a built-in type through with no snapshot before the worker has seeded it', async () => {
    await expect(definitionForCreate(db, 'plan_merge', { generic: false })).resolves.toMatchObject({
      runListSnapshot: null,
    });
  });

  it('is a 404 for an unknown type', async () => {
    const err = await refusal(definitionForCreate(db, 'ttd-missing', { generic: false }));
    expect([err.status, err.message]).toEqual([404, 'Unknown task type ttd-missing']);
  });

  it('is a 403 for a disabled type, generic or not', async () => {
    for (const generic of [true, false]) {
      const err = await refusal(definitionForCreate(db, 'ttd-disabled', { generic }));
      expect([err.status, err.message]).toEqual([403, 'Task type ttd-disabled is disabled']);
    }
  });

  it('refuses a type that is not selectable only on the generic path', async () => {
    const err = await refusal(definitionForCreate(db, 'ttd-hidden', { generic: true }));
    expect([err.status, err.message]).toEqual([403, 'Task type ttd-hidden cannot be created here']);
    expect(await definitionForCreate(db, 'ttd-hidden', { generic: false })).toMatchObject({
      runListSnapshot: STEPS,
    });
  });

  it('sees a row inserted earlier in the same transaction, which no other connection sees', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(schema.taskTypeDefinitions).values(row('ttd-in-tx'));
        expect(await definitionForCreate(tx, 'ttd-in-tx', { generic: true })).toMatchObject({
          runListSnapshot: STEPS,
        });
        const outside = await db
          .select()
          .from(schema.taskTypeDefinitions)
          .where(eq(schema.taskTypeDefinitions.slug, 'ttd-in-tx'));
        expect(outside).toEqual([]);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    const err = await refusal(definitionForCreate(db, 'ttd-in-tx', { generic: true }));
    expect(err.status).toBe(404);
  });

  describe('create-time traits by source', () => {
    const clean = () =>
      db.delete(schema.taskTypeDefinitions).where(like(schema.taskTypeDefinitions.slug, 'ttd-t-%'));

    beforeAll(async () => {
      await clean();
      await db.delete(schema.stepCatalog);
      await db
        .insert(schema.stepCatalog)
        .values([
          catalogRow(CANARY, true),
          catalogRow(QUIET),
          catalogRow(AGENT, true),
          catalogRow(SIMPLIFY),
          catalogRow(RESTORE),
          catalogRow(SAVE),
        ]);
      await db
        .insert(schema.taskTypeDefinitions)
        .values(
          SOURCES.flatMap(({ tag, source }) =>
            Object.entries(TRAIT_ROWS).map(([name, over]) =>
              row(traitSlug(tag, name), { ...over, source }),
            ),
          ),
        );
    });

    afterAll(async () => {
      await clean();
      await db.delete(schema.stepCatalog);
    });

    describe.each(SOURCES)('$source row', ({ tag, traits }) => {
      const create = (name: string) =>
        definitionForCreate(db, traitSlug(tag, name), { generic: true });

      it('puts the model-health step first only when a step dispatches a CLI', async () => {
        expect((await create('agent')).runListSnapshot).toEqual(
          traits ? [CANARY, QUIET, AGENT] : [QUIET, AGENT],
        );
        expect((await create('quiet')).runListSnapshot).toEqual([QUIET]);
        expect((await create('canary')).runListSnapshot).toEqual([CANARY, AGENT]);
      });

      it('takes the pre-answers and loop limits of its row', async () => {
        const def = await create('defaults');
        expect([def.preAnswers, def.stepLoopLimits]).toEqual(
          traits ? [PRE_ANSWERS, LOOP_LIMITS] : [null, {}],
        );
        const quiet = await create('quiet');
        expect([quiet.preAnswers, quiet.stepLoopLimits]).toEqual([null, {}]);
      });

      it('forces simplifyCode on with the simplify step', async () => {
        expect((await create('simplify')).simplifyCode).toBe(traits);
        expect((await create('quiet')).simplifyCode).toBe(false);
      });

      it('pins the database by step presence and restores it only with the restore step', async () => {
        const database = async (name: string) => {
          const { pinsDatabase, restoresDatabase } = await create(name);
          return { pinsDatabase, restoresDatabase };
        };
        expect(await database('restore')).toEqual({
          pinsDatabase: traits,
          restoresDatabase: traits,
        });
        expect(await database('save')).toEqual({ pinsDatabase: traits, restoresDatabase: false });
        expect(await database('quiet')).toEqual({ pinsDatabase: false, restoresDatabase: false });
      });
    });
  });

  describe('prompt steps by source', () => {
    const PROMPT = {
      slug: 'review',
      title: 'Review step',
      template: 'Review {{task.title}}',
      capabilities: [] as string[],
      timeoutMs: 300_000,
    };
    const withPrompt = (slug: string, source: string) =>
      row(slug, {
        source,
        stepIds: [QUIET, promptStepId(slug, PROMPT.slug)],
        promptSteps: { [PROMPT.slug]: PROMPT },
      });
    const clean = () =>
      db.delete(schema.taskTypeDefinitions).where(like(schema.taskTypeDefinitions.slug, 'ttd-t-%'));

    beforeAll(async () => {
      await clean();
      await db.delete(schema.stepCatalog);
      await db
        .insert(schema.taskTypeDefinitions)
        .values([withPrompt('ttd-t-ps-adm', 'admin'), withPrompt('ttd-t-ps-mod', 'module:fx')]);
    });

    afterAll(clean);

    it('keeps them on an admin type, whose steps ask for the model-health step', async () => {
      const id = promptStepId('ttd-t-ps-adm', PROMPT.slug);
      const def = await definitionForCreate(db, 'ttd-t-ps-adm', { generic: true });
      expect(def.customSteps).toEqual({ [id]: { ...PROMPT, tools: [] } });
      expect(def.runListSnapshot).toEqual([CANARY, QUIET, id]);
    });

    it('gives a module type none, whatever its row stores', async () => {
      const id = promptStepId('ttd-t-ps-mod', PROMPT.slug);
      const def = await definitionForCreate(db, 'ttd-t-ps-mod', { generic: true });
      expect(def.customSteps).toBeNull();
      expect(def.runListSnapshot).toEqual([QUIET, id]);
    });
  });
});

describe('restoresDatabase', () => {
  const listing = (source: string, over: Partial<Parameters<typeof restoresDatabase>[0]> = {}) => ({
    source,
    runListStrategy: 'static',
    stepIds: [RESTORE],
    ...over,
  });

  it('holds for an admin or module type that lists the restore step', () => {
    expect(restoresDatabase(listing('admin'))).toBe(true);
    expect(restoresDatabase(listing('module:fx'))).toBe(true);
  });

  it('is false for a built-in, a dynamic run list, or a list without the step', () => {
    expect(restoresDatabase(listing('builtin'))).toBe(false);
    expect(
      restoresDatabase(listing('module:fx', { runListStrategy: 'workflow_paths', stepIds: null })),
    ).toBe(false);
    expect(restoresDatabase(listing('module:fx', { stepIds: [QUIET] }))).toBe(false);
  });
});
