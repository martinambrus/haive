import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import {
  CLI_DISPATCH_STEP_IDS,
  PROVIDER_SENSITIVE_STEP_IDS,
  SKIPPABLE_STEP_IDS,
  STEP_CLI_ROLES,
} from '@haive/shared';
import { bootStepEngine } from '../src/step-engine/boot.js';
import { stepRegistry } from '../src/step-engine/registry.js';
import { syncStepCatalog } from '../src/step-engine/step-catalog.js';

const url = process.env.STEP_CATALOG_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/step_catalog_test'))
  throw new Error('Use a dedicated step_catalog_test database for step catalog integration tests');

describe.skipIf(!url)('step catalog sync on Postgres', () => {
  let db: Database;

  beforeAll(async () => {
    db = createDatabase(url as string);
    await bootStepEngine(db);
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });

  const rows = () => db.select().from(schema.stepCatalog);
  const byId = (list: Awaited<ReturnType<typeof rows>>) => new Map(list.map((r) => [r.stepId, r]));

  it('mirrors the registry and the shared static lists', async () => {
    const list = await rows();
    const registryIds = stepRegistry.all().map((d) => d.metadata.id);
    expect(list.map((r) => r.stepId).sort()).toEqual([...registryIds].sort());
    for (const r of list) {
      expect(r.source).toBe('core');
      expect(r.allowSkip).toBe(SKIPPABLE_STEP_IDS.includes(r.stepId));
      expect(r.providerSensitive).toBe(PROVIDER_SENSITIVE_STEP_IDS.includes(r.stepId));
      expect(r.dispatchesCli).toBe(CLI_DISPATCH_STEP_IDS.includes(r.stepId));
      expect(r.cliRoles).toEqual(STEP_CLI_ROLES[r.stepId] ?? null);
      expect(r.composable).toBe(false);
      expect(r.entry).toBeNull();
    }
  });

  it('a second sync changes nothing but updated_at', async () => {
    const before = byId(await rows());
    await syncStepCatalog(db, stepRegistry);
    const after = byId(await rows());
    expect(after.size).toBe(before.size);
    for (const [id, row] of before) {
      const next = after.get(id);
      expect({ ...next, updatedAt: null }).toEqual({ ...row, updatedAt: null });
    }
  });

  it('deletes a row for a step that is no longer registered', async () => {
    await db.insert(schema.stepCatalog).values({
      stepId: 'zz-stale',
      source: 'core',
      title: 'Stale',
      workflowType: 'workflow',
      dispatchesCli: false,
      allowSkip: false,
      providerSensitive: false,
    });
    await syncStepCatalog(db, stepRegistry);
    expect((await rows()).some((r) => r.stepId === 'zz-stale')).toBe(false);
  });

  it('never writes composable or entry', async () => {
    const id = stepRegistry.all()[0]!.metadata.id;
    await db.execute(
      sql`UPDATE step_catalog SET composable = true, entry = '{"k":1}'::jsonb WHERE step_id = ${id}`,
    );
    await syncStepCatalog(db, stepRegistry);
    const row = byId(await rows()).get(id)!;
    expect(row.composable).toBe(true);
    expect(row.entry).toEqual({ k: 1 });
    await db.execute(
      sql`UPDATE step_catalog SET composable = false, entry = NULL WHERE step_id = ${id}`,
    );
  });
});
