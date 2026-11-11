import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  add: vi.fn(async (..._args: unknown[]) => undefined),
  kill: vi.fn(async (_taskId: string) => 0),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: h.add }) }));
vi.mock('../src/lib/sandbox-kill.js', () => ({ killTaskSandboxes: h.kill }));
// The fake database does not implement joins; real claim liveness is covered by
// task-start-attachments-db and the worker's Postgres revival controls.
vi.mock('../../shared/dist/merge-dir-claim.js', () => ({
  liveClaimHolder: async () => ({ id: 'merger', title: 'merger' }),
}));
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
import { taskRoutes } from '../src/routes/tasks/index.js';
import { maintenanceRoutes } from '../src/routes/maintenance.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const TASK = '00000000-0000-4000-8000-000000000001';
const DONE_ROW = '00000000-0000-4000-8000-0000000000c1';
const TARGET_ROW = '00000000-0000-4000-8000-0000000000c2';
const LATER_ROW = '00000000-0000-4000-8000-0000000000c3';

const app = new Hono<AppEnv>();
app.route('/', taskRoutes);
app.route('/admin/maintenance', maintenanceRoutes);
app.onError(errorHandler);
vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');

beforeEach(() => {
  h.add.mockClear();
  h.kill.mockClear();
});

/** A task that failed on `step-b`, the second of three steps, with that row in `target`. */
function setup(target: Record<string, unknown>) {
  const fake = createFakeDb({
    modules: schema.modules,
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
    cliInvocations: schema.cliInvocations,
    taskStepAgentMinings: schema.taskStepAgentMinings,
    taskDagPlans: schema.taskDagPlans,
    stepCatalog: schema.stepCatalog,
    auditEvents: schema.auditEvents,
    repositories: schema.repositories,
    mergeDirClaims: schema.mergeDirClaims,
  });
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    status: 'failed',
    errorMessage: 'boom',
    orchestrationEpoch: 3,
    currentStepId: 'step-b',
    currentRound: 0,
    completedAt: fake.now(),
  });
  const row = (id: string, stepId: string, runSeq: number, values: Record<string, unknown>) =>
    fake.insert(schema.taskSteps, {
      id,
      taskId: TASK,
      stepId,
      stepIndex: runSeq,
      runSeq,
      round: 0,
      title: stepId,
      idleMs: 0,
      carriedWorkMs: 0,
      carriedIdleMs: 0,
      carriedUserActiveMs: 0,
      userActiveMs: 0,
      ...values,
    });
  row(DONE_ROW, 'step-a', 1, { status: 'done', output: { a: 1 } });
  row(TARGET_ROW, 'step-b', 2, target);
  row(LATER_ROW, 'step-c', 3, { status: 'pending' });
  h.db = fake.db;
  const retry = () =>
    app.request(`/${TASK}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'retry' }),
    });
  const step = (id: string) => fake.rows(schema.taskSteps).find((r) => r.id === id)!;
  const task = () => fake.rows(schema.tasks)[0]!;
  return { fake, retry, step, task };
}

const REPO = '00000000-0000-4000-8000-0000000000b1';
const MERGER = '00000000-0000-4000-8000-0000000000e1';
const MERGE_STEP = '00000000-0000-4000-8000-0000000000e2';
const BUSY =
  'A merge is still open in the repository checkout. Finish or abort it, then try again.';

function merging(worktree = false) {
  const t = setup({ status: 'failed', iterationCount: 1 });
  t.fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: 'repo',
    storagePath: '/unused/root',
  });
  t.fake.patch(schema.tasks, TASK, {
    repositoryId: REPO,
    worktreePath: worktree ? '/unused/worktree' : null,
  });
  t.fake.insert(schema.tasks, {
    id: MERGER,
    userId: USER,
    type: 'workflow',
    status: 'waiting_user',
  });
  t.fake.insert(schema.taskSteps, {
    id: MERGE_STEP,
    taskId: MERGER,
    stepId: '12-worktree-cleanup',
    title: 'merge',
    stepIndex: 12,
    round: 0,
    status: 'waiting_cli',
    mergeResolveState: { mode: 'same-branch', phase: 'resolving' },
  });
  t.fake.insert(schema.mergeDirClaims, {
    mergeDir: '/unused/root',
    taskId: MERGER,
    taskStepId: MERGE_STEP,
  });
  return t;
}

const postAction = (path: string, action: string) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  });

describe('root task re-drives during an open same-branch merge', () => {
  it.each([
    'task retry',
    'start retry',
    'task resume',
    'admin resume',
    'step retry',
    'step resume',
    'fanout resume',
    'retry_ai',
  ])('%s refuses before writes, kills or enqueue', async (action) => {
    const t = merging();
    if (action === 'start retry') t.fake.patch(schema.tasks, TASK, { currentStepId: null });
    if (action === 'task resume' || action === 'admin resume')
      t.fake.patch(schema.tasks, TASK, { pausedAt: t.fake.now() });
    if (action === 'fanout resume')
      t.fake.insert(schema.taskStepAgentMinings, { taskStepId: TARGET_ROW, status: 'failed' });
    const before = structuredClone(t.fake.rows(schema.tasks));
    const steps = structuredClone(t.fake.rows(schema.taskSteps));
    const res =
      action === 'task retry' || action === 'start retry'
        ? await t.retry()
        : await postAction(
            action === 'admin resume'
              ? '/admin/maintenance/tasks/' + TASK + '/action'
              : action === 'task resume'
                ? '/' + TASK + '/action'
                : '/' + TASK + '/steps/step-b/action',
            action.split(' ').at(-1)!,
          );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: BUSY });
    expect(t.fake.rows(schema.tasks)).toEqual(before);
    expect(t.fake.rows(schema.taskSteps)).toEqual(steps);
    expect(h.add).not.toHaveBeenCalled();
    expect(h.kill).not.toHaveBeenCalled();
  });
  it('allows a Retry in a separate worktree', async () => {
    const t = merging(true);
    expect((await t.retry()).status).toBe(200);
    expect(h.add).toHaveBeenCalledTimes(1);
  });
  it('allows a root Retry beside a cross-branch merge', async () => {
    const t = merging();
    t.fake.patch(schema.taskSteps, MERGE_STEP, {
      mergeResolveState: { mode: 'cross-branch', phase: 'resolving' },
    });
    expect((await t.retry()).status).toBe(200);
  });
  it.each(['running', 'failed'] as const)(
    'a clarification on a %s task continues the merge only if it does not revive the task',
    async (status) => {
      const t = merging();
      t.fake.patch(schema.tasks, TASK, { status });
      t.fake.patch(schema.taskSteps, TARGET_ROW, {
        status: 'waiting_form',
        waitingStartedAt: t.fake.now(),
      });
      const response = await app.request('/' + TASK + '/steps/step-b/clarify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer: 'resolve the conflict' }),
      });
      expect(response.status).toBe(status === 'running' ? 200 : 409);
      expect(h.add).toHaveBeenCalledTimes(status === 'running' ? 1 : 0);
      if (status === 'failed') expect(await response.json()).toMatchObject({ error: BUSY });
    },
  );
});
