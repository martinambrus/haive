import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@haive/shared/logger';
import { createDatabase, schema, type Database } from '@haive/database';
import { eq, sql } from 'drizzle-orm';
import { DATA_MIGRATIONS } from '../src/data-migrations.js';

const url = process.env.PLAN_ERROR_REPAIR_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/plan_error_repair_test')) {
  throw new Error('Use a dedicated plan_error_repair_test database');
}

describe.skipIf(!url)('boot repair of stored plan error paths', () => {
  let db: Database;
  const userId = randomUUID();
  const lines: string[] = [];
  beforeEach(() => {
    lines.length = 0;
    const key = Object.getOwnPropertySymbols(logger).find(
      (key) => key.description === 'pino.stream',
    )!;
    const stream = (logger as unknown as Record<symbol, { write: (line: string) => void }>)[key]!;
    vi.spyOn(stream, 'write').mockImplementation((line) => {
      lines.push(line);
    });
  });
  afterEach(() => vi.restoreAllMocks());
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
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        level: 30,
        count: 1,
        ids: [ids[0]],
      }),
    );
    expect(migrations[0]?.kind).toBe('convergent');
    for (const row of repaired) {
      expect(row).toMatchObject({ revision: 7, written: 4, updated: before });
      const prior = original.find((r) => r.id === row.id)!;
      if (row.id !== ids[0]) expect(row).toEqual(prior);
      else expect(row.xmin).not.toBe(prior.xmin);
    }
    lines.length = 0;
    for (const migration of migrations) await migration.run(db);
    expect(await rows()).toEqual(repaired);
    expect(lines).toEqual([]);
  });

  it.each(["ENOENT: open '/srv/newer/repo/plan.json'", null])(
    'leaves a newer error or successful clear alone after the read: %s',
    async (newer) => {
      const [repo] = await db
        .insert(schema.repositories)
        .values({
          userId,
          name: 'racing fixture',
          source: 'blank',
        })
        .returning({ id: schema.repositories.id });
      await db.insert(schema.planMirrorState).values({
        repositoryId: repo!.id,
        lastError: "EACCES: open '/srv/private/repo/plan.json'",
      });
      // Execute the actual SELECT, then change its text before the repair's UPDATE.
      const racingDb = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop !== 'select') return Reflect.get(target, prop, receiver);
          return (fields: Parameters<Database['select']>[0]) => ({
            from: (table: typeof schema.planMirrorState) => ({
              where: async (condition: ReturnType<typeof eq>) => {
                const selected = await target.select(fields).from(table).where(condition);
                await db
                  .update(schema.planMirrorState)
                  .set({ lastError: newer })
                  .where(eq(schema.planMirrorState.repositoryId, repo!.id));
                return selected;
              },
            }),
          });
        },
      });
      const migrations = DATA_MIGRATIONS.filter((m) => m.id === 'scrubPlanMirrorErrors');
      for (const migration of migrations) await migration.run(racingDb);
      expect(migrations).toHaveLength(1);
      const [row] = await db
        .select()
        .from(schema.planMirrorState)
        .where(eq(schema.planMirrorState.repositoryId, repo!.id));
      expect(row?.lastError).toBe(newer);
      expect(lines).toEqual([]);
      await db.delete(schema.repositories).where(eq(schema.repositories.id, repo!.id));
    },
  );
});
