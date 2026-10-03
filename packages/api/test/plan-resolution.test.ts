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
import { configService } from '@haive/shared';
import { planRoutes } from '../src/routes/plan.js';
import { enqueuePlanMirrorRefresh } from '../src/lib/plan-mirror.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const REPO = '00000000-0000-4000-8000-0000000000c1';
const NODE = '00000000-0000-4000-8000-0000000000d1';
const app = new Hono<AppEnv>();
app.route('/', planRoutes);
app.onError(errorHandler);

function setup(kind = 'decision', taskable = false, body = 'What does revision mean?') {
  const fake = createFakeDb({
    repositories: schema.repositories,
    planNodes: schema.planNodes,
    planMirrorState: schema.planMirrorState,
  });
  fake.insert(schema.repositories, { id: REPO, userId: USER, name: 'repo' });
  fake.insert(schema.planNodes, {
    id: NODE,
    repositoryId: REPO,
    parentId: null,
    path: `/${NODE}/`,
    title: 'Revision',
    ordinal: 0,
    kind,
    taskable,
    body,
    status: 'todo',
    version: 1,
  });
  h.db = fake.db;
  return fake;
}

function resolve(
  body: Record<string, unknown> = {
    expectedVersion: 1,
    answer: 'Inspection records',
    status: 'done',
  },
) {
  return app.request(`/${REPO}/plan/nodes/${NODE}/resolution`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(configService, 'get').mockResolvedValue('true');
});

describe('recording a human plan resolution', () => {
  it('writes the answer, status, completion date and mirror revision together', async () => {
    const fake = setup();
    const response = await resolve();
    expect(response.status).toBe(200);
    expect(fake.rows(schema.planNodes)[0]).toMatchObject({
      body: 'What does revision mean?\n\n## Decision\n\nInspection records',
      status: 'done',
      version: 2,
    });
    expect(fake.rows(schema.planNodes)[0]?.doneAt).toBeInstanceOf(Date);
    expect(fake.rows(schema.planMirrorState)[0]).toMatchObject({ revision: 1 });
    expect(enqueuePlanMirrorRefresh).toHaveBeenCalledWith(REPO, USER);
  });

  it('preserves the current question and status when the form version is stale', async () => {
    const fake = setup();
    fake.patch(schema.planNodes, NODE, { version: 2, body: 'Updated question' });
    expect((await resolve()).status).toBe(409);
    expect(fake.rows(schema.planNodes)[0]).toMatchObject({
      body: 'Updated question',
      status: 'todo',
      version: 2,
    });
    expect(fake.rows(schema.planMirrorState)).toHaveLength(0);
    expect(enqueuePlanMirrorRefresh).not.toHaveBeenCalled();
  });

  it('records external outcomes while retaining a human blocker', async () => {
    const fake = setup('external');
    expect(
      (
        await resolve({
          expectedVersion: 1,
          answer: 'Provider chosen; waiting for account access.',
          status: 'blocked_human',
        })
      ).status,
    ).toBe(200);
    expect(fake.rows(schema.planNodes)[0]).toMatchObject({
      status: 'blocked_human',
      body: 'What does revision mean?\n\n## Outcome\n\nProvider chosen; waiting for account access.',
    });
  });

  it('refuses a missing answer without changing the item', async () => {
    const fake = setup();
    expect((await resolve({ expectedVersion: 1, answer: '  ', status: 'done' })).status).toBe(400);
    expect(fake.rows(schema.planNodes)[0]).toMatchObject({ version: 1, status: 'todo' });
  });

  it('does not use human resolution for a component or developer-task decision', async () => {
    for (const [kind, taskable] of [
      ['component', false],
      ['decision', true],
    ] as const) {
      setup(kind, taskable);
      expect((await resolve()).status).toBe(400);
    }
  });

  it('refuses a repository owned by someone else', async () => {
    const fake = setup();
    fake.patch(schema.repositories, REPO, { userId: '00000000-0000-4000-8000-0000000000a2' });
    expect((await resolve()).status).toBe(404);
    expect(fake.rows(schema.planNodes)[0]).toMatchObject({ version: 1, status: 'todo' });
  });

  it('refuses an answer that would push the stored description over its bound', async () => {
    setup('decision', false, 'x'.repeat(200_000));
    expect((await resolve()).status).toBe(400);
    expect(enqueuePlanMirrorRefresh).not.toHaveBeenCalled();
  });
});
