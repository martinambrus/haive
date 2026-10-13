import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import {
  CLI_DISPATCH_STEP_IDS,
  PROVIDER_SENSITIVE_STEP_IDS,
  SKIPPABLE_STEP_IDS,
  STEP_CLI_ROLES,
} from '@haive/shared';
import { bootStepEngine } from '../src/step-engine/boot.js';
import { CORE_COMPOSABLE_STEPS } from '../src/step-engine/composable-core.js';
import { stepRegistry } from '../src/step-engine/registry.js';
import { syncStepCatalog } from '../src/step-engine/step-catalog.js';

vi.mock('../src/redis.js', () => ({ getRedis: () => ({ set: async () => 'OK' }) }));

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
      const merges = stepRegistry.get(r.stepId as never)?.mergeResolve !== undefined;
      expect(r.dispatchesCli).toBe(CLI_DISPATCH_STEP_IDS.includes(r.stepId) || merges);
      expect(r.dispatchesStepCli).toBe(CLI_DISPATCH_STEP_IDS.includes(r.stepId));
      expect(r.stepIndex).toBe(stepRegistry.get(r.stepId as never)?.metadata.index);
      expect(r.cliRoles).toEqual(STEP_CLI_ROLES[r.stepId] ?? null);
    }
  });

  it('marks the curated core steps composable with their entry and no other core step', async () => {
    const list = await rows();
    const curated = new Map(CORE_COMPOSABLE_STEPS.map((e) => [e.stepId, e] as const));
    expect(curated.size).toBeGreaterThan(0);
    for (const r of list) {
      const entry = curated.get(r.stepId);
      expect(r.composable).toBe(entry !== undefined);
      expect(r.entry).toEqual(entry ?? null);
    }
    expect(list.filter((r) => r.composable)).toHaveLength(curated.size);
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

  it('rewrites composable and entry on core rows from the code-owned list', async () => {
    const curatedId = CORE_COMPOSABLE_STEPS[0]!.stepId;
    const otherId = stepRegistry
      .all()
      .map((d) => d.metadata.id)
      .find((id) => !CORE_COMPOSABLE_STEPS.some((e) => e.stepId === id))!;
    await db.execute(
      sql`UPDATE step_catalog SET composable = false, entry = NULL WHERE step_id = ${curatedId}`,
    );
    await db.execute(
      sql`UPDATE step_catalog SET composable = true, entry = '{"k":1}'::jsonb WHERE step_id = ${otherId}`,
    );
    await syncStepCatalog(db, stepRegistry);
    const after = byId(await rows());
    expect(after.get(curatedId)!.composable).toBe(true);
    expect(after.get(curatedId)!.entry).toEqual(CORE_COMPOSABLE_STEPS[0]);
    expect(after.get(otherId)!.composable).toBe(false);
    expect(after.get(otherId)!.entry).toBeNull();
  });
});
