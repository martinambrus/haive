import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  add: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: h.add }) }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { upgradeRoutes } from '../src/routes/upgrades.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const REPO = '00000000-0000-4000-8000-0000000000c1';

const app = new Hono<AppEnv>();
app.use(async (c, next) => {
  c.set('maintenanceState', 'normal');
  await next();
});
app.route('/tasks', taskRoutes);
app.route('/repositories', upgradeRoutes);
app.onError(errorHandler);

beforeEach(() => {
  h.add.mockReset();
  h.add.mockResolvedValue(undefined);
});

function world(repo: Record<string, unknown> = {}) {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskEvents: schema.taskEvents,
    repositories: schema.repositories,
    onboardingArtifacts: schema.onboardingArtifacts,
  });
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: 'repo',
    status: 'ready',
    renderContext: null,
    ...repo,
  });
  const finished = (type: string, completedAt: number) =>
    fake.insert(schema.tasks, {
      userId: USER,
      repositoryId: REPO,
      type,
      title: type,
      status: 'completed',
      completedAt: new Date(completedAt),
    });
  finished('onboarding', Date.now() - 60_000);
  finished('onboarding_upgrade', Date.now() - 30_000);
  h.db = fake.db;
  const created = () =>
    fake.rows(schema.tasks).filter((r) => r.status !== 'completed' && r.repositoryId === REPO);
  return { fake, created };
}

const post = (path: string, body?: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const startUpgrade = () =>
  post('/tasks', { type: 'onboarding_upgrade', title: 'Upgrade', repositoryId: REPO });
const startOnboarding = () =>
  post('/tasks', { type: 'onboarding', title: 'Onboarding', repositoryId: REPO });
const rollback = () => post(`/repositories/${REPO}/rollback-upgrade`);

const claimed = () => ({ rootClaimedAt: new Date(), rootClaimKind: 'reset', rootClaimOwner: 'x' });

describe('creating an onboarding, an upgrade or a rollback beside a reset', () => {
  it.each([
    ['an upgrade', startUpgrade],
    ['a rollback', rollback],
    ['an onboarding', startOnboarding],
  ])('refuses %s while the reset holds the root claim', async (_name, start) => {
    const { created } = world(claimed());
    const res = await start();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('being reset') });
    expect(created()).toHaveLength(0);
  });

  it('creates them once the claim is stale', async () => {
    const { created } = world({ ...claimed(), rootClaimedAt: new Date(Date.now() - 3_600_000) });
    expect((await startUpgrade()).status).toBe(201);
    expect(created()).toHaveLength(1);
  });

  it.each([
    ['an upgrade', startUpgrade],
    ['a rollback', rollback],
  ])('refuses %s when a reset epoch is stamped after the early check', async (_name, start) => {
    const { fake, created } = world();
    fake.hooks.beforeLock = async () => {
      fake.hooks.beforeLock = null;
      await fake.db
        .update(schema.repositories)
        .set({ onboardingResetAt: new Date() })
        .where(eq(schema.repositories.id, REPO));
    };
    const res = await start();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('was reset') });
    expect(created()).toHaveLength(0);
  });
});
