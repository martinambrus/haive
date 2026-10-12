import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { HttpError } from '../src/context.js';
import { definitionForCreate } from '../src/lib/task-type-definition.js';

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
    await db.$client.end({ timeout: 5 });
  });

  it('copies the step list of a static type', async () => {
    expect(await definitionForCreate(db, 'ttd-static', { generic: true })).toEqual({
      runListSnapshot: STEPS,
    });
  });

  it('pins nothing for a dynamic type', async () => {
    expect(await definitionForCreate(db, 'ttd-dynamic', { generic: true })).toEqual({
      runListSnapshot: null,
    });
  });

  it('refuses an unseeded built-in on the generic route unless it is a generic type', async () => {
    const err = await refusal(definitionForCreate(db, 'plan_merge', { generic: true }));
    expect([err.status, err.message]).toEqual([403, 'Task type plan_merge cannot be created here']);
    await expect(definitionForCreate(db, 'onboarding', { generic: true })).resolves.toEqual({
      runListSnapshot: null,
    });
  });

  it('lets a built-in type through with no snapshot before the worker has seeded it', async () => {
    await expect(definitionForCreate(db, 'plan_merge', { generic: false })).resolves.toEqual({
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
    expect(await definitionForCreate(db, 'ttd-hidden', { generic: false })).toEqual({
      runListSnapshot: STEPS,
    });
  });

  it('sees a row inserted earlier in the same transaction, which no other connection sees', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(schema.taskTypeDefinitions).values(row('ttd-in-tx'));
        expect(await definitionForCreate(tx, 'ttd-in-tx', { generic: true })).toEqual({
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
});
