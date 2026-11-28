import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({ db: undefined as unknown, lock: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: vi.fn() }));
vi.mock('../src/lib/plan-mirror.js', () => ({
  enqueuePlanMirrorRefresh: vi.fn(),
  pullPlanMirror: vi.fn(),
  savePlanMirror: vi.fn(),
}));
vi.mock('../src/lib/spawn-plan-task.js', () => ({ spawnPlanTask: vi.fn() }));
vi.mock('../src/lib/task-start.js', () => ({ enqueueStart: vi.fn() }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    c.set('userRole', 'user');
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));
vi.mock('@haive/shared', async (original) => ({
  ...(await original<typeof import('@haive/shared')>()),
  lockNewWorkFenceShared: h.lock,
}));

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { configService } from '@haive/shared';
import { pullPlanMirror, savePlanMirror } from '../src/lib/plan-mirror.js';
import { planRoutes } from '../src/routes/plan.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const REPO = randomUUID();
const app = new Hono<AppEnv>();
app.route('/', planRoutes);
app.onError(errorHandler);

let fake: ReturnType<typeof createFakeDb>;
let events: string[];
let fresh: ReturnType<typeof vi.spyOn>;

const mirror = { save: savePlanMirror, pull: pullPlanMirror } as const;
const post = (kind: 'save' | 'pull') =>
  app.request(`/${REPO}/plan/snapshot/${kind}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });

beforeEach(() => {
  vi.clearAllMocks();
  fake = createFakeDb({ repositories: schema.repositories, tasks: schema.tasks });
  fake.insert(schema.repositories, { id: REPO, userId: USER, name: 'repo', status: 'ready' });
  h.db = fake.db;
  events = [];
  fake.hooks.beforeCommit = () => {
    events.push('fence-committed');
  };
  h.lock.mockReset().mockImplementation(async () => {
    events.push('fence-lock');
  });
  for (const fn of Object.values(mirror)) {
    vi.mocked(fn).mockImplementation((async () => {
      events.push('mirror');
      return { ok: true };
    }) as never);
  }
  vi.spyOn(configService, 'get').mockResolvedValue('true');
  fresh = vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
});

afterEach(() => {
  vi.useRealTimers();
});

describe.each(['save', 'pull'] as const)('snapshot %s admission', (kind) => {
  it('takes the fence and releases it before the mirror call', async () => {
    const res = await post(kind);
    expect(res.status).toBe(200);
    expect(mirror[kind]).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['fence-lock', 'fence-committed', 'mirror']);
  });

  it.each(['draining', 'maintenance'])(
    'answers 503 while %s, with no fence and no job',
    async (state) => {
      fresh.mockResolvedValue(state);
      const res = await post(kind);
      expect(res.status).toBe(503);
      expect(mirror[kind]).not.toHaveBeenCalled();
      expect(h.lock).not.toHaveBeenCalled();
    },
  );

  it('answers 503, not 409, when the state turns draining after the early check', async () => {
    fresh.mockResolvedValueOnce('normal').mockResolvedValue('draining');
    const res = await post(kind);
    expect(res.status).toBe(503);
    expect(mirror[kind]).not.toHaveBeenCalled();
  });

  it('answers 409 busy when the fence wait times out', async () => {
    vi.useFakeTimers();
    h.lock.mockImplementation(
      () =>
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(Object.assign(new Error('lock wait'), { code: '55P03' })), 1_000),
        ),
    );
    const outcome = post(kind);
    await vi.advanceTimersByTimeAsync(1_000);
    const res = await outcome;
    expect(res.status).toBe(409);
    expect(mirror[kind]).not.toHaveBeenCalled();
  });

  it('refuses while a merge conversation is open, before taking the fence', async () => {
    fake.insert(schema.tasks, {
      userId: USER,
      repositoryId: REPO,
      type: 'plan_merge',
      title: 't',
      status: 'running',
    });
    const res = await post(kind);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe('plan_merge_open');
    expect(h.lock).not.toHaveBeenCalled();
    expect(mirror[kind]).not.toHaveBeenCalled();
  });
});
