import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { registerStepsOnce } from '../src/step-engine/boot.js';
import { stepRegistry } from '../src/step-engine/registry.js';
import { syncTaskTypeDefinitions } from '../src/step-engine/task-type-seed.js';

const url = process.env.TASK_TYPE_SEED_GUARD_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/task_type_seed_guard_test'))
  throw new Error('Use a dedicated task_type_seed_guard_test database for task type seed tests');

registerStepsOnce();

describe.skipIf(!url)('task type seed against an admin row on Postgres', () => {
  let db: Database;
  const slug = 'plan_merge';

  beforeAll(async () => {
    db = createDatabase(url as string);
  });

  afterAll(async () => {
    await db.delete(schema.taskTypeDefinitions);
    await db.$client.end({ timeout: 5 });
  });

  it('fails the boot rather than overwrite a custom row holding a built-in slug', async () => {
    await db.delete(schema.taskTypeDefinitions);
    await db.insert(schema.taskTypeDefinitions).values({
      slug,
      displayName: 'Mine',
      runListStrategy: 'static',
      stepIds: ['custom-only-step'],
      source: 'admin',
      selectable: true,
      requiresRepository: false,
    });

    await expect(syncTaskTypeDefinitions(db, stepRegistry, [])).rejects.toThrow(
      /slug plan_merge is held by a admin row/,
    );

    const [stored] = await db
      .select()
      .from(schema.taskTypeDefinitions)
      .where(eq(schema.taskTypeDefinitions.slug, slug));
    expect(stored).toMatchObject({
      source: 'admin',
      stepIds: ['custom-only-step'],
      contentHash: null,
      requiresRepository: false,
      displayName: 'Mine',
    });
  });

  it('fails the boot even when the foreign row has the same step list', async () => {
    await db.delete(schema.taskTypeDefinitions);
    await syncTaskTypeDefinitions(db, stepRegistry, []);
    await db
      .update(schema.taskTypeDefinitions)
      .set({ source: 'admin' })
      .where(eq(schema.taskTypeDefinitions.slug, 'workflow'));
    await expect(syncTaskTypeDefinitions(db, stepRegistry, [])).rejects.toThrow(
      /slug workflow is held by a admin row/,
    );
  });

  it('still refreshes a built-in row', async () => {
    await db.delete(schema.taskTypeDefinitions);
    await syncTaskTypeDefinitions(db, stepRegistry, []);
    await db
      .update(schema.taskTypeDefinitions)
      .set({ stepIds: ['stale'], contentHash: 'stale' })
      .where(eq(schema.taskTypeDefinitions.slug, slug));
    await syncTaskTypeDefinitions(db, stepRegistry, []);
    const [stored] = await db
      .select()
      .from(schema.taskTypeDefinitions)
      .where(eq(schema.taskTypeDefinitions.slug, slug));
    expect(stored?.stepIds).not.toEqual(['stale']);
    expect(stored?.source).toBe('builtin');
  });
});
