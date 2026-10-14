import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import type { LoadedWorkerModule } from '../src/modules/loader.js';
import { syncModuleIntent } from '../src/modules/intent.js';

const url = process.env.MODULE_INTENT_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/module_intent_test'))
  throw new Error(
    'Use a dedicated module_intent_test database for module intent integration tests',
  );

function mod(id: string, extra: { version?: string; entitlementId?: string } = {}) {
  return {
    packageName: `@haive/module-${id}`,
    manifest: {
      id,
      name: `Module ${id}`,
      version: extra.version ?? '1.0.0',
      schemaVersion: 1,
      ...(extra.entitlementId ? { entitlementId: extra.entitlementId } : {}),
    },
    stepIds: [],
    composable: [],
  } as unknown as LoadedWorkerModule;
}

describe.skipIf(!url)('module intent sync on Postgres', () => {
  let db: Database;

  beforeAll(() => {
    db = createDatabase(url as string);
  });

  beforeEach(async () => {
    await db.delete(schema.modules);
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });

  const row = async (id: string) => {
    const [r] = await db.select().from(schema.modules).where(eq(schema.modules.moduleId, id));
    return r;
  };
  const pause = () => new Promise((r) => setTimeout(r, 15));

  it('inserts a row for a first load', async () => {
    await syncModuleIntent(db, [mod('alpha', { version: '2.1.0', entitlementId: 'ent-1' })]);
    const r = await row('alpha');
    expect(r).toMatchObject({
      moduleId: 'alpha',
      packageName: '@haive/module-alpha',
      name: 'Module alpha',
      source: 'local',
      installedVersion: '2.1.0',
      entitlementId: 'ent-1',
      missingAt: null,
    });
    expect(r!.firstLoadedAt).toEqual(r!.lastLoadedAt);
  });

  it('a second identical sync changes only last_loaded_at and updated_at', async () => {
    await syncModuleIntent(db, [mod('alpha')]);
    const before = await row('alpha');
    await pause();
    await syncModuleIntent(db, [mod('alpha')]);
    const after = await row('alpha');
    expect({ ...after, lastLoadedAt: null, updatedAt: null }).toEqual({
      ...before,
      lastLoadedAt: null,
      updatedAt: null,
    });
    expect(after!.lastLoadedAt.getTime()).toBeGreaterThan(before!.lastLoadedAt.getTime());
    expect(after!.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime());
  });

  it('refreshes name, package, version and entitlement from the manifest', async () => {
    await syncModuleIntent(db, [mod('alpha', { entitlementId: 'ent-1' })]);
    await syncModuleIntent(db, [mod('alpha', { version: '1.1.0' })]);
    expect(await row('alpha')).toMatchObject({ installedVersion: '1.1.0', entitlementId: null });
  });

  it('marks a dropped module missing and keeps its row, leaving the others loaded', async () => {
    await syncModuleIntent(db, [mod('alpha'), mod('beta')]);
    await syncModuleIntent(db, [mod('beta')]);
    const alpha = await row('alpha');
    expect(alpha).toMatchObject({ name: 'Module alpha', installedVersion: '1.0.0' });
    expect(alpha!.missingAt).toBeInstanceOf(Date);
    expect((await row('beta'))!.missingAt).toBeNull();
  });

  it('keeps the first missing_at on a later sync', async () => {
    await syncModuleIntent(db, [mod('alpha'), mod('beta')]);
    await syncModuleIntent(db, [mod('beta')]);
    const first = (await row('alpha'))!.missingAt;
    await pause();
    await syncModuleIntent(db, [mod('beta')]);
    expect((await row('alpha'))!.missingAt).toEqual(first);
  });

  it('clears missing_at when the module loads again', async () => {
    await syncModuleIntent(db, [mod('alpha')]);
    await syncModuleIntent(db, []);
    expect((await row('alpha'))!.missingAt).not.toBeNull();
    await syncModuleIntent(db, [mod('alpha')]);
    expect((await row('alpha'))!.missingAt).toBeNull();
  });

  it('never overwrites a source another writer set', async () => {
    await syncModuleIntent(db, [mod('alpha')]);
    await db
      .update(schema.modules)
      .set({ source: 'git' })
      .where(eq(schema.modules.moduleId, 'alpha'));
    await syncModuleIntent(db, [mod('alpha')]);
    expect((await row('alpha'))!.source).toBe('git');
  });

  describe('deactivated_at', () => {
    const OFF = new Date('2026-10-14T08:00:00.000Z');
    const deactivate = (id: string) =>
      db.update(schema.modules).set({ deactivatedAt: OFF }).where(eq(schema.modules.moduleId, id));

    it('is null for a module the first load records', async () => {
      await syncModuleIntent(db, [mod('alpha')]);
      expect((await row('alpha'))!.deactivatedAt).toBeNull();
    });

    it('is left alone by a later sync that loads the module again', async () => {
      await syncModuleIntent(db, [mod('alpha')]);
      await deactivate('alpha');
      await syncModuleIntent(db, [mod('alpha', { version: '1.1.0' })]);
      expect(await row('alpha')).toMatchObject({ installedVersion: '1.1.0', deactivatedAt: OFF });
    });

    it('survives a missing spell and the load that ends it', async () => {
      await syncModuleIntent(db, [mod('alpha'), mod('beta')]);
      await deactivate('alpha');
      await syncModuleIntent(db, [mod('beta')]);
      expect(await row('alpha')).toMatchObject({ deactivatedAt: OFF });
      expect((await row('alpha'))!.missingAt).toBeInstanceOf(Date);
      await syncModuleIntent(db, [mod('alpha'), mod('beta')]);
      expect(await row('alpha')).toMatchObject({ deactivatedAt: OFF, missingAt: null });
      expect((await row('beta'))!.deactivatedAt).toBeNull();
    });
  });

  it('marks every row missing when no module loaded', async () => {
    await syncModuleIntent(db, [mod('alpha'), mod('beta')]);
    await syncModuleIntent(db, []);
    const rows = await db.select().from(schema.modules);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.missingAt !== null)).toBe(true);
  });
});
