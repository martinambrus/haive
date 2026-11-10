import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const url = process.env.TASK_START_ATTACHMENTS_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/task_start_attachments_test')) {
  throw new Error(
    'Use the dedicated task_start_attachments_test scratch database for these route tests',
  );
}
const USER = vi.hoisted(() => '00000000-0000-4000-8000-000000003631');
const h = vi.hoisted(() => ({ db: undefined as unknown, add: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: h.add }) }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));
vi.mock('../src/lib/task-type-definition.js', () => ({
  definitionForCreate: async () => ({ runListSnapshot: null }),
}));
vi.mock('../src/lib/plan-mirror.js', () => ({
  enqueuePlanMirrorRefresh: vi.fn(),
  pullPlanMirror: vi.fn(),
  savePlanMirror: vi.fn(),
}));

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { createDatabase, schema, type Database } from '@haive/database';
import { configService } from '@haive/shared';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { planRoutes } from '../src/routes/plan.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const REPO = '00000000-0000-4000-8000-000000003632';
const app = new Hono<AppEnv>();
app.route('/tasks', taskRoutes);
app.route('/repos', planRoutes);
app.onError(errorHandler);
const post = (path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe.skipIf(!url)('deferred attachments through real Postgres routes', () => {
  let db: Database;
  beforeAll(() => {
    db = createDatabase(url!);
    h.db = db;
    vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
    vi.spyOn(configService, 'get').mockResolvedValue('true');
  });
  beforeEach(async () => {
    h.add.mockReset();
    h.add.mockResolvedValue(undefined);
    await db.delete(schema.users).where(eq(schema.users.id, USER));
    await db.insert(schema.users).values({
      id: USER,
      emailEncrypted: 'x',
      emailBlindIndex: 't363-route-controls',
      passwordHash: 'x',
    });
    await db.insert(schema.repositories).values({
      id: REPO,
      userId: USER,
      name: 'scratch',
      status: 'ready',
      source: 'blank',
      storagePath: '/unused/t363',
    });
  });
  afterAll(async () => {
    if (!db) return;
    await db.delete(schema.users).where(eq(schema.users.id, USER));
    await db.$client.end({ timeout: 5 });
  });
  const row = (id: string) => db.query.tasks.findFirst({ where: eq(schema.tasks.id, id) });
  const create = async (plan: boolean, expected: number | undefined, deferStart = true) => {
    const res = await post(plan ? `/repos/${REPO}/plan/build` : '/tasks', {
      ...(plan ? { mode: 'greenfield', clarify: false } : { type: 'workflow' }),
      repositoryId: REPO,
      title: 'scratch task',
      description: 'do it',
      deferStart,
      expectedAttachmentCount: expected,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { taskId?: string; task?: { id: string } };
    return body.taskId ?? body.task!.id;
  };
  const upload = async (taskId: string, expandedFromId: string | null = null) => {
    const [attachment] = await db
      .insert(schema.taskAttachments)
      .values({
        taskId,
        userId: USER,
        filename: 'spec.md',
        storedPath: '/unused/spec.md',
        sizeBytes: 1,
        expandedFromId,
      })
      .returning();
    return attachment!.id;
  };

  it.each(['same-branch', 'cross-branch', 'done', 'left-open', 'settled'] as const)(
    'fences root START for %s merge state with a retryable 409',
    async (kind) => {
      const id = await create(false, undefined);
      const [merger] = await db
        .insert(schema.tasks)
        .values({
          userId: USER,
          repositoryId: REPO,
          type: 'workflow',
          title: 'merger',
          status: kind === 'left-open' || kind === 'settled' ? 'cancelled' : 'waiting_user',
        })
        .returning();
      const dir =
        kind === 'cross-branch' ? '/unused/t363/.haive/worktrees/main--base' : '/unused/t363';
      const [step] = await db
        .insert(schema.taskSteps)
        .values({
          taskId: merger!.id,
          stepId: '12-worktree-cleanup',
          stepIndex: 12,
          title: 'merge',
          round: 0,
          status: 'waiting_cli',
          mergeResolveState: {
            mode: kind === 'cross-branch' ? 'cross-branch' : 'same-branch',
            phase: kind === 'done' ? 'done' : 'resolving',
            baseBranch: 'main',
            featureBranch: 'feature',
            mergeDir: dir,
          } as never,
        })
        .returning();
      if (kind === 'left-open' || kind === 'settled') {
        await db.insert(schema.taskEvents).values({
          taskId: merger!.id,
          taskStepId: step!.id,
          eventType: 'merge.left_open',
          payload: { dir, ref: 'feature', head: 'old', mergeHead: 'incoming' },
        });
        if (kind === 'settled')
          await db.insert(schema.taskEvents).values({
            taskId: merger!.id,
            eventType: 'merge.left_open_settled',
            payload: { dir, mergeHead: 'incoming', outcome: 'aborted', reason: 'done' },
          });
      } else {
        await db
          .insert(schema.mergeDirClaims)
          .values({ mergeDir: dir, taskId: merger!.id, taskStepId: step!.id });
      }
      const busy = kind === 'same-branch' || kind === 'left-open';
      const res = await post(`/tasks/${id}/action`, { action: 'start' });
      expect(res.status).toBe(busy ? 409 : 200);
      if (busy) {
        expect(await res.json()).toMatchObject({ error: expect.stringMatching(/merge|busy/i) });
        expect(await row(id)).toMatchObject({ status: 'created' });
        expect(h.add).not.toHaveBeenCalled();
      } else {
        expect(await row(id)).toMatchObject({ status: 'queued' });
        expect(h.add).toHaveBeenCalledTimes(1);
      }
    },
  );

  it('rolls an immediate create back while a cancelled task has a root merge left open', async () => {
    const [merger] = await db
      .insert(schema.tasks)
      .values({
        userId: USER,
        repositoryId: REPO,
        type: 'workflow',
        title: 'merger',
        status: 'cancelled',
      })
      .returning();
    await db.insert(schema.taskEvents).values({
      taskId: merger!.id,
      eventType: 'merge.left_open',
      payload: { dir: '/unused/t363', ref: 'feature', head: 'old', mergeHead: 'incoming' },
    });
    const before = await db.select({ id: schema.tasks.id }).from(schema.tasks);
    const res = await post('/tasks', {
      type: 'workflow',
      repositoryId: REPO,
      title: 'new root task',
      description: 'scratch',
      deferStart: false,
    });
    expect(res.status).toBe(409);
    expect(await db.select({ id: schema.tasks.id }).from(schema.tasks)).toEqual(before);
    expect(h.add).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'persists the count in create and refuses a short start (plan=%s)',
    async (plan) => {
      const id = await create(plan, 3);
      const original = await upload(id);
      await upload(id, original);
      await upload(id, original);
      const before = await row(id);
      const events = await db.select().from(schema.taskEvents);
      expect(before).toMatchObject({ expectedAttachmentCount: 3, status: 'created' });
      const refused = await post(`/tasks/${id}/action`, { action: 'start' });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({
        code: 'task_attachments_missing',
        landed: 1,
        expected: 3,
      });
      expect(await row(id)).toEqual(before);
      expect(await db.select().from(schema.taskEvents)).toEqual(events);
      expect(h.add).not.toHaveBeenCalled();
      const confirmed = await post(`/tasks/${id}/action`, {
        action: 'start',
        confirmMissingAttachments: true,
      });
      expect(await confirmed.json()).toMatchObject({ started: true });
      const startedRow = await row(id);
      const startedEvents = await db.select().from(schema.taskEvents);
      for (const confirmMissingAttachments of [false, true]) {
        const again = await post(`/tasks/${id}/action`, {
          action: 'start',
          confirmMissingAttachments,
        });
        expect(again.status).toBe(200);
        expect(await again.json()).toMatchObject({ started: false });
        expect(await row(id)).toEqual(startedRow);
        expect(await db.select().from(schema.taskEvents)).toEqual(startedEvents);
        expect(h.add).toHaveBeenCalledTimes(1);
      }
    },
  );

  it.each([false, true])(
    'keeps unrecorded and immediate creates compatible (plan=%s)',
    async (plan) => {
      const legacy = await create(plan, undefined);
      expect(await row(legacy)).toMatchObject({ expectedAttachmentCount: null, status: 'created' });
      expect((await post(`/tasks/${legacy}/action`, { action: 'start' })).status).toBe(200);
      const immediate = await create(plan, 5, false);
      expect(await row(immediate)).toMatchObject({
        expectedAttachmentCount: null,
        status: 'queued',
      });
    },
  );

  it('counts equal originals, ignores another task’s uploads, and claims a concurrent start once', async () => {
    const id = await create(false, 2);
    const other = await create(false, 2);
    await upload(other);
    await upload(other);
    expect((await post(`/tasks/${id}/action`, { action: 'start' })).status).toBe(409);
    await upload(id);
    await upload(id);
    const responses = await Promise.all([
      post(`/tasks/${id}/action`, { action: 'start' }),
      post(`/tasks/${id}/action`, { action: 'start' }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const bodies = await Promise.all(
      responses.map((r) => r.json() as Promise<{ started: boolean }>),
    );
    expect(bodies.filter((b) => b.started)).toHaveLength(1);
    expect(h.add).toHaveBeenCalledTimes(1);
  });
});
