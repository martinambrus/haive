import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../src/context.js';

const TASK = '11111111-2222-3333-4444-555555555555';
const DIR = '/var/lib/haive/repos/u/r';

const state = vi.hoisted(() => ({
  task: null as { id: string; status: string } | null,
  events: [] as { eventType: string; payload: Record<string, unknown> }[],
  added: [] as unknown[][],
}));

vi.mock('../src/db.js', () => ({
  getDb: () => ({
    query: { tasks: { findFirst: async () => state.task } },
    select: () => ({ from: () => ({ where: () => ({ orderBy: async () => state.events }) }) }),
  }),
}));
vi.mock('../src/queues.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/queues.js')>()),
  getTaskQueue: () => ({
    add: async (...args: unknown[]) => {
      state.added.push(args);
    },
  }),
}));

const { createApiApp } = await import('../src/index.js');
const { mergeRoutes } = await import('../src/routes/tasks/merges.js');
const { errorHandler } = await import('../src/middleware/error-handler.js');
const { TASK_JOB_NAMES } = await import('@haive/shared');

const leftOpen = {
  eventType: 'merge.left_open',
  payload: { dir: DIR, ref: 'feat/a', head: 'h1', mergeHead: 'm1' },
};

const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  c.set('userId', 'u1');
  await next();
});
app.route('/tasks', mergeRoutes);
app.onError(errorHandler);

const abort = (body: unknown = { dir: DIR }) =>
  app.request(`/tasks/${TASK}/merges/abort`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  state.task = { id: TASK, status: 'cancelled' };
  state.events = [leftOpen];
  state.added = [];
});

describe('POST /tasks/:id/merges/abort', () => {
  it('queues the abort for a cancelled task whose merge is still reported open', async () => {
    const res = await abort();
    expect(res.status).toBe(202);
    expect(state.added).toHaveLength(1);
    expect(state.added[0]![0]).toBe(TASK_JOB_NAMES.ABORT_LEFT_MERGE);
    expect(state.added[0]![1]).toEqual({ taskId: TASK, userId: 'u1', dir: DIR });
  });

  it('is a 404 for a task the user does not own, queueing nothing', async () => {
    state.task = null;
    expect((await abort()).status).toBe(404);
    expect(state.added).toEqual([]);
  });

  it('refuses a task that is not cancelled with a 409', async () => {
    state.task = { id: TASK, status: 'failed' };
    expect((await abort()).status).toBe(409);
    expect(state.added).toEqual([]);
  });

  it('is a 404 for a dir no event names', async () => {
    expect((await abort({ dir: '/etc' })).status).toBe(404);
    expect(state.added).toEqual([]);
  });

  it('is a 404 once the merge is settled', async () => {
    state.events = [
      leftOpen,
      {
        eventType: 'merge.left_open_settled',
        payload: { dir: DIR, mergeHead: 'm1', outcome: 'aborted', reason: 'done' },
      },
    ];
    expect((await abort()).status).toBe(404);
    expect(state.added).toEqual([]);
  });

  it('is a 400 without a dir', async () => {
    expect((await abort({})).status).toBe(400);
    expect(state.added).toEqual([]);
  });

  it('is refused from another page before it reaches the route', async () => {
    const full = createApiApp('http://localhost:3000');
    const res = await full.request(`/tasks/${TASK}/merges/abort`, {
      method: 'POST',
      headers: { host: 'localhost:3001', origin: 'http://localhost:5173' },
      body: JSON.stringify({ dir: DIR }),
    });
    expect(res.status).toBe(403);
    expect(state.added).toEqual([]);
  });
});
