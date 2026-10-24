import { readFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, schema, type Database } from '../src/index.js';

const url = process.env.GATE_WEDGE_HEAL_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/gate_wedge_heal_test'))
  throw new Error('Use a dedicated gate_wedge_heal_test database for the gate wedge heal tests');

const MIGRATION = new URL('../migrations/0210_heal_wedged_fix_loop_gate_rows.sql', import.meta.url);
const USER = '00000000-0000-4000-8000-0000000000b1';
const BLIND_INDEX = 'gate-wedge-heal-test-user';
const STEP = '08b-test-management';
const OLD = new Date('2020-01-02T03:04:05.000Z');

const GATE_SCHEMA = {
  title: 'Fix loop needs a decision',
  description: 'The checks still fail.',
  infoSections: [{ title: 'Latest diagnosis', body: 'tests failed', defaultOpen: true }],
  fields: [
    {
      type: 'radio',
      id: 'fixLoopAction',
      label: 'How would you like to proceed?',
      options: [
        { value: 'continue', label: 'Continue' },
        { value: 'accept', label: 'Accept' },
        { value: 'abort', label: 'Abort' },
      ],
      default: 'continue',
    },
    {
      type: 'textarea',
      id: 'fixLoopInstruction',
      label: 'Instructions',
      rows: 4,
      visibleWhen: { field: 'fixLoopAction', equals: 'continue' },
    },
  ],
  submitLabel: 'Apply decision',
};

type RowOver = Partial<typeof schema.taskSteps.$inferInsert>;
type StepStatus = (typeof schema.taskSteps.$inferSelect)['status'];

const ANSWERS = [
  { fixLoopAction: 'continue', fixLoopInstruction: 'x' },
  { fixLoopAction: 'accept' },
  { fixLoopAction: 'abort' },
];
const NOT_GATE_ANSWERS = [
  { note: 'keep' },
  { fixLoopAction: 3 },
  { fixLoopAction: null },
  { fixLoopAction: { a: 1 } },
];
const OTHER_STATUSES: StepStatus[] = ['waiting_form', 'done', 'failed', 'running', 'waiting_cli'];

describe.skipIf(!url)('heal of wedged fix-loop gate rows on Postgres', () => {
  let db: Database;

  const run = async () => {
    await db.$client.unsafe(await readFile(MIGRATION, 'utf8'));
  };

  const seed = async (over: RowOver = {}) => {
    const [task] = await db
      .insert(schema.tasks)
      .values({ userId: USER, type: 'workflow', title: 'gate-wedge-heal', status: 'running' })
      .returning({ id: schema.tasks.id });
    const [row] = await db
      .insert(schema.taskSteps)
      .values({
        taskId: task!.id,
        stepId: STEP,
        stepIndex: 8.5,
        runSeq: 5,
        round: 1,
        title: 'Test management',
        status: 'pending',
        formSchema: GATE_SCHEMA,
        formValues: ANSWERS[0],
        waitingStartedAt: null,
        updatedAt: OLD,
        ...over,
      })
      .returning({ id: schema.taskSteps.id });
    return row!.id;
  };

  const snapshot = async (id: string) => {
    const row = (await db.query.taskSteps.findFirst({ where: eq(schema.taskSteps.id, id) }))!;
    const [raw] = await db.$client.unsafe<{ sql_null: boolean }[]>(
      'SELECT form_values IS NULL AS sql_null FROM task_steps WHERE id = $1',
      [id],
    );
    return {
      status: row.status,
      formValues: row.formValues,
      formValuesIsSqlNull: raw!.sql_null,
      formSchema: row.formSchema,
      pauseFormOnRetry: row.pauseFormOnRetry,
      waitingStartedAt: row.waitingStartedAt,
      updatedAt: row.updatedAt,
    };
  };

  const expectHealed = async (id: string, formSchema: unknown = GATE_SCHEMA) => {
    const after = await snapshot(id);
    expect(after.formValuesIsSqlNull).toBe(true);
    expect(after.pauseFormOnRetry).toBe(true);
    expect(after.status).toBe('pending');
    expect(after.formSchema).toEqual(formSchema);
    expect(after.waitingStartedAt).toBeNull();
    expect(after.updatedAt).toEqual(OLD);
  };

  const expectUntouched = async (id: string, before: Awaited<ReturnType<typeof snapshot>>) => {
    expect(await snapshot(id)).toEqual(before);
  };

  beforeAll(async () => {
    db = createDatabase(url as string);
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, BLIND_INDEX));
    await db.insert(schema.users).values({
      id: USER,
      emailEncrypted: 'gate-wedge-heal-test@test.local',
      emailBlindIndex: BLIND_INDEX,
      passwordHash: 'not-real',
      role: 'user',
    });
  });

  beforeEach(async () => {
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, USER));
  });

  afterAll(async () => {
    await db.delete(schema.users).where(eq(schema.users.id, USER));
    await db.$client.end({ timeout: 5 });
  });

  it.each(ANSWERS)('heals a pending unparked row holding the answer %j', async (answer) => {
    const id = await seed({ formValues: answer });
    await run();
    await expectHealed(id);
  });

  it('heals a pending unparked row that already pauses on retry', async () => {
    const id = await seed({ pauseFormOnRetry: true });
    await run();
    await expectHealed(id);
  });

  it('heals a row whose schema a CLI switch had cleared', async () => {
    const id = await seed({ formSchema: null });
    await run();
    await expectHealed(id, null);
  });

  it('heals the wedged row of a second task as well as the first', async () => {
    const first = await seed();
    const second = await seed({ formValues: ANSWERS[2] });
    await run();
    await expectHealed(first);
    await expectHealed(second);
  });

  it.each(OTHER_STATUSES)('leaves a %s row holding a gate answer alone', async (status) => {
    const id = await seed({ status });
    const before = await snapshot(id);
    await run();
    await expectUntouched(id, before);
  });

  it('leaves a pending row that is parked (waiting_started_at set) alone', async () => {
    const id = await seed({ waitingStartedAt: new Date('2020-01-02T03:05:00.000Z') });
    const before = await snapshot(id);
    await run();
    await expectUntouched(id, before);
  });

  it.each(NOT_GATE_ANSWERS)(
    'leaves a pending unparked row holding the non-gate values %j alone',
    async (values) => {
      const id = await seed({ formValues: values });
      const before = await snapshot(id);
      await run();
      await expectUntouched(id, before);
    },
  );

  it.each([false, true])(
    'leaves a pending unparked row with SQL NULL values alone (pause flag %s)',
    async (flag) => {
      const id = await seed({ formValues: null, pauseFormOnRetry: flag });
      const before = await snapshot(id);
      expect(before.formValuesIsSqlNull).toBe(true);
      await run();
      await expectUntouched(id, before);
    },
  );

  it('changes nothing on a second run', async () => {
    const ids = [
      ...(await Promise.all(ANSWERS.map((formValues) => seed({ formValues })))),
      await seed({ pauseFormOnRetry: true }),
      ...(await Promise.all(OTHER_STATUSES.map((status) => seed({ status })))),
      await seed({ waitingStartedAt: new Date('2020-01-02T03:05:00.000Z') }),
      ...(await Promise.all(NOT_GATE_ANSWERS.map((formValues) => seed({ formValues })))),
      await seed({ formValues: null }),
      await seed({ formValues: null, pauseFormOnRetry: true }),
    ];
    await run();
    const afterFirst = await Promise.all(ids.map(snapshot));
    await run();
    expect(await Promise.all(ids.map(snapshot))).toEqual(afterFirst);
  });
});
