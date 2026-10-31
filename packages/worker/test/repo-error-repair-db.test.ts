import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { logger } from '@haive/shared/logger';
import { eq, sql } from 'drizzle-orm';
import { DATA_MIGRATIONS } from '../src/data-migrations.js';

const url = process.env.REPO_ERROR_REPAIR_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/repo_error_repair_test')) {
  throw new Error('Use a dedicated repo_error_repair_test database');
}

describe.skipIf(!url)('boot repair of stored repository failure paths', () => {
  let db: Database;
  const userId = randomUUID();
  const lines: string[] = [];
  beforeAll(async () => {
    db = createDatabase(url!);
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'test',
      emailBlindIndex: userId,
      passwordHash: 'test',
    });
  });
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
  afterAll(async () => {
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.$client.end({ timeout: 5 });
  });

  const repair = () => DATA_MIGRATIONS.filter((m) => m.id === 'scrubRepositoryErrors');
  const rows = () =>
    db
      .select({
        id: schema.repositories.id,
        status: schema.repositories.status,
        message: schema.repositories.statusMessage,
        updated: schema.repositories.updatedAt,
        xmin: sql<string>`xmin::text`,
      })
      .from(schema.repositories)
      .orderBy(schema.repositories.id);

  it('rewrites only changed error rows, logs their ids, preserves state and converges', async () => {
    const before = new Date('2026-01-01T00:00:00.000Z');
    const fixtures = [
      { status: 'error' as const, statusMessage: "EACCES: open '/srv/private/repo/.git/config'" },
      { status: 'error' as const, statusMessage: 'clone failed: Permission denied (publickey)' },
      { status: 'error' as const, statusMessage: 'https://github.com/o/r.git/: 403' },
      { status: 'error' as const, statusMessage: null },
      { status: 'ready' as const, statusMessage: "working in '/srv/private/repo'" },
      { status: 'cloning' as const, statusMessage: "cloning into '/srv/private/repo'" },
    ];
    const ids: string[] = [];
    for (const fixture of fixtures) {
      const [repo] = await db
        .insert(schema.repositories)
        .values({
          userId,
          name: 'fixture',
          source: 'blank',
          updatedAt: before,
          ...fixture,
        })
        .returning({ id: schema.repositories.id });
      ids.push(repo!.id);
    }
    const original = await rows();
    for (const migration of repair()) await migration.run(db);
    const repaired = await rows();
    expect(repaired.find((r) => r.id === ids[0])?.message).toBe("EACCES: open '[path]'");
    expect(repair()).toHaveLength(1);
    expect(repair()[0]?.kind).toBe('convergent');
    for (const row of repaired) {
      const prior = original.find((r) => r.id === row.id)!;
      expect(row).toMatchObject({ status: prior.status, updated: before });
      if (row.id === ids[0]) expect(row.xmin).not.toBe(prior.xmin);
      else expect(row).toEqual(prior);
    }
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        level: 30,
        count: 1,
        ids: [ids[0]],
        msg: 'scrubbed stored repository errors',
      }),
    );
    lines.length = 0;
    for (const migration of repair()) await migration.run(db);
    expect(await rows()).toEqual(repaired);
    expect(lines).toEqual([]);
  });

  it.each(['newer error', 'ready'] as const)(
    'leaves a concurrent %s alone and logs no rewrite',
    async (change) => {
      const [repo] = await db
        .insert(schema.repositories)
        .values({
          userId,
          name: 'racing fixture',
          source: 'blank',
          status: 'error',
          statusMessage: "EACCES: open '/srv/private/repo'",
        })
        .returning({ id: schema.repositories.id });
      const newer =
        change === 'ready' ? "EACCES: open '/srv/private/repo'" : "ENOENT: open '/srv/newer/repo'";
      // Run the actual SELECT, then land a newer value before the repair can UPDATE.
      const racingDb = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop !== 'select') return Reflect.get(target, prop, receiver);
          return (fields: Parameters<Database['select']>[0]) => ({
            from: (table: typeof schema.repositories) => ({
              where: async (condition: ReturnType<typeof eq>) => {
                const selected = await target.select(fields).from(table).where(condition);
                await db
                  .update(schema.repositories)
                  .set({
                    status: change === 'ready' ? 'ready' : 'error',
                    statusMessage: newer,
                  })
                  .where(eq(schema.repositories.id, repo!.id));
                return selected;
              },
            }),
          });
        },
      });
      for (const migration of repair()) await migration.run(racingDb);
      expect(repair()).toHaveLength(1);
      expect((await rows()).find((r) => r.id === repo!.id)).toMatchObject({
        status: change === 'ready' ? 'ready' : 'error',
        message: newer,
      });
      expect(lines).toEqual([]);
      await db.delete(schema.repositories).where(eq(schema.repositories.id, repo!.id));
    },
  );
});
