import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const TASK = vi.hoisted(() => '00000000-0000-4000-8000-0000000000b1');
const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: vi.fn() }));
vi.mock('../src/lib/plan-mirror.js', () => ({
  enqueuePlanMirrorRefresh: vi.fn(),
  pullPlanMirror: vi.fn(),
  savePlanMirror: vi.fn(),
}));
vi.mock('../src/lib/spawn-plan-task.js', () => ({ spawnPlanTask: vi.fn(async () => TASK) }));
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
import { configService } from '@haive/shared';
import { planRoutes } from '../src/routes/plan.js';
import { spawnPlanTask } from '../src/lib/spawn-plan-task.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const REPO = '00000000-0000-4000-8000-0000000000c1';
const app = new Hono<AppEnv>();
app.route('/', planRoutes);
app.onError(errorHandler);

function setup(repo: Record<string, unknown>) {
  const fake = createFakeDb({
    repositories: schema.repositories,
    planNodes: schema.planNodes,
    tasks: schema.tasks,
    cliProviders: schema.cliProviders,
  });
  fake.insert(schema.repositories, { id: REPO, userId: USER, name: 'repo', ...repo });
  h.db = fake.db;
}

const build = (body: Record<string, unknown>) =>
  app.request(`/${REPO}/plan/build`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const brief = { mode: 'greenfield', description: 'Clubs' };
const readOnlyLocal = { source: 'local_path', writable: false, storagePath: '/host-fs/proj' };
const writableLocal = { source: 'local_path', writable: true, storagePath: '/repos/u/r' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(configService, 'get').mockResolvedValue('true');
  vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
});

describe('a plan build that defers its start for uploads', () => {
  it.each([true, false])('passes the picked count only for deferStart=%s', async (deferStart) => {
    setup(writableLocal);
    const res = await build({ ...brief, deferStart, expectedAttachmentCount: 3 });
    expect(res.status).toBe(201);
    expect(vi.mocked(spawnPlanTask).mock.calls[0]![0]).toMatchObject({
      expectedAttachmentCount: deferStart ? 3 : null,
    });
  });
  it.each([-1, 1.5, 10001, '2'])('rejects invalid picked count %s', async (count) => {
    setup(writableLocal);
    expect(
      (await build({ ...brief, deferStart: true, expectedAttachmentCount: count })).status,
    ).toBe(400);
    expect(spawnPlanTask).not.toHaveBeenCalled();
  });

  it('is refused up front for a read-only local repository, which takes no attachments', async () => {
    setup(readOnlyLocal);
    const res = await build({ ...brief, deferStart: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: 'Attachments are not supported for read-only local repositories',
    });
    expect(spawnPlanTask).not.toHaveBeenCalled();
  });

  it('still builds a read-only local repository from a brief with no files', async () => {
    setup(readOnlyLocal);
    expect((await build(brief)).status).toBe(201);
    expect(spawnPlanTask).toHaveBeenCalledTimes(1);
  });

  it('creates the task unstarted for a repository that can take uploads', async () => {
    setup(writableLocal);
    const res = await build({ ...brief, deferStart: true });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ taskId: TASK, deferred: true });
    expect(vi.mocked(spawnPlanTask).mock.calls[0]![0]).toMatchObject({ enqueue: false });
  });

  it('is refused for a repository with no storage yet, which is still being set up', async () => {
    setup({ source: 'git_https', writable: false, storagePath: null });
    const res = await build({ ...brief, deferStart: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: 'This repository is not ready for uploads yet',
    });
    expect(spawnPlanTask).not.toHaveBeenCalled();
  });
});
