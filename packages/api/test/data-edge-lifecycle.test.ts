import { expect, it, vi } from 'vitest';
import { buildDataEdgePlan } from '@haive/shared/data-edge-plan';
import { SPEC_ROLES } from '@haive/shared/step-outputs';
import { dataPortNodes } from '@haive/shared/step-ports';
import { createFakeDb } from '@haive/database/testing';
import { schema } from '@haive/database';
import { configService } from '@haive/shared';
import { Hono } from 'hono';
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  add: vi.fn(async () => undefined),
  kill: vi.fn(async () => 0),
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: h.add }) }));
vi.mock('../src/lib/sandbox-kill.js', () => ({ killTaskSandboxes: h.kill }));
const USER = '00000000-0000-4000-8000-000000000001';
const TASK = '00000000-0000-4000-8000-000000000002';
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
    c.set('userId', USER);
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => Promise<void>) => next(),
}));
import { taskRoutes } from '../src/routes/tasks/index.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { stopActiveCliInvocations } from '../src/lib/task-control.js';
import type { AppEnv } from '../src/context.js';
vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
it.each(['Stop/Resume', 'step Retry', 'full task Retry'] as const)(
  'keeps the exact v3 edge through %s via the real routes',
  async (action) => {
    const fake = createFakeDb({
      modules: schema.modules,
      stepCatalog: schema.stepCatalog,
      repositories: schema.repositories,
      tasks: schema.tasks,
      taskSteps: schema.taskSteps,
      taskEvents: schema.taskEvents,
      cliInvocations: schema.cliInvocations,
      taskStepAgentMinings: schema.taskStepAgentMinings,
      taskDagPlans: schema.taskDagPlans,
      taskStepCliChoices: schema.taskStepCliChoices,
      taskDatabaseStates: schema.taskDatabaseStates,
    });
    h.db = fake.db;
    const ids = ['04-phase-0b-pre-planning', '05-phase-0b5-spec-quality'];
    const plan = buildDataEdgePlan('static', [{ executionPath: null, nodes: dataPortNodes(ids) }]);
    fake.insert(schema.repositories, { id: USER, userId: USER, name: 'repo', status: 'ready' });
    fake.insert(schema.tasks, {
      id: TASK,
      userId: USER,
      repositoryId: USER,
      type: 'workflow',
      status: 'running',
      orchestrationEpoch: 3,
      currentStepId: ids[1],
      currentRound: 0,
      runListSnapshot: ids,
      dataEdgePlan: plan,
    });
    const step = fake.insert(schema.taskSteps, {
      taskId: TASK,
      stepId: ids[1],
      stepIndex: 2,
      runSeq: 2,
      title: 'Quality',
      round: 0,
      status: 'waiting_cli',
      iterationCount: 1,
      iterations: [{ iteration: 0 }],
      detectOutput: { spec: 'pinned' },
    });
    const app = new Hono<AppEnv>();
    app.route('/tasks', taskRoutes);
    app.onError(errorHandler);
    const act = async (path: string, action: string) =>
      app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, round: 0 }),
      });
    const unchanged = () => expect(fake.rows(schema.tasks)[0]!.dataEdgePlan).toEqual(plan);
    fake.insert(schema.taskSteps, {
      taskId: TASK,
      stepId: ids[0],
      round: 0,
      status: 'done',
      output: { spec: 'pinned current round' },
      iterations: [],
    });
    fake.insert(schema.taskSteps, {
      taskId: TASK,
      stepId: ids[0],
      round: 2,
      status: 'done',
      output: { spec: 'future decoy' },
      iterations: [],
    });
    if (action === 'Stop/Resume') {
      await stopActiveCliInvocations(fake.db as never, TASK, { failTask: true });
      unchanged();
      expect(fake.rows(schema.tasks)[0]!.status).toBe('failed');
      expect((await act(`/tasks/${TASK}/steps/${ids[1]}/action`, 'resume')).status).toBe(200);
    } else if (action === 'step Retry') {
      expect((await act(`/tasks/${TASK}/steps/${ids[1]}/action`, 'retry')).status).toBe(200);
    } else {
      fake.patch(schema.tasks, TASK, { status: 'failed' });
      fake.patch(schema.taskSteps, String(step.id), { status: 'failed' });
      expect((await act(`/tasks/${TASK}/action`, 'retry')).status).toBe(200);
    }
    unchanged();
    // Exercise the worker reader as well as storage: a future success must never replace
    // this consumer's current-round producer after any recovery action.
    const { readRole } = (await import(
      new URL('../../worker/src/step-engine/read-role.js', import.meta.url).href
    )) as { readRole: (ctx: unknown, role: typeof SPEC_ROLES.draft) => Promise<unknown> };
    expect(
      await readRole(
        { db: fake.db, taskId: TASK, taskStepId: step.id, round: 0 },
        SPEC_ROLES.draft,
      ),
    ).toMatchObject({
      state: 'ready',
      producer: { stepId: ids[0], round: 0 },
      data: { spec: 'pinned current round' },
    });
    expect(h.add).toHaveBeenCalled();
  },
);
