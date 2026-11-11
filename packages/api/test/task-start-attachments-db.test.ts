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

import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { createDatabase, lockRepositoryTasksKey, schema, type Database } from '@haive/database';
import { configService, lockNewWorkFenceExclusive } from '@haive/shared';
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

  it.each(['retry', 'resume'] as const)(
    'refuses root task %s beside a live merge without writes or enqueue',
    async (action) => {
      const id = await create(false, undefined);
      await db
        .update(schema.tasks)
        .set({ status: 'failed', pausedAt: new Date() })
        .where(eq(schema.tasks.id, id));
      const [merger] = await db
        .insert(schema.tasks)
        .values({
          userId: USER,
          repositoryId: REPO,
          type: 'workflow',
          title: 'merger',
          status: 'waiting_user',
        })
        .returning();
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
            mode: 'same-branch',
            phase: 'resolving',
            baseBranch: 'main',
            featureBranch: 'feature',
            mergeDir: '/unused/t363',
          } as never,
        })
        .returning();
      await db
        .insert(schema.mergeDirClaims)
        .values({ mergeDir: '/unused/t363', taskId: merger!.id, taskStepId: step!.id });
      const before = await row(id);
      const response = await post(`/tasks/${id}/action`, { action });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error:
          'A merge is still open in the repository checkout. Finish or abort it, then try again.',
      });
      expect(await row(id)).toEqual(before);
      expect(h.add).not.toHaveBeenCalled();
    },
  );

  it.each([
    'same-branch',
    'cross-branch',
    'done',
    'left-open',
    'settled',
    'skipped',
    'completed',
    'cancelled-pending',
    'cancelled-finished',
  ] as const)('fences root START for %s merge state with a retryable 409', async (kind) => {
    const id = await create(false, undefined);
    const [merger] = await db
      .insert(schema.tasks)
      .values({
        userId: USER,
        repositoryId: REPO,
        type: 'workflow',
        title: 'merger',
        status:
          kind === 'completed'
            ? 'completed'
            : kind === 'left-open' || kind === 'settled' || kind.startsWith('cancelled-')
              ? 'cancelled'
              : 'waiting_user',
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
        status: kind === 'skipped' ? 'skipped' : 'waiting_cli',
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
    if (kind === 'cancelled-finished') {
      await db.insert(schema.taskEvents).values({
        taskId: merger!.id,
        eventType: 'task.cancel_finished',
        payload: {},
      });
    }
    const busy = kind === 'same-branch' || kind === 'left-open' || kind === 'cancelled-pending';
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
  });

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
      responses.map((r) => r.json() as Promise<{ started: boolean; status: string }>),
    );
    expect(bodies.filter((b) => b.started)).toHaveLength(1);
    expect(bodies.find((b) => !b.started)?.status).toBe('queued');
    expect(h.add).toHaveBeenCalledTimes(1);
  });

  // The peer commits at 1.8s, beyond the interactive 1s lock budget. On unchanged
  // source this lets an unbounded wait finish, so the control fails without hanging.
  const besideLock = async <T>(
    lock: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => Promise<unknown>,
    work: () => T | Promise<T>,
  ) => {
    const peer = createDatabase(url!);
    let release!: () => void;
    let ready!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const taken = new Promise<void>((r) => {
      ready = r;
    });
    const holder = peer.transaction(async (tx) => {
      await lock(tx);
      ready();
      await gate;
    });
    await taken;
    const timer = setTimeout(release, 1800);
    try {
      return await work();
    } finally {
      clearTimeout(timer);
      release();
      await holder;
      await peer.$client.end({ timeout: 5 });
    }
  };

  it.each(['creation', 'new-work', 'task-row', 'counted-task-row'] as const)(
    'returns busy without starting behind the %s lock',
    async (kind) => {
      const id = await create(false, kind === 'counted-task-row' ? 0 : undefined);
      h.add.mockClear();
      const before = await row(id);
      const res = await besideLock(
        (tx) =>
          kind === 'creation'
            ? lockRepositoryTasksKey(tx, REPO)
            : kind === 'new-work'
              ? lockNewWorkFenceExclusive(tx)
              : Promise.resolve(tx.execute(sql`select id from tasks where id = ${id} for update`)),
        () => post(`/tasks/${id}/action`, { action: 'start' }),
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: 'The repository is busy, try again' });
      expect(await row(id)).toEqual(before);
      expect(h.add).not.toHaveBeenCalled();
    },
  );

  it('accepts a live clarification while a checkout move holds the creation key', async () => {
    const id = await create(false, undefined);
    await db.update(schema.tasks).set({ status: 'waiting_user' }).where(eq(schema.tasks.id, id));
    const [step] = await db
      .insert(schema.taskSteps)
      .values({
        taskId: id,
        stepId: 'merge',
        title: 'merge',
        stepIndex: 1,
        status: 'waiting_form',
        waitingStartedAt: new Date(),
      })
      .returning();
    h.add.mockClear();
    const res = await besideLock(
      (tx) => lockRepositoryTasksKey(tx, REPO),
      async () => {
        const answer = post(`/tasks/${id}/steps/merge/clarify`, { answer: 'keep mine' });
        return Promise.race([answer, new Promise<null>((r) => setTimeout(() => r(null), 700))]);
      },
    );
    expect(res?.status).toBe(200);
    expect(
      (await db.query.taskSteps.findFirst({ where: eq(schema.taskSteps.id, step!.id) }))
        ?.waitingStartedAt,
    ).toBeNull();
  });

  it('bounds the advisory node lock and inserts no task on contention', async () => {
    const [node] = await db
      .insert(schema.planNodes)
      .values({ repositoryId: REPO, title: 'research', kind: 'research', path: '/research/' })
      .returning();
    const res = await besideLock(
      async (tx) => {
        await tx.execute(sql`select id from plan_nodes where id = ${node!.id} for update`);
      },
      () => post(`/repos/${REPO}/plan/nodes/${node!.id}/advisory`, { question: 'find it' }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'The repository is busy, try again' });
    expect(
      await db.query.tasks.findFirst({ where: eq(schema.tasks.repositoryId, REPO) }),
    ).toBeUndefined();
    expect(h.add).not.toHaveBeenCalled();
  });
});
