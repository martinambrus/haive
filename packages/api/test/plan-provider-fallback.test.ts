import { beforeEach, describe, expect, it, vi } from 'vitest';

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
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { planRoutes } from '../src/routes/plan.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const REPO = '00000000-0000-4000-8000-0000000000c1';
const OTHER_REPO = '00000000-0000-4000-8000-0000000000c2';
const FIXTURE = '00000000-0000-4000-8000-0000000000e1';
const USED = '00000000-0000-4000-8000-0000000000e2';
const OFF = '00000000-0000-4000-8000-0000000000e3';
const app = new Hono<AppEnv>();
app.route('/', planRoutes);
app.onError(errorHandler);

function setup() {
  const fake = createFakeDb({
    repositories: schema.repositories,
    tasks: schema.tasks,
    cliProviders: schema.cliProviders,
    userStepCliRolePreferences: schema.userStepCliRolePreferences,
  });
  for (const id of [REPO, OTHER_REPO]) {
    fake.insert(schema.repositories, { id, userId: USER, name: id });
  }
  for (const [id, enabled, createdAt] of [
    [FIXTURE, true, new Date('2026-01-01T00:00:00Z')],
    [USED, true, new Date('2026-02-01T00:00:00Z')],
    [OFF, false, new Date('2026-03-01T00:00:00Z')],
  ] as const) {
    fake.insert(schema.cliProviders, {
      id,
      userId: USER,
      name: 'codex',
      label: id,
      enabled,
      createdAt,
    });
  }
  h.db = fake.db;
  return fake;
}

function addTask(
  fake: ReturnType<typeof setup>,
  repositoryId: string,
  cliProviderId: string,
  createdAt: string,
) {
  fake.insert(schema.tasks, {
    userId: USER,
    repositoryId,
    cliProviderId,
    type: 'plan_build',
    title: 't',
    status: 'completed',
    createdAt: new Date(createdAt),
  });
}

const planner = async () =>
  (
    (await (await app.request(`/${REPO}/plan/build/clis`)).json()) as {
      plannerCliProviderId: string | null;
    }
  ).plannerCliProviderId;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the plan CLI chosen when none is named', () => {
  it('falls back to the oldest enabled provider when the user has run nothing', async () => {
    setup();
    expect(await planner()).toBe(FIXTURE);
  });

  it('follows the provider of the latest task on another repository', async () => {
    const fake = setup();
    addTask(fake, OTHER_REPO, USED, '2026-04-01T00:00:00Z');
    expect(await planner()).toBe(USED);
  });

  it("skips this repository's latest task when its provider is disabled", async () => {
    const fake = setup();
    addTask(fake, REPO, USED, '2026-04-01T00:00:00Z');
    addTask(fake, REPO, OFF, '2026-05-01T00:00:00Z');
    expect(await planner()).toBe(USED);
  });

  it('prefers this repository over a newer task on another one', async () => {
    const fake = setup();
    addTask(fake, REPO, USED, '2026-04-01T00:00:00Z');
    addTask(fake, OTHER_REPO, FIXTURE, '2026-05-01T00:00:00Z');
    expect(await planner()).toBe(USED);
  });

  it('is null when the user has no enabled provider', async () => {
    const fake = setup();
    fake.patch(schema.cliProviders, FIXTURE, { enabled: false });
    fake.patch(schema.cliProviders, USED, { enabled: false });
    expect(await planner()).toBeNull();
  });
});
