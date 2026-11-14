import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: vi.fn() }));
vi.mock('../src/lib/plan-mirror.js', () => ({
  enqueuePlanMirrorRefresh: vi.fn(),
  pullPlanMirror: vi.fn(),
  savePlanMirror: vi.fn(),
}));
vi.mock('../src/lib/spawn-plan-task.js', () => ({ spawnPlanTask: vi.fn() }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));

import { Hono } from 'hono';
import { createDatabase, schema, type Database } from '@haive/database';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createFakeDb } from '@haive/database/testing';
import { planRoutes } from '../src/routes/plan.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const REPO = '00000000-0000-4000-8000-0000000000c1';
const app = new Hono<AppEnv>();
app.route('/repositories', planRoutes);
app.onError(errorHandler);
function post(deltaMs: unknown, repositoryId = REPO) {
  return app.request(`/repositories/${repositoryId}/plan/user-active`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deltaMs }),
  });
}
beforeEach(() => {
  const fake = createFakeDb({ repositories: schema.repositories });
  fake.insert(schema.repositories, { id: REPO, userId: USER, name: 'repo' });
  h.db = fake.db;
});
it('refuses another user’s repository with 404', async () => {
  const fake = createFakeDb({ repositories: schema.repositories });
  fake.insert(schema.repositories, { id: REPO, userId: '00000000-0000-4000-8000-0000000000a2' });
  h.db = fake.db;
  const insert = vi.spyOn(fake.db, 'insert');
  expect((await post(1000)).status).toBe(404);
  expect(insert).not.toHaveBeenCalled();
});
it.each([-1, 60_001, 0.5, '1000', null, undefined])('refuses invalid delta %s', async (delta) => {
  expect((await post(delta)).status).toBe(400);
});
it('accepts zero without creating a row', async () => {
  const insert = vi.spyOn(h.db as Database, 'insert');
  expect((await post(0)).status).toBe(200);
  expect(insert).not.toHaveBeenCalled();
});

const url = process.env.PLAN_USER_ACTIVE_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/plan_user_active_test'))
  throw new Error('Use a dedicated plan_user_active_test database');
describe.skipIf(!url)('plan user-active upsert on Postgres', () => {
  let db: Database;
  let repositoryId: string;
  beforeAll(async () => {
    db = createDatabase(url!);
    await db.insert(schema.users).values({
      id: USER,
      emailEncrypted: 'plan-time@test.local',
      emailBlindIndex: randomBytes(16).toString('hex'),
      passwordHash: randomBytes(16).toString('hex'),
    });
    const [repo] = await db
      .insert(schema.repositories)
      .values({ userId: USER, name: 'plan-time', source: 'blank' })
      .returning();
    repositoryId = repo!.id;
  });
  beforeEach(async () => {
    h.db = db;
    await db.delete(schema.planActiveTime);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-14T13:59:59Z'));
  });
  afterEach(() => vi.useRealTimers());
  afterAll(async () => {
    await db.delete(schema.users).where(eq(schema.users.id, USER));
    await db.$client.end({ timeout: 5 });
  });
  const rows = () => db.select().from(schema.planActiveTime);
  it('atomically sums concurrent deltas into the server UTC receipt hour', async () => {
    const answers = await Promise.all([
      post(60_000, repositoryId),
      post(15_000, repositoryId),
      post(1, repositoryId),
    ]);
    expect(answers.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(await rows()).toEqual([
      { repositoryId, userId: USER, hourStart: new Date('2026-11-14T13:00:00Z'), activeMs: 75_001 },
    ]);
    vi.setSystemTime(new Date('2026-11-14T14:00:00Z'));
    expect((await post(1000, repositoryId)).status).toBe(200);
    expect(await rows()).toHaveLength(2);
  });
  it('clamps a conflicting sum at one hour', async () => {
    await db.insert(schema.planActiveTime).values({
      repositoryId,
      userId: USER,
      hourStart: new Date('2026-11-14T13:00:00Z'),
      activeMs: 3_599_999,
    });
    expect((await post(60_000, repositoryId)).status).toBe(200);
    expect((await rows())[0]?.activeMs).toBe(3_600_000);
  });
});
