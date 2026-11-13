import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../src/context.js';
import { ROOT_CLAIM_STALE_MS } from '@haive/database';

const TASK = '11111111-2222-3333-4444-555555555555';
const DIR = '/var/lib/haive/repos/u/r';

const state = vi.hoisted(() => ({
  task: null as { id: string; status: string } | null,
  events: [] as { eventType: string; payload: Record<string, unknown> }[],
  added: [] as unknown[][],
  hang: false,
}));

vi.mock('@haive/shared', async (original) => ({
  ...(await original<object>()),
  configService: { get: async () => null, getFresh: async () => null },
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
      if (state.hang) await new Promise(() => undefined);
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

const abort = (body: unknown = { dir: DIR, mergeHead: 'm1' }) =>
  app.request(`/tasks/${TASK}/merges/abort`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  state.task = { id: TASK, status: 'cancelled' };
  state.events = [leftOpen];
  state.added = [];
  state.hang = false;
});
afterEach(() => vi.useRealTimers());

describe('POST /tasks/:id/merges/abort', () => {
  it('queues the abort for a cancelled task whose merge is still reported open', async () => {
    const res = await abort();
    expect(res.status).toBe(202);
    expect(state.added).toHaveLength(1);
    expect(state.added[0]![0]).toBe(TASK_JOB_NAMES.ABORT_LEFT_MERGE);
    expect(state.added[0]![1]).toEqual({ taskId: TASK, userId: 'u1', dir: DIR, mergeHead: 'm1' });
  });

  it('answers 503 queue_unavailable when the queue never answers', async () => {
    state.hang = true;
    vi.useFakeTimers();
    const pending = abort();
    await vi.advanceTimersByTimeAsync(2000);
    const res = await pending;
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'Queue temporarily unavailable, try again shortly',
      code: 'queue_unavailable',
    });
  }, 10_000);

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
    expect((await abort({ dir: '/etc', mergeHead: 'm1' })).status).toBe(404);
    expect(state.added).toEqual([]);
  });

  it('is a 404 for a merge head no unsettled report of that dir names', async () => {
    expect((await abort({ dir: DIR, mergeHead: 'other' })).status).toBe(404);
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
      body: JSON.stringify({ dir: DIR, mergeHead: 'm1' }),
    });
    expect(res.status).toBe(403);
    expect(state.added).toEqual([]);
  });
});

describe('POST /tasks/:id/merges/undo', () => {
  const payload = {
    dir: DIR,
    repoPath: DIR,
    landedOn: 'main',
    landedAt: '2026-11-11T00:00:00Z',
    baseShaBefore: 'a'.repeat(40),
    baseShaAfter: 'b'.repeat(40),
  };
  const undo = (body: unknown = { dir: DIR, baseShaAfter: payload.baseShaAfter }) =>
    app.request(`/tasks/${TASK}/merges/undo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  beforeEach(() => {
    state.events = [
      { eventType: 'merge.left_committed', payload },
      { eventType: 'task.cancel_finished', payload: {} },
    ];
  });
  it('refuses Undo before cancellation teardown finishes with a plain 409 reason', async () => {
    state.events = state.events.filter((e) => e.eventType !== 'task.cancel_finished');
    const res = await undo();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: 'Cancellation cleanup is still running; try again after it finishes.',
    });
    expect(state.added).toEqual([]);
  });
  it('queues only the exact reported merge of the cancelled task', async () => {
    expect((await undo()).status).toBe(202);
    expect(state.added[0]?.slice(0, 2)).toEqual([
      'undo-left-merge',
      {
        taskId: TASK,
        userId: 'u1',
        dir: DIR,
        baseShaAfter: payload.baseShaAfter,
      },
    ]);
    const options = state.added[0]![2] as { attempts: number; backoff: { delay: number } };
    const lastRetryAfter = options.backoff.delay * (2 ** (options.attempts - 1) - 1);
    expect(
      lastRetryAfter,
      "post-move recovery must outlive a crashed worker's root lease",
    ).toBeGreaterThan(ROOT_CLAIM_STALE_MS);
  });
  it.each(['done', 'moved'])('refuses an already settled %s report', async (outcome) => {
    state.events.push({
      eventType: 'merge.left_committed_settled',
      payload: { ...payload, outcome: outcome === 'done' ? 'undone' : outcome, reason: 'settled' },
    });
    expect((await undo()).status).toBe(409);
    expect(state.added).toEqual([]);
  });
  it('refuses another attempt after a permanent report-only refusal', async () => {
    state.events.push({
      eventType: 'merge.left_committed_settled',
      payload: {
        ...payload,
        outcome: 'refused',
        permanent: true,
        reason: 'Pushed merge',
      },
    });
    expect((await undo()).status).toBe(409);
    expect(state.added).toEqual([]);
  });
  it('deduplicates the same attempt but queues a fresh job after a refusal', async () => {
    await undo();
    await undo();
    const id = (index: number) => (state.added[index]![2] as { jobId: string }).jobId;
    expect(id(0)).toBe(id(1));
    state.events.push({
      eventType: 'merge.left_committed_settled',
      payload: { ...payload, outcome: 'refused', reason: 'busy' },
    });
    await undo();
    expect(id(2)).not.toBe(id(0));
  });
  it('accepts another attempt after a retryable refusal', async () => {
    state.events.push({
      eventType: 'merge.left_committed_settled',
      payload: { ...payload, outcome: 'refused', reason: 'busy' },
    });
    expect((await undo()).status).toBe(202);
  });
  it('refuses a mismatched report and an active task', async () => {
    expect((await undo({ dir: DIR, baseShaAfter: 'c'.repeat(40) })).status).toBe(409);
    state.task!.status = 'running';
    expect((await undo()).status).toBe(409);
    expect(state.added).toEqual([]);
  });
  it('requires ownership and a valid sha', async () => {
    expect((await undo({ dir: DIR, baseShaAfter: '--bad' })).status).toBe(400);
    state.task = null;
    expect((await undo()).status).toBe(404);
    expect(state.added).toEqual([]);
  });
  it('is protected by the foreign-origin gate and authentication', async () => {
    const full = createApiApp('http://localhost:3000');
    expect(
      (
        await full.request(`/tasks/${TASK}/merges/undo`, {
          method: 'POST',
          headers: { origin: 'http://localhost:5173' },
        })
      ).status,
    ).toBe(403);
    expect((await full.request(`/tasks/${TASK}/merges/undo`, { method: 'POST' })).status).toBe(401);
    expect(state.added).toEqual([]);
  });

  const resync = (body: unknown = { dir: DIR, baseShaAfter: payload.baseShaAfter }) =>
    app.request(`/tasks/${TASK}/merges/resync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const oweResync = () =>
    state.events.push({
      eventType: 'merge.left_committed_settled',
      payload: { ...payload, outcome: 'undone' },
    });
  it('reuses the Undo job id for two Retry presses and an already queued Undo', async () => {
    await undo();
    oweResync();
    const responses = await Promise.all([resync(), resync()]);
    expect(responses.map((r) => r.status)).toEqual([202, 202]);
    const ids = state.added.map((args) => (args[2] as { jobId: string }).jobId);
    expect(new Set(ids).size).toBe(1);
    expect(state.added.every((args) => args[0] === TASK_JOB_NAMES.UNDO_LEFT_MERGE)).toBe(true);
  });
  it('refuses Retry unless that exact settled report still owes re-sync', async () => {
    expect((await resync()).status).toBe(409);
    oweResync();
    expect((await resync({ dir: DIR, baseShaAfter: 'c'.repeat(40) })).status).toBe(409);
    state.events.push({ eventType: 'merge.left_committed_resynced', payload });
    expect((await resync()).status).toBe(409);
    expect(state.added).toEqual([]);
  });
  it('requires a cancelled owned task, completed cleanup and valid report key for Retry', async () => {
    oweResync();
    expect((await resync({})).status).toBe(400);
    state.task!.status = 'running';
    expect((await resync()).status).toBe(409);
    state.task!.status = 'cancelled';
    state.events = state.events.filter((e) => e.eventType !== 'task.cancel_finished');
    expect((await resync()).status).toBe(409);
    state.task = null;
    expect((await resync()).status).toBe(404);
    expect(state.added).toEqual([]);
  });
  it('protects Retry with authentication and the foreign-origin gate', async () => {
    const full = createApiApp('http://localhost:3000');
    expect(
      (
        await full.request(`/tasks/${TASK}/merges/resync`, {
          method: 'POST',
          headers: { origin: 'http://localhost:5173' },
        })
      ).status,
    ).toBe(403);
    expect((await full.request(`/tasks/${TASK}/merges/resync`, { method: 'POST' })).status).toBe(
      401,
    );
    expect(state.added).toEqual([]);
  });
});
