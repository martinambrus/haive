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
import { lastUpgradeRemovedContent, upgradeRoutes } from '../src/routes/upgrades.js';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const REPO = '00000000-0000-4000-8000-0000000000c1';

function upgrades(
  tasks: { mode?: string; completedAt: number; applied?: Record<string, unknown> }[],
) {
  const fake = createFakeDb({ tasks: schema.tasks, taskSteps: schema.taskSteps });
  for (const t of tasks) {
    const task = fake.insert(schema.tasks, {
      repositoryId: REPO,
      type: 'onboarding_upgrade',
      status: 'completed',
      completedAt: new Date(t.completedAt),
      metadata: t.mode ? { mode: t.mode } : null,
    });
    if (t.applied) {
      fake.insert(schema.taskSteps, {
        taskId: task.id,
        stepId: '02-upgrade-apply',
        status: 'done',
        output: t.applied,
      });
    }
  }
  return lastUpgradeRemovedContent(fake.db as never, REPO);
}

const removed = { removedPaths: ['.claude/settings.json'] };

describe('offering the rollback of an upgrade that only removed things', () => {
  it('offers it while the latest upgrade removed something and nothing rolled it back', async () => {
    expect(await upgrades([{ completedAt: 1, applied: removed }])).toBe(true);
  });

  it('offers it for an upgrade that only took RTK blocks out', async () => {
    const applied = { removedPaths: [], rtkBlockStrips: [{ file: 'AGENTS.md', recordId: 'r1' }] };
    expect(await upgrades([{ completedAt: 1, applied }])).toBe(true);
  });

  it('stops offering it once a rollback completes after that upgrade', async () => {
    expect(
      await upgrades([
        { completedAt: 1, applied: removed },
        { mode: 'rollback', completedAt: 2 },
      ]),
    ).toBe(false);
  });

  it('does not offer it for an upgrade that removed nothing, or with no upgrade at all', async () => {
    expect(
      await upgrades([{ completedAt: 1, applied: { removedPaths: [], rtkBlockStrips: [] } }]),
    ).toBe(false);
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

function repoWith(tasks: TaskSeed[], opts: { resetAt?: number; liveOnboarding?: boolean } = {}) {
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
    onboardingResetAt: opts.resetAt === undefined ? null : new Date(opts.resetAt),
  });
  const liveOnboardingId = opts.liveOnboarding
    ? (fake.insert(schema.tasks, {
        userId: USER,
        repositoryId: REPO,
        type: 'onboarding',
        title: 'onboarding again',
        status: 'running',
      }).id as string)
    : null;
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
  return { ids, upgradeTasks, fake, liveOnboardingId };
}

const rollBack = () => app.request(`/repositories/${REPO}/rollback-upgrade`, { method: 'POST' });
const startUpgrade = () =>
  app.request('/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'onboarding_upgrade', title: 'Upgrade', repositoryId: REPO }),
  });

// A `created` upgrade counts as live, so one a failed request left behind would block the next.
describe('an upgrade or rollback whose creation fails part-way', () => {
  it.each([
    ['the created event', 'beforeInsert', schema.taskEvents],
    ['the move to queued', 'beforeUpdate', schema.tasks],
  ] as const)('leaves no upgrade behind when %s fails', async (_label, hook, table) => {
    const t = repoWith([]);
    t.fake.hooks[hook] = (written) => {
      if (written === table) throw new Error('write failed');
    };
    expect((await startUpgrade()).status).toBe(500);
    expect(t.upgradeTasks()).toEqual([]);
    t.fake.hooks[hook] = null;
    expect((await startUpgrade()).status).toBe(201);
  });

  it('leaves no rollback behind when its move to queued fails', async () => {
    const t = repoWith([{ status: 'completed', completedAt: 1 }]);
    t.fake.hooks.beforeUpdate = (written) => {
      if (written === schema.tasks) throw new Error('write failed');
    };
    expect((await rollBack()).status).toBe(500);
    expect(t.upgradeTasks()).toEqual([]);
  });
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

  // A rollback restores what the upgrade replaced or removed, so it is gated like the upgrade.
  it('is refused after a reset no onboarding has answered', async () => {
    const t = repoWith([{ status: 'completed', completedAt: 1 }], { resetAt: 5 });
    const res = await rollBack();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('reset');
    expect(t.upgradeTasks()).toEqual([]);
  });

  it('is refused while an onboarding runs', async () => {
    const t = repoWith([{ status: 'completed', completedAt: 1 }], { liveOnboarding: true });
    const res = await rollBack();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain(t.liveOnboardingId);
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

const startOnboarding = () =>
  app.request('/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'onboarding', title: 'Onboarding', repositoryId: REPO }),
  });

describe('an onboarding and an upgrade or rollback of one repository', () => {
  const liveKinds = (fake: ReturnType<typeof repoWith>['fake']) =>
    fake
      .rows(schema.tasks)
      .filter((r) => r.type !== 'onboarding' || r.title === 'Onboarding')
      .filter((r) => r.status === 'created' || r.status === 'queued')
      .map((r) => r.type);

  it('are not both created when started at the same moment', async () => {
    const t = repoWith([]);
    const statuses = (await Promise.all([startOnboarding(), startUpgrade()]))
      .map((r) => r.status)
      .sort();
    expect(statuses).toEqual([201, 409]);
    expect(liveKinds(t.fake)).toHaveLength(1);
  });

  it('are not both created when an onboarding and a rollback start at the same moment', async () => {
    const t = repoWith([{ status: 'completed', completedAt: 1 }]);
    const statuses = (await Promise.all([startOnboarding(), rollBack()]))
      .map((r) => r.status)
      .sort();
    expect(statuses).toEqual([201, 409]);
    expect(liveKinds(t.fake)).toHaveLength(1);
  });

  it('refuses an onboarding while an upgrade or a rollback is live', async () => {
    const t = repoWith([
      { status: 'completed', completedAt: 1 },
      { mode: 'rollback', status: 'running' },
    ]);
    const res = await startOnboarding();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain(t.ids[1]);
    expect(liveKinds(t.fake)).toEqual([]);
  });
});
