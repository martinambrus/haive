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
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { lastUpgradeRemovedFiles, upgradeRoutes } from '../src/routes/upgrades.js';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const REPO = '00000000-0000-4000-8000-0000000000c1';

function upgrades(tasks: { mode?: string; completedAt: number; removedPaths?: string[] }[]) {
  const fake = createFakeDb({ tasks: schema.tasks, taskSteps: schema.taskSteps });
  for (const t of tasks) {
    const task = fake.insert(schema.tasks, {
      repositoryId: REPO,
      type: 'onboarding_upgrade',
      status: 'completed',
      completedAt: new Date(t.completedAt),
      metadata: t.mode ? { mode: t.mode } : null,
    });
    if (t.removedPaths) {
      fake.insert(schema.taskSteps, {
        taskId: task.id,
        stepId: '02-upgrade-apply',
        status: 'done',
        output: { removedPaths: t.removedPaths },
      });
    }
  }
  return lastUpgradeRemovedFiles(fake.db as never, REPO);
}

describe('offering the rollback of an upgrade that only removed files', () => {
  it('offers it while the latest upgrade removed something and nothing rolled it back', async () => {
    expect(await upgrades([{ completedAt: 1, removedPaths: ['.claude/settings.json'] }])).toBe(
      true,
    );
  });

  it('stops offering it once a rollback completes after that upgrade', async () => {
    expect(
      await upgrades([
        { completedAt: 1, removedPaths: ['.claude/settings.json'] },
        { mode: 'rollback', completedAt: 2 },
      ]),
    ).toBe(false);
  });

  it('does not offer it for an upgrade that removed nothing, or with no upgrade at all', async () => {
    expect(await upgrades([{ completedAt: 1, removedPaths: [] }])).toBe(false);
    expect(await upgrades([{ completedAt: 1 }])).toBe(false);
    expect(await upgrades([])).toBe(false);
  });
});

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

type TaskSeed = { mode?: string; status: string; completedAt?: number };

function repoWith(tasks: TaskSeed[]) {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskEvents: schema.taskEvents,
    repositories: schema.repositories,
    onboardingArtifacts: schema.onboardingArtifacts,
  });
  fake.insert(schema.repositories, { id: REPO, userId: USER, name: 'repo', status: 'ready' });
  fake.insert(schema.tasks, {
    userId: USER,
    repositoryId: REPO,
    type: 'onboarding',
    title: 'onboarding',
    status: 'completed',
    completedAt: new Date(0),
  });
  const ids = tasks.map(
    (t) =>
      fake.insert(schema.tasks, {
        userId: USER,
        repositoryId: REPO,
        type: 'onboarding_upgrade',
        title: t.mode ?? 'upgrade',
        status: t.status,
        completedAt: t.completedAt === undefined ? null : new Date(t.completedAt),
        metadata: t.mode ? { mode: t.mode } : null,
      }).id as string,
  );
  h.db = fake.db;
  const upgradeTasks = () =>
    fake
      .rows(schema.tasks)
      .filter((r) => r.type === 'onboarding_upgrade' && !ids.includes(r.id as string));
  return { ids, upgradeTasks };
}

const rollBack = () => app.request(`/repositories/${REPO}/rollback-upgrade`, { method: 'POST' });
const startUpgrade = () =>
  app.request('/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'onboarding_upgrade', title: 'Upgrade', repositoryId: REPO }),
  });

describe('rolling back an upgrade', () => {
  it('names the upgrade it rolls back', async () => {
    const t = repoWith([{ status: 'completed', completedAt: 1 }]);
    const res = await rollBack();
    expect(res.status).toBe(201);
    expect(t.upgradeTasks().map((r) => r.metadata)).toEqual([
      { mode: 'rollback', rolledBackFromTaskId: t.ids[0] },
    ]);
  });

  // The rollback step reverts the newest completed upgrade, so a second rollback would undo the
  // same upgrade again.
  it('is refused once the last completed upgrade was itself a rollback', async () => {
    const t = repoWith([
      { status: 'completed', completedAt: 1 },
      { mode: 'rollback', status: 'completed', completedAt: 2 },
    ]);
    expect((await rollBack()).status).toBe(409);
    expect(t.upgradeTasks()).toEqual([]);
  });

  it('is refused when only rollbacks ever completed', async () => {
    const t = repoWith([{ mode: 'rollback', status: 'completed', completedAt: 1 }]);
    expect((await rollBack()).status).toBe(409);
    expect(t.upgradeTasks()).toEqual([]);
  });

  it('is refused while an upgrade is parked on its form', async () => {
    const t = repoWith([{ status: 'completed', completedAt: 1 }, { status: 'waiting_user' }]);
    const res = await rollBack();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain(t.ids[1]);
    expect(t.upgradeTasks()).toEqual([]);
  });

  it('starts once for two clicks at the same moment', async () => {
    const t = repoWith([{ status: 'completed', completedAt: 1 }]);
    const statuses = (await Promise.all([rollBack(), rollBack()])).map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409]);
    expect(t.upgradeTasks()).toHaveLength(1);
  });
});

describe('starting an upgrade', () => {
  it('is refused while a rollback runs', async () => {
    const t = repoWith([
      { status: 'completed', completedAt: 1 },
      { mode: 'rollback', status: 'running' },
    ]);
    expect((await startUpgrade()).status).toBe(409);
    expect(t.upgradeTasks()).toEqual([]);
  });

  it('starts once for two clicks at the same moment', async () => {
    const t = repoWith([]);
    const statuses = (await Promise.all([startUpgrade(), startUpgrade()]))
      .map((r) => r.status)
      .sort();
    expect(statuses).toEqual([201, 409]);
    expect(t.upgradeTasks()).toHaveLength(1);
  });
});
