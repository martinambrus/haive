import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import type { Context } from 'hono';
import type { AppEnv } from '../src/context.js';

const h = vi.hoisted(() => ({ db: undefined as unknown, search: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/routes/rag.js', () => ({ executeRagSearch: h.search }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: Context<AppEnv>, next: () => Promise<void>) => {
    const user = c.req.header('x-test-user');
    if (!user) return c.json({ error: 'Not authenticated' }, 401);
    c.set('userId', user);
    c.set('userRole', 'user');
    await next();
  },
}));
import { ragPlaygroundRoutes } from '../src/routes/rag-playground.js';
import { errorHandler } from '../src/middleware/error-handler.js';

const USER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const TASK = '00000000-0000-4000-8000-000000000003';
const FOREIGN = '00000000-0000-4000-8000-000000000004';
const app = new Hono<AppEnv>().route('/playground', ragPlaygroundRoutes);
app.onError(errorHandler);

beforeEach(() => {
  const fake = createFakeDb({ tasks: schema.tasks, ragQueryLog: schema.ragQueryLog });
  fake.insert(schema.tasks, { id: TASK, userId: USER, title: 'My task', type: 'workflow' });
  fake.insert(schema.tasks, { id: FOREIGN, userId: OTHER, title: 'Their task', type: 'workflow' });
  h.db = fake.db;
  h.search.mockReset().mockResolvedValue([
    {
      sourcePath: 'src/session.ts',
      sectionId: '',
      scope: 'local',
      rrf: 0.05,
      denseSim: 0.8,
      content: 'Human-readable result',
    },
  ]);
});

const search = (body: unknown, user = USER) =>
  app.request('/playground/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': user },
    body: JSON.stringify(body),
  });

describe('personal RAG playground', () => {
  it('requires a session on every endpoint', async () => {
    for (const path of ['/tasks', `/tasks/${TASK}/queries`, `/queries/${TASK}`]) {
      expect((await app.request(`/playground${path}`)).status).toBe(401);
    }
    expect((await search({ taskId: TASK, query: 'cookies' }, '')).status).toBe(401);
  });
  it('lists only the user’s tasks', async () => {
    const res = await app.request('/playground/tasks', { headers: { 'x-test-user': USER } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tasks: Array<{ id: string; title: string }> }).tasks).toEqual([
      { id: TASK, title: 'My task' },
    ]);
  });
  it('refuses another user’s history and search before running retrieval', async () => {
    expect(
      (
        await app.request(`/playground/tasks/${FOREIGN}/queries`, {
          headers: { 'x-test-user': USER },
        })
      ).status,
    ).toBe(404);
    expect((await search({ taskId: FOREIGN, query: 'cookies' })).status).toBe(404);
    expect(h.search).not.toHaveBeenCalled();
  });
  it('uses task context and returns the LLM’s readable response', async () => {
    const res = await search({ taskId: TASK, query: '  cookies  ', top_k: 5 });
    expect(res.status).toBe(200);
    expect(h.search).toHaveBeenCalledWith(TASK, 'cookies', 5);
    expect(((await res.json()) as { text: string }).text).toBe(
      '### 1. [local] src/session.ts  (rrf=0.0500, dense=0.800)\nHuman-readable result',
    );
    expect(
      await (h.db as ReturnType<typeof createFakeDb>['db']).query.ragQueryLog!.findMany({}),
    ).toEqual([]);
  });
  it.each([
    { taskId: TASK, query: '' },
    { taskId: TASK, query: 'cookies', top_k: 51 },
    { taskId: TASK, query: 'cookies', top_k: 1.5 },
    { taskId: 'bad', query: 'cookies' },
  ])('rejects invalid input: %j', async (body) => {
    expect((await search(body)).status).toBe(400);
    expect(h.search).not.toHaveBeenCalled();
  });
});
