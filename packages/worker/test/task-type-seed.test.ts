import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { registerStepsOnce } from '../src/step-engine/boot.js';
import { stepRegistry } from '../src/step-engine/registry.js';
import { builtinTaskTypeRows, syncTaskTypeDefinitions } from '../src/step-engine/task-type-seed.js';

const SLUGS = [
  'onboarding',
  'workflow',
  'env_replicate',
  'onboarding_upgrade',
  'kb_author',
  'run_app',
  'plan_build',
  'plan_chat',
  'advisory',
  'plan_sequence',
  'plan_merge',
  'type_draft',
];
const SELECTABLE = ['onboarding', 'workflow', 'onboarding_upgrade', 'run_app'];

registerStepsOnce();

describe('builtinTaskTypeRows', () => {
  const rows = builtinTaskTypeRows(stepRegistry);
  const bySlug = new Map(rows.map((r) => [r.slug, r]));

  it('has the 12 built-in types in enum order', () => {
    expect(rows.map((r) => r.slug)).toEqual(SLUGS);
    expect(rows.map((r) => r.sortOrder)).toEqual(SLUGS.map((_, i) => i));
    for (const r of rows) {
      expect(r.source).toBe('builtin');
      expect(r.displayName.length).toBeGreaterThan(0);
    }
  });

  it('picks the run list strategy per type', () => {
    expect(bySlug.get('workflow')?.runListStrategy).toBe('workflow_paths');
    expect(bySlug.get('run_app')?.runListStrategy).toBe('run_app_modes');
    for (const slug of SLUGS.filter((s) => s !== 'workflow' && s !== 'run_app')) {
      expect(bySlug.get(slug)?.runListStrategy).toBe('static');
    }
  });

  it('marks selectable and repository-optional types', () => {
    expect(rows.filter((r) => r.selectable).map((r) => r.slug)).toEqual(SELECTABLE);
    expect(rows.filter((r) => !r.requiresRepository).map((r) => r.slug)).toEqual([
      'kb_author',
      'type_draft',
    ]);
  });

  it('copies the registry list into static rows and nothing into dynamic ones', () => {
    for (const r of rows) {
      if (r.runListStrategy === 'static') {
        expect(r.stepIds).toEqual(stepRegistry.listByWorkflow(r.slug).map((d) => d.metadata.id));
      } else {
        expect(r.stepIds).toBeNull();
      }
    }
  });

  it('hashes the strategy and step ids, stably', () => {
    for (const r of rows) {
      const expected = createHash('sha256')
        .update(JSON.stringify({ strategy: r.runListStrategy, stepIds: r.stepIds }))
        .digest('hex');
      expect(r.contentHash).toBe(expected);
    }
    expect(builtinTaskTypeRows(stepRegistry)).toEqual(rows);
  });
});

const url = process.env.TASK_TYPE_SEED_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/task_type_seed_test'))
  throw new Error('Use a dedicated task_type_seed_test database for task type seed tests');

describe.skipIf(!url)('task type definitions sync on Postgres', () => {
  let db: Database;

  const dropCustom = () =>
    db.delete(schema.taskTypeDefinitions).where(eq(schema.taskTypeDefinitions.slug, 'custom-x'));

  beforeAll(async () => {
    db = createDatabase(url as string);
    await dropCustom();
    await syncTaskTypeDefinitions(db, stepRegistry, []);
  });

  afterAll(async () => {
    await dropCustom();
    await db.$client.end({ timeout: 5 });
  });

  const rows = () => db.select().from(schema.taskTypeDefinitions);
  const one = async (slug: string) => {
    const [row] = await db
      .select()
      .from(schema.taskTypeDefinitions)
      .where(eq(schema.taskTypeDefinitions.slug, slug));
    return row;
  };

  it('writes the 12 built-in rows', async () => {
    const list = (await rows()).filter((r) => r.source === 'builtin');
    expect(list.map((r) => r.slug).sort()).toEqual([...SLUGS].sort());
  });

  it('a second sync changes nothing, updated_at included', async () => {
    const before = new Map((await rows()).map((r) => [r.slug, r]));
    await syncTaskTypeDefinitions(db, stepRegistry, []);
    const after = await rows();
    expect(after.length).toBe(before.size);
    for (const row of after) {
      expect(row, row.slug).toEqual(before.get(row.slug));
    }
  });

  it('moves updated_at for a row it rewrites and for no other', async () => {
    const old = new Date('2020-01-01T00:00:00.000Z');
    await db.update(schema.taskTypeDefinitions).set({ updatedAt: old });
    await db
      .update(schema.taskTypeDefinitions)
      .set({ stepIds: ['tampered'], contentHash: 'bad' })
      .where(eq(schema.taskTypeDefinitions.slug, 'plan_chat'));
    await syncTaskTypeDefinitions(db, stepRegistry, []);
    for (const row of await rows()) {
      if (row.slug === 'plan_chat') expect(row.updatedAt.getTime()).toBeGreaterThan(old.getTime());
      else expect(row.updatedAt, row.slug).toEqual(old);
    }
  });

  it('keeps an admin edit to enabled and display_name', async () => {
    await db
      .update(schema.taskTypeDefinitions)
      .set({ enabled: false, displayName: 'X' })
      .where(eq(schema.taskTypeDefinitions.slug, 'advisory'));
    await syncTaskTypeDefinitions(db, stepRegistry, []);
    const row = await one('advisory');
    expect(row?.enabled).toBe(false);
    expect(row?.displayName).toBe('X');
  });

  it('restores a tampered step list on a built-in static row', async () => {
    const want = (await one('plan_chat'))?.stepIds;
    await db
      .update(schema.taskTypeDefinitions)
      .set({ stepIds: ['tampered'], contentHash: 'bad' })
      .where(eq(schema.taskTypeDefinitions.slug, 'plan_chat'));
    await syncTaskTypeDefinitions(db, stepRegistry, []);
    const row = await one('plan_chat');
    expect(row?.stepIds).toEqual(want);
    expect(row?.contentHash).not.toBe('bad');
  });

  it('leaves a non-built-in row alone', async () => {
    await db.insert(schema.taskTypeDefinitions).values({
      slug: 'custom-x',
      displayName: 'Custom',
      runListStrategy: 'static',
      stepIds: ['a'],
      source: 'admin',
    });
    const before = await one('custom-x');
    await syncTaskTypeDefinitions(db, stepRegistry, []);
    expect(await one('custom-x')).toEqual(before);
  });
});
