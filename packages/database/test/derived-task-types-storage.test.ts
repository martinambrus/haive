import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.DERIVED_TASK_TYPES_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/derived_task_types_test'))
  throw new Error('Use a dedicated derived_task_types_test database');

const enumMigration = readFileSync(
  new URL('../migrations/0240_derived_run_list_strategy.sql', import.meta.url),
  'utf8',
);
const columnMigration = readFileSync(
  new URL('../migrations/0241_derived_task_type_storage.sql', import.meta.url),
  'utf8',
);
const rollback = columnMigration
  .split('-- BEGIN MANUAL ROLLBACK\n')[1]!
  .split('-- END MANUAL ROLLBACK')[0]!
  .replace(/^-- ?/gm, '');

// Real SQL is necessary here: NULL truth, enum commit boundaries, FK actions and
// transactional rollback cannot be proved by the fake database. Public tables are never mutated.
describe.skipIf(!url)('derived task type storage on PostgreSQL', () => {
  let db: postgres.Sql;
  const namespace = `derived_storage_${randomBytes(6).toString('hex')}`;
  let before: unknown;
  let afterFirstApply: unknown;
  let catalogAfterFirstApply: unknown;

  const legacyRows = () => db`
    SELECT (to_jsonb(d) - 'base_slug' - 'changes')::text AS body
    FROM task_type_definitions d ORDER BY slug`;
  const catalog = () => db`
    SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid = 'task_type_definitions'::regclass ORDER BY conname`;

  beforeAll(async () => {
    db = postgres(url!, { max: 1, onnotice: () => {}, connect_timeout: 5 });
    await db`CREATE SCHEMA ${db(namespace)}`;
    await db`SET search_path TO ${db(namespace)}, public`;
    // Clone the real current tables, with their real column order and defaults, but no
    // data or foreign keys into public. Reconstruct the schema immediately before PR2.
    await db`CREATE TYPE run_list_strategy AS ENUM ('static', 'workflow_paths', 'run_app_modes')`;
    await db`CREATE TABLE task_type_definitions (LIKE public.task_type_definitions INCLUDING DEFAULTS)`;
    await db`ALTER TABLE task_type_definitions
      DROP COLUMN IF EXISTS base_slug, DROP COLUMN IF EXISTS changes,
      ADD PRIMARY KEY (slug)`;
    await db`ALTER TABLE task_type_definitions ALTER COLUMN run_list_strategy
      TYPE run_list_strategy USING run_list_strategy::text::run_list_strategy`;
    await db`CREATE TABLE tasks (LIKE public.tasks INCLUDING DEFAULTS)`;
    await db`ALTER TABLE tasks DROP COLUMN IF EXISTS derived_run_plan`;
    // Every current built-in slug, both dynamic strategies and static admin rows (including
    // raw prompt/default maps). Their old columns, including timestamps, must be byte-unchanged.
    await db`INSERT INTO task_type_definitions (slug, display_name, run_list_strategy, step_ids, source)
      SELECT name, name,
        (CASE name WHEN 'workflow' THEN 'workflow_paths' WHEN 'run_app' THEN 'run_app_modes'
          ELSE 'static' END)::run_list_strategy,
        CASE WHEN name IN ('workflow', 'run_app') THEN NULL
          WHEN name = 'type_draft' THEN '["01-type-draft"]'::jsonb ELSE '[]'::jsonb END,
        'builtin' FROM unnest(enum_range(NULL::workflow_type)::text[]) AS name`;
    await db`INSERT INTO task_type_definitions
      (slug, display_name, run_list_strategy, step_ids, source, pre_answer_defaults,
        step_loop_limit_defaults, prompt_steps)
      VALUES ('admin-static', 'Static admin', 'static', '["07-phase-2-implement"]', 'admin',
        '{"07-phase-2-implement":{"sample":true}}', '{"07-phase-2-implement":2}', '{}'),
      ('admin-prompt', 'Prompt admin', 'static', '["custom.admin-prompt.answer"]', 'admin',
        '{}', '{}', '{"answer":{"slug":"answer","title":"Answer","template":"Read the task"}}')`;
    before = [...(await legacyRows())];
    // Each file is its own committed transaction, exactly like the migration runner.
    await db.begin((tx) => tx.unsafe(enumMigration));
    await db.begin((tx) => tx.unsafe(columnMigration));
    afterFirstApply = [...(await legacyRows())];
    catalogAfterFirstApply = [...(await catalog())];
    // AHEAD: replay the files while every column, CHECK and FK already exists.
    await db.begin((tx) => tx.unsafe(enumMigration));
    await db.begin((tx) => tx.unsafe(columnMigration));
  });

  afterAll(async () => {
    if (!db) return;
    try {
      await db`SET search_path TO public`;
      await db`DROP SCHEMA IF EXISTS ${db(namespace)} CASCADE`;
    } finally {
      await db.end({ timeout: 5 });
    }
  });

  // Roll each example back so it neither changes the fixture nor depends on sibling examples.
  async function isolated(check: (tx: postgres.TransactionSql) => Promise<void>): Promise<void> {
    const undone = new Error('rollback test fixture');
    try {
      await db.begin(async (tx) => {
        await check(tx);
        throw undone;
      });
    } catch (error) {
      if (error !== undone) throw error;
    }
  }

  const insertDerived = (tx: postgres.TransactionSql) => tx`
    INSERT INTO task_type_definitions
      (slug, display_name, run_list_strategy, base_slug, changes, source)
    VALUES ('derived-example', 'Derived', 'derived', 'workflow', '[]', 'admin')`;

  it('applies twice without rewriting any existing built-in or static admin byte', async () => {
    expect(afterFirstApply).toEqual(before);
    expect([...(await legacyRows())]).toEqual(before);
    expect([...(await catalog())]).toEqual(catalogAfterFirstApply);
    const rows = await db`SELECT base_slug, changes FROM task_type_definitions`;
    expect(rows.length).toBeGreaterThan(2);
    for (const row of rows) expect(row).toEqual({ base_slug: null, changes: null });
  });

  it('accepts a valid derived row and leaves task plans nullable', () =>
    isolated(async (tx) => {
      await insertDerived(tx);
      const [row] = await tx`SELECT base_slug, changes, step_ids FROM task_type_definitions
      WHERE slug = 'derived-example'`;
      expect(row).toEqual({ base_slug: 'workflow', changes: [], step_ids: null });
      const [task] = await tx`INSERT INTO tasks (user_id, type, title)
      VALUES (${randomUUID()}, 'workflow', 'Old task') RETURNING derived_run_plan`;
      expect(task!.derived_run_plan).toBeNull();
    }));

  it.each([
    [
      'missing changes',
      "'workflow', NULL, NULL, 'admin'",
      'task_type_definitions_derived_shape_check',
    ],
    [
      'JSON null changes',
      "'workflow', 'null', NULL, 'admin'",
      'task_type_definitions_derived_shape_check',
    ],
    [
      'object changes',
      "'workflow', '{}', NULL, 'admin'",
      'task_type_definitions_derived_shape_check',
    ],
    ['missing base', "NULL, '[]', NULL, 'admin'", 'task_type_definitions_derived_shape_check'],
    [
      'static step IDs',
      "'workflow', '[]', '[]', 'admin'",
      'task_type_definitions_derived_shape_check',
    ],
    [
      'builtin source',
      "'workflow', '[]', NULL, 'builtin'",
      'task_type_definitions_derived_shape_check',
    ],
    [
      'self-reference',
      "'derived-example', '[]', NULL, 'admin'",
      'task_type_definitions_base_not_self_check',
    ],
  ])('refuses a derived row with %s', (_label, values, constraint) =>
    isolated(async (tx) => {
      await expect(
        tx.unsafe(`INSERT INTO task_type_definitions
      (slug, display_name, run_list_strategy, base_slug, changes, step_ids, source)
      VALUES ('derived-example', 'Derived', 'derived', ${values})`),
      ).rejects.toMatchObject({ code: '23514', constraint_name: constraint });
    }),
  );

  it.each([
    ["'workflow'", 'NULL'],
    ['NULL', "'[]'"],
  ])('refuses non-derived overlay fields (%s, %s)', (base, changes) =>
    isolated(async (tx) => {
      await expect(
        tx.unsafe(`INSERT INTO task_type_definitions
      (slug, display_name, run_list_strategy, step_ids, source, base_slug, changes)
      VALUES ('invalid-static', 'Static', 'static', '[]', 'admin', ${base}, ${changes})`),
      ).rejects.toMatchObject({
        code: '23514',
        constraint_name: 'task_type_definitions_non_derived_shape_check',
      });
    }),
  );

  it('refuses deletion of a referenced base', () =>
    isolated(async (tx) => {
      await insertDerived(tx);
      await expect(
        tx`DELETE FROM task_type_definitions WHERE slug = 'workflow'`,
      ).rejects.toMatchObject({ code: '23001' });
    }));

  it('refuses an absent base', () =>
    isolated(async (tx) => {
      await expect(tx`INSERT INTO task_type_definitions
      (slug, display_name, run_list_strategy, base_slug, changes, source)
      VALUES ('derived-example', 'Derived', 'derived', 'absent-base', '[]', 'admin')`).rejects.toMatchObject(
        { code: '23503' },
      );
    }));

  it.each([
    ['completed', false, false],
    ['cancelled', false, false],
    ['failed', true, false],
    ['completed', false, true],
  ])('manual rollback refuses a %s task (dead=%s, plan-only=%s)', (status, dead, planOnly) =>
    isolated(async (tx) => {
      await insertDerived(tx);
      await tx`INSERT INTO tasks (user_id, type, title, status, dead_at, derived_run_plan)
      VALUES (${randomUUID()}, ${planOnly ? 'workflow' : 'derived-example'}, 'Pinned task',
        ${status}::task_status, ${dead ? new Date() : null}, ${planOnly ? tx.json({ version: 1 }) : null})`;
      await expect(tx.savepoint((savepoint) => savepoint.unsafe(rollback))).rejects.toMatchObject({
        code: 'P0001',
      });
      expect(
        (await tx`SELECT base_slug FROM task_type_definitions WHERE slug = 'derived-example'`)[0]!
          .base_slug,
      ).toBe('workflow');
    }),
  );

  it('manual rollback removes unused derived storage and preserves every legacy row and task', () =>
    isolated(async (tx) => {
      await insertDerived(tx);
      await tx`INSERT INTO tasks (user_id, type, title, status)
      VALUES (${randomUUID()}, 'workflow', 'Legacy task', 'completed')`;
      const oldTasks = [
        ...(await tx`SELECT (to_jsonb(t) - 'derived_run_plan')::text AS body FROM tasks t`),
      ];
      await tx.unsafe(rollback);
      expect([
        ...(await tx`SELECT to_jsonb(d)::text AS body FROM task_type_definitions d ORDER BY slug`),
      ]).toEqual(before);
      expect([...(await tx`SELECT to_jsonb(t)::text AS body FROM tasks t`)]).toEqual(oldTasks);
      expect([
        ...(await tx`SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${namespace} AND column_name IN ('base_slug', 'changes', 'derived_run_plan')`),
      ]).toEqual([]);
      expect(
        (await tx`SELECT enum_range(NULL::run_list_strategy)::text AS labels`)[0]!.labels,
      ).toContain('derived');
    }));
});
