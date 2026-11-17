import { readFile } from 'node:fs/promises';
import { waitForPgLock } from './fixtures/wait-for-pg-lock.js';
import { eq, inArray, like, sql } from 'drizzle-orm';
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

  it.each([
    ['disabled', { enabled: false }, 403, 'is disabled', undefined],
    ['active contract', {}, 409, 'invalid-execution-contract', 'invalid-execution-contract'],
  ] as const)(
    'keeps %s admission priority with an unsupported contract',
    async (_name, over, status, message, code) => {
      await expect(
        db.transaction(async (tx) => {
          await tx.delete(schema.stepCatalog);
          await tx.insert(schema.stepCatalog).values(STEPS.map((id) => catalogRow(id)));
          await tx.insert(schema.taskTypeDefinitions).values(
            row('ttd-contract-priority', {
              executionContract: {
                version: 1,
                guardedSpans: [],
                fixTarget: { stepId: STEPS[0], capabilityVersion: 1 },
              },
              ...over,
            }),
          );
          const error = await refusal(
            definitionForCreate(tx, 'ttd-contract-priority', { generic: true, locked: true }),
          );
          expect(error.status).toBe(status);
          expect(error.message).toContain(message);
          if (code !== undefined) expect(error.code).toBe(code);
          throw new Error('rollback-priority-control');
        }),
      ).rejects.toThrow('rollback-priority-control');
    },
  );

  it('copies the step list of a static type', async () => {
    expect(
      await definitionForCreate(db, 'ttd-static', { locked: false, generic: true }),
    ).toMatchObject({
      runListSnapshot: STEPS,
    });
  });

  it('pins nothing for a dynamic type', async () => {
    expect(
      await definitionForCreate(db, 'ttd-dynamic', { locked: false, generic: true }),
    ).toMatchObject({
      runListSnapshot: null,
    });
  });

  it('refuses an unseeded built-in on the generic route unless it is a generic type', async () => {
    const err = await refusal(
      definitionForCreate(db, 'plan_merge', { locked: false, generic: true }),
    );
    expect([err.status, err.message]).toEqual([403, 'Task type plan_merge cannot be created here']);
    await expect(
      definitionForCreate(db, 'onboarding', { locked: false, generic: true }),
    ).resolves.toMatchObject({
      runListSnapshot: null,
    });
  });

  it('lets a built-in type through with no snapshot before the worker has seeded it', async () => {
    await expect(
      definitionForCreate(db, 'plan_merge', { locked: false, generic: false }),
    ).resolves.toMatchObject({
      runListSnapshot: null,
    });
  });

  it('is a 404 for an unknown type', async () => {
    const err = await refusal(
      definitionForCreate(db, 'ttd-missing', { locked: false, generic: false }),
    );
    expect([err.status, err.message]).toEqual([404, 'Unknown task type ttd-missing']);
  });

  it('is a 403 for a disabled type, generic or not', async () => {
    for (const generic of [true, false]) {
      const err = await refusal(
        definitionForCreate(db, 'ttd-disabled', { locked: false, generic }),
      );
      expect([err.status, err.message]).toEqual([403, 'Task type ttd-disabled is disabled']);
    }
  });

  it('refuses a type that is not selectable only on the generic path', async () => {
    const err = await refusal(
      definitionForCreate(db, 'ttd-hidden', { locked: false, generic: true }),
    );
    expect([err.status, err.message]).toEqual([403, 'Task type ttd-hidden cannot be created here']);
    expect(
      await definitionForCreate(db, 'ttd-hidden', { locked: false, generic: false }),
    ).toMatchObject({
      runListSnapshot: STEPS,
    });
  });

  it('sees a row inserted earlier in the same transaction, which no other connection sees', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(schema.taskTypeDefinitions).values(row('ttd-in-tx'));
        expect(
          await definitionForCreate(tx, 'ttd-in-tx', { locked: true, generic: true }),
        ).toMatchObject({
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
    const err = await refusal(
      definitionForCreate(db, 'ttd-in-tx', { locked: false, generic: true }),
    );
    expect(err.status).toBe(404);
  });

  it.each(['admin', 'module:fx'])(
    'keeps an old-order stored %s type creatable after the repair',
    async (source) => {
      const slug = 'ttd-order-repair';
      const b = '07b-phase-4-validate';
      const c = '07c-ddev-reconcile';
      await db.delete(schema.stepCatalog);
      await db
        .insert(schema.stepCatalog)
        .values([
          catalogRow(QUIET),
          { ...catalogRow(b), entry: { ...catalogRow(b).entry!, provides: ['validation'] } },
          { ...catalogRow(c), entry: { ...catalogRow(c).entry!, precedes: ['validation'] } },
        ]);
      await db
        .insert(schema.taskTypeDefinitions)
        .values(row(slug, { source, stepIds: [b, QUIET, c] }));
      const migration = await readFile(
        new URL(
          '../../database/migrations/0226_task_type_reconcile_before_validate.sql',
          import.meta.url,
        ),
        'utf8',
      );
      try {
        await expect(
          definitionForCreate(db, slug, { locked: false, generic: true }),
        ).rejects.toMatchObject({
          status: 409,
        });
        await db.$client.unsafe(migration);
        await expect(
          definitionForCreate(db, slug, { locked: false, generic: true }),
        ).resolves.toMatchObject({
          runListSnapshot: [c, b, QUIET],
        });
        const once = await db.query.taskTypeDefinitions.findFirst({
          where: eq(schema.taskTypeDefinitions.slug, slug),
        });
        await db.$client.unsafe(migration);
        expect(
          await db.query.taskTypeDefinitions.findFirst({
            where: eq(schema.taskTypeDefinitions.slug, slug),
          }),
        ).toEqual(once);
      } finally {
        await db
          .delete(schema.taskTypeDefinitions)
          .where(eq(schema.taskTypeDefinitions.slug, slug));
        await db.delete(schema.stepCatalog);
      }
    },
  );

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
        definitionForCreate(db, traitSlug(tag, name), { locked: false, generic: true });

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
      const def = await definitionForCreate(db, 'ttd-t-ps-adm', { locked: false, generic: true });
      expect(def.customSteps).toEqual({ [id]: PROMPT });
      expect(def.runListSnapshot).toEqual([CANARY, QUIET, id]);
    });

    it('gives a module type none, whatever its row stores', async () => {
      const id = promptStepId('ttd-t-ps-mod', PROMPT.slug);
      const def = await definitionForCreate(db, 'ttd-t-ps-mod', { locked: false, generic: true });
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

// These controls use the real locked admission helper and INSERT transaction. No dev queues.
describe.skipIf(!url)('v3 per-consumer locked admission', () => {
  let db: Database;
  let userId: string;
  const slugs = ['prt3-static', 'prt3-module', 'prt3-limit'];
  const ids = ['04-phase-0b-pre-planning', '05-phase-0b5-spec-quality', '07-phase-2-implement'];
  beforeAll(async () => {
    db = createDatabase(url!);
    const [u] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'prt3@example.invalid',
        emailBlindIndex: 'prt3-v3-user',
        passwordHash: 'test',
        status: 'active',
      })
      .returning();
    userId = u!.id;
    await db.insert(schema.modules).values({
      moduleId: 'prt3',
      packageName: '@haive/module-prt3',
      name: 'PRT3',
      installedVersion: '1.0.0',
    });
    await db
      .insert(schema.stepCatalog)
      .values(ids.map((id) => catalogRow(id)))
      .onConflictDoNothing();
    await db
      .insert(schema.taskTypeDefinitions)
      .values([
        row(slugs[0]!, { source: 'admin', stepIds: ids }),
        row(slugs[1]!, { source: 'module:prt3', stepIds: ids }),
        row(slugs[2]!, { source: 'admin', stepIds: [] }),
      ]);
  });
  afterAll(async () => {
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
    await db
      .delete(schema.taskTypeDefinitions)
      .where(inArray(schema.taskTypeDefinitions.slug, slugs));
    await db.delete(schema.modules).where(eq(schema.modules.moduleId, 'prt3'));
    await db.delete(schema.stepCatalog).where(inArray(schema.stepCatalog.stepId, [...ids, CANARY]));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.$client.end({ timeout: 5 });
  });
  const insert = async (slug: string) =>
    db.transaction(async (tx) => {
      const admitted = await definitionForCreate(tx, slug, { generic: true, locked: true });
      const [task] = await tx
        .insert(schema.tasks)
        .values({
          userId,
          type: slug,
          title: 'v3',
          runListSnapshot: admitted.runListSnapshot,
          dataEdgePlan: admitted.dataEdgePlan,
        })
        .returning();
      return task!;
    });
  it('maps ambiguous builtin workflow catalog order to a coded 409', async () => {
    await expect(
      db.transaction(async (tx) => {
        // Keep the rest of the fixture catalog out of this two-row ambiguity.
        await tx.update(schema.stepCatalog).set({ workflowType: 'module.prt3' });
        await tx.insert(schema.stepCatalog).values([
          { ...catalogRow('prt3-tied-a'), stepIndex: 7 },
          { ...catalogRow('prt3-tied-b'), stepIndex: 7 },
        ]);
        await tx.insert(schema.taskTypeDefinitions).values(
          row('workflow', {
            source: 'builtin',
            runListStrategy: 'workflow_paths',
            stepIds: null,
          }),
        );
        await expect(
          definitionForCreate(tx, 'workflow', { generic: true, locked: true }),
        ).rejects.toMatchObject({ status: 409, code: 'catalog-order-invalid' });
        throw new Error('fixture rollback');
      }),
    ).rejects.toThrow('fixture rollback');
  });
  it('gives static admin and module-seed tasks the same exact immutable edges', async () => {
    const admin = await insert(slugs[0]!);
    const module = await insert(slugs[1]!);
    expect(admin.dataEdgePlan).toMatchObject({
      version: 3,
      candidates: [
        {
          bindings: {
            '1:draft': {
              producerIndex: 0,
              producerStepId: ids[0],
              contract: { id: 'haive.spec.draft', version: 1 },
            },
            '2:resolved': null,
          },
        },
      ],
    });
    expect(module.dataEdgePlan).toEqual(admin.dataEdgePlan);
  });
  it('pins check-result inputs at locked INSERT for admin and module-seeded tasks', async () => {
    const checks = [
      '07b-phase-4-validate',
      '08b-test-management',
      '08-phase-5-verify',
      '09-gate-2-verify-approval',
      '11-phase-8-learning',
    ];
    const checkSlugs = ['check-results-admin', 'check-results-module'];
    await db.insert(schema.stepCatalog).values(checks.map((id) => catalogRow(id)));
    await db
      .insert(schema.taskTypeDefinitions)
      .values(
        checkSlugs.map((slug, index) =>
          row(slug, { source: index === 0 ? 'admin' : 'module:prt3', stepIds: checks }),
        ),
      );
    try {
      const admin = await insert(checkSlugs[0]!);
      const module = await insert(checkSlugs[1]!);
      expect(module.dataEdgePlan).toEqual(admin.dataEdgePlan);
      expect(admin.dataEdgePlan).toMatchObject({
        version: 3,
        candidates: [
          {
            bindings: {
              '2:test-management': {
                producerStepId: checks[1],
                contract: { id: 'haive.test-management', version: 1 },
              },
              '3:validation': {
                producerStepId: checks[0],
                contract: { id: 'haive.validation', version: 1 },
              },
              '3:verify': {
                producerStepId: checks[2],
                contract: { id: 'haive.verify', version: 1 },
              },
              '3:test-management': {
                producerStepId: checks[1],
                contract: { id: 'haive.test-management', version: 1 },
              },
              '4:validation': { producerStepId: checks[0] },
              '4:verify': { producerStepId: checks[2] },
            },
          },
        ],
      });
      await db
        .update(schema.taskTypeDefinitions)
        .set({ stepIds: [checks[3]!] })
        .where(eq(schema.taskTypeDefinitions.slug, checkSlugs[0]!));
      expect(
        (await db.query.tasks.findFirst({ where: eq(schema.tasks.id, admin.id) }))?.dataEdgePlan,
      ).toEqual(admin.dataEdgePlan);
    } finally {
      await db.delete(schema.tasks).where(inArray(schema.tasks.type, checkSlugs));
      await db
        .delete(schema.taskTypeDefinitions)
        .where(inArray(schema.taskTypeDefinitions.slug, checkSlugs));
      await db.delete(schema.stepCatalog).where(inArray(schema.stepCatalog.stepId, checks));
    }
  });
  it('pins browser and QA edges at locked INSERT for admin and module seeds', async () => {
    const ids = [
      '08a-browser-verify',
      '08d-adversarial-qa',
      '08d2-adversarial-qa-review',
      '09-gate-2-verify-approval',
      '11-phase-8-learning',
    ];
    const names = ['browser-qa-admin', 'browser-qa-module'];
    await db.insert(schema.stepCatalog).values(ids.map((id) => catalogRow(id)));
    await db
      .insert(schema.taskTypeDefinitions)
      .values(
        names.map((slug, index) =>
          row(slug, { source: index === 0 ? 'admin' : 'module:prt3', stepIds: ids }),
        ),
      );
    try {
      const admin = await insert(names[0]!);
      const module = await insert(names[1]!);
      expect(module.dataEdgePlan).toEqual(admin.dataEdgePlan);
      expect(admin.dataEdgePlan).toMatchObject({
        version: 3,
        candidates: [
          {
            bindings: {
              '1:browser': {
                producerStepId: ids[0],
                contract: { id: 'haive.browser-verification', version: 1 },
              },
              '2:adversarial-qa': {
                producerStepId: ids[1],
                contract: { id: 'haive.adversarial-qa', version: 1 },
              },
              '3:browser': { producerStepId: ids[0] },
              '3:adversarial-qa': { producerStepId: ids[1] },
              '4:browser': { producerStepId: ids[0] },
              '4:adversarial-qa': { producerStepId: ids[1] },
            },
          },
        ],
      });
      await db
        .update(schema.taskTypeDefinitions)
        .set({ stepIds: [ids[3]!] })
        .where(eq(schema.taskTypeDefinitions.slug, names[0]!));
      expect(
        (await db.query.tasks.findFirst({ where: eq(schema.tasks.id, admin.id) }))?.dataEdgePlan,
      ).toEqual(admin.dataEdgePlan);
    } finally {
      await db.delete(schema.tasks).where(inArray(schema.tasks.type, names));
      await db
        .delete(schema.taskTypeDefinitions)
        .where(inArray(schema.taskTypeDefinitions.slug, names));
      await db.delete(schema.stepCatalog).where(inArray(schema.stepCatalog.stepId, ids));
    }
  });
  it('uses the definition and catalog at INSERT, not the preflight copy', async () => {
    const before = await definitionForCreate(db, slugs[0]!, { locked: false, generic: true });
    await db
      .update(schema.taskTypeDefinitions)
      .set({ stepIds: [ids[2]!] })
      .where(eq(schema.taskTypeDefinitions.slug, slugs[0]!));
    // A catalog edit also crosses the preflight/INSERT boundary: a new CLI means a canary.
    await db.insert(schema.stepCatalog).values(catalogRow(CANARY)).onConflictDoNothing();
    await db
      .update(schema.stepCatalog)
      .set({ dispatchesCli: true })
      .where(eq(schema.stepCatalog.stepId, ids[2]!));
    try {
      const task = await insert(slugs[0]!);
      expect(task.runListSnapshot).toEqual([CANARY, ids[2]]);
      expect(task.dataEdgePlan).not.toEqual(before.dataEdgePlan);
      expect(task.dataEdgePlan).toMatchObject({
        candidates: [
          {
            nodes: [{ id: CANARY }, { id: ids[2] }],
            bindings: { '1:draft': null, '1:checked': null, '1:resolved': null },
          },
        ],
      });
    } finally {
      await db
        .update(schema.stepCatalog)
        .set({ dispatchesCli: false })
        .where(eq(schema.stepCatalog.stepId, ids[2]!));
      await db
        .update(schema.taskTypeDefinitions)
        .set({ stepIds: ids })
        .where(eq(schema.taskTypeDefinitions.slug, slugs[0]!));
    }
  });
  it('holds module deactivation until the admitted task and its plan have committed', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const creating = db.transaction(async (tx) => {
      const admitted = await definitionForCreate(tx, slugs[1]!, { generic: true, locked: true });
      locked();
      await gate;
      await tx.insert(schema.tasks).values({
        userId,
        type: slugs[1]!,
        title: 'race',
        runListSnapshot: admitted.runListSnapshot,
        dataEdgePlan: admitted.dataEdgePlan,
      });
    });
    await acquired;
    const deactivating = db.transaction(async (tx) => {
      await tx
        .select()
        .from(schema.modules)
        .where(eq(schema.modules.moduleId, 'prt3'))
        .for('update');
      const tasks = await tx.select().from(schema.tasks).where(eq(schema.tasks.type, slugs[1]!));
      expect(tasks.some((t) => t.title === 'race' && t.dataEdgePlan != null)).toBe(true);
      await tx
        .update(schema.modules)
        .set({ deactivatedAt: new Date() })
        .where(eq(schema.modules.moduleId, 'prt3'));
    });
    try {
      const waiting = await waitForPgLock(async () => {
        const rows = await db.execute(
          sql`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND strpos(query,'modules')>0`,
        );
        return rows.length > 0;
      });
      expect(waiting).toBe(true);
    } finally {
      release();
      await creating;
      await deactivating;
    }
    await expect(insert(slugs[1]!)).rejects.toMatchObject({ status: 409 });
  });
  it('refuses over-limit admission before writes, with no task, event or queued work', async () => {
    const { MAX_DATA_EDGE_STEPS } = await import('@haive/shared/data-edge-plan');
    await db
      .update(schema.taskTypeDefinitions)
      .set({ stepIds: Array.from({ length: MAX_DATA_EDGE_STEPS + 1 }, (_, i) => `s-${i}`) })
      .where(eq(schema.taskTypeDefinitions.slug, slugs[2]!));
    const tasks = await db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(eq(schema.tasks.userId, userId));
    const events = await db.select({ id: schema.taskEvents.id }).from(schema.taskEvents);
    let enqueues = 0;
    await expect(
      insert(slugs[2]!).then(() => {
        enqueues++;
      }),
    ).rejects.toMatchObject({ status: 409, code: 'invalid-data-edge-plan' });
    expect(
      await db
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(eq(schema.tasks.userId, userId)),
    ).toEqual(tasks);
    expect(await db.select({ id: schema.taskEvents.id }).from(schema.taskEvents)).toEqual(events);
    expect(enqueues).toBe(0);
  });
});

// Real MVCC and lock interaction: a boot catalog writer must not block previews.
describe.skipIf(!url)('catalog locks belong to INSERT admission only', () => {
  let db: Database;
  const slugs = ['prt3-preview', 'prt3-preview-derived', 'workflow'];
  const ids = [
    '00-model-health-workflow',
    '00a-sync-base',
    '00-triage',
    '04-phase-0b-pre-planning',
    '05-phase-0b5-spec-quality',
  ];
  beforeAll(async () => {
    db = createDatabase(url!);
    await db.delete(schema.stepCatalog);
    await db.insert(schema.stepCatalog).values(
      ids.map((id, stepIndex) => ({
        ...catalogRow(id),
        stepIndex,
      })),
    );
    await db.insert(schema.taskTypeDefinitions).values([
      row(slugs[0]!, { source: 'admin', stepIds: ids }),
      row('workflow', { source: 'builtin', runListStrategy: 'workflow_paths', stepIds: null }),
      row(slugs[1]!, {
        source: 'admin',
        runListStrategy: 'derived',
        stepIds: null,
        baseSlug: 'workflow',
        changes: [],
      }),
    ]);
  });
  afterAll(async () => {
    await db
      .delete(schema.taskTypeDefinitions)
      .where(eq(schema.taskTypeDefinitions.slug, slugs[1]!));
    await db
      .delete(schema.taskTypeDefinitions)
      .where(inArray(schema.taskTypeDefinitions.slug, slugs));
    await db.delete(schema.stepCatalog);
    await db.$client.end({ timeout: 5 });
  });
  it.each(slugs)(
    'previews %s normally while another transaction holds catalog write locks',
    async (slug) => {
      const expected = await definitionForCreate(db, slug, { locked: false, generic: true });
      let acquired!: () => void;
      let release!: () => void;
      const locked = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const writer = db.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE ${schema.stepCatalog} IN ROW EXCLUSIVE MODE`);
        await tx
          .select()
          .from(schema.stepCatalog)
          .where(eq(schema.stepCatalog.stepId, ids[0]!))
          .for('update');
        acquired();
        await gate;
      });
      await locked;
      try {
        await expect(
          definitionForCreate(db, slug, { locked: false, generic: true, catalogLockTimeoutMs: 30 }),
        ).resolves.toEqual(expected);
      } finally {
        release();
        await writer;
      }
    },
  );
  it('still refuses a busy catalog on explicit INSERT admission', async () => {
    let acquired!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = db.transaction(async (tx) => {
      await tx.execute(sql`LOCK TABLE ${schema.stepCatalog} IN ROW EXCLUSIVE MODE`);
      acquired();
      await gate;
    });
    await locked;
    try {
      await expect(
        db.transaction((tx) =>
          definitionForCreate(tx, slugs[0]!, {
            generic: true,
            locked: true,
            catalogLockTimeoutMs: 30,
          }),
        ),
      ).rejects.toMatchObject({ status: 409, code: 'data-edge-catalog-busy' });
    } finally {
      release();
      await writer;
    }
  });
});
