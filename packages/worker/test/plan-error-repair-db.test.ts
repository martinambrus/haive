import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { eq, sql } from 'drizzle-orm';
import { DATA_MIGRATIONS } from '../src/data-migrations.js';

const url = process.env.PLAN_ERROR_REPAIR_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/t478_plan_error_test')) {
  throw new Error('Use a dedicated t478_plan_error_test database');
}

describe.skipIf(!url)('boot repair of stored plan error paths', () => {
  let db: Database;
  const userId = randomUUID();
  beforeAll(async () => {
    db = createDatabase(url!);
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'test',
      emailBlindIndex: userId,
      passwordHash: 'test',
    });
  });
  afterAll(async () => {
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.$client.end({ timeout: 5 });
  });
  it('scrubs only changed rows, preserves counters and timestamps, and converges', async () => {
    const before = new Date('2026-01-01T00:00:00.000Z');
    const reasons = [
      "EACCES: open '/srv/private/repo/plan.json'",
      'a merge or rebase is open',
      "git push failed: unable to access 'https://github.com/o/r.git/': 403",
      null,
    ];
    const ids: string[] = [];
    for (const lastError of reasons) {
      const [repo] = await db
        .insert(schema.repositories)
        .values({ userId, name: 'fixture', source: 'blank' })
        .returning();
      ids.push(repo!.id);
      await db.insert(schema.planMirrorState).values({
        repositoryId: repo!.id,
        revision: 7,
        writtenRevision: 4,
        lastError,
        updatedAt: before,
      });
    }
    const rows = async () =>
      db
        .select({
          id: schema.planMirrorState.repositoryId,
          error: schema.planMirrorState.lastError,
          revision: schema.planMirrorState.revision,
          written: schema.planMirrorState.writtenRevision,
          updated: schema.planMirrorState.updatedAt,
          xmin: sql<string>`xmin::text`,
        })
        .from(schema.planMirrorState)
        .orderBy(schema.planMirrorState.repositoryId);
    const original = await rows();
    const migrations = DATA_MIGRATIONS.filter((m) => m.id === 'scrubPlanMirrorErrors');
    // No repair on the old release: run the registered boot entries, then inspect real storage.
    for (const migration of migrations) await migration.run(db);
    const repaired = await rows();
    expect(repaired.find((r) => r.id === ids[0])?.error).toBe("EACCES: open '[path]'");
    expect(migrations).toHaveLength(1);
    expect(migrations[0]?.kind).toBe('convergent');
    for (const row of repaired) {
      expect(row).toMatchObject({ revision: 7, written: 4, updated: before });
      const prior = original.find((r) => r.id === row.id)!;
      if (row.id !== ids[0]) expect(row).toEqual(prior);
      else expect(row.xmin).not.toBe(prior.xmin);
    }
    for (const migration of migrations) await migration.run(db);
    expect(await rows()).toEqual(repaired);
  });
});
