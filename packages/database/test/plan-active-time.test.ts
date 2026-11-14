import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, schema, type Database } from '../src/index.js';

const url = process.env.PLAN_ACTIVE_TIME_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/plan_active_time_test'))
  throw new Error('Use a dedicated plan_active_time_test database');

describe.skipIf(!url)('plan active time on Postgres', () => {
  let db: Database;
  let userId: string;
  let repositoryId: string;
  const hourStart = new Date('2026-11-14T13:00:00Z');

  beforeAll(async () => {
    db = createDatabase(url!);
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'plan-time@test.local',
        emailBlindIndex: randomBytes(16).toString('hex'),
        passwordHash: randomBytes(16).toString('hex'),
      })
      .returning();
    userId = user!.id;
    const [repo] = await db
      .insert(schema.repositories)
      .values({
        userId,
        name: 'Plan time',
        source: 'blank',
      })
      .returning();
    repositoryId = repo!.id;
  });

  afterAll(async () => {
    if (userId) await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.$client.end({ timeout: 5 });
  });

  it('replays the guarded migration without changing existing data', async () => {
    const migration = readFileSync(
      new URL('../migrations/0237_plan_active_time.sql', import.meta.url),
      'utf8',
    );
    await db
      .insert(schema.planActiveTime)
      .values({ repositoryId, userId, hourStart, activeMs: 42 });
    await db.execute(sql.raw(migration));
    await db.execute(sql.raw(migration));
    const [row] = await db.select().from(schema.planActiveTime);
    expect(row).toMatchObject({ repositoryId, userId, hourStart, activeMs: 42 });
  });

  it('removes the hourly rows when the repository is deleted', async () => {
    await db
      .insert(schema.planActiveTime)
      .values({ repositoryId, userId, hourStart })
      .onConflictDoNothing();
    await db.delete(schema.repositories).where(eq(schema.repositories.id, repositoryId));
    expect(await db.select().from(schema.planActiveTime)).toEqual([]);
  });

  it('also cascades rows attributed to a deleted user', async () => {
    const [owner] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'plan-owner@test.local',
        emailBlindIndex: randomBytes(16).toString('hex'),
        passwordHash: randomBytes(16).toString('hex'),
      })
      .returning();
    try {
      const [repo] = await db
        .insert(schema.repositories)
        .values({ userId: owner!.id, name: 'Other owner', source: 'blank' })
        .returning();
      await db.insert(schema.planActiveTime).values({ repositoryId: repo!.id, userId, hourStart });
      await db.delete(schema.users).where(eq(schema.users.id, userId));
      expect(await db.select().from(schema.planActiveTime)).toEqual([]);
      expect(
        await db.query.repositories.findFirst({ where: eq(schema.repositories.id, repo!.id) }),
      ).toBeDefined();
    } finally {
      await db.delete(schema.users).where(eq(schema.users.id, owner!.id));
    }
  });
});
