import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  add: vi.fn(async (..._args: unknown[]) => undefined),
  kill: vi.fn(async (_taskId: string) => 0),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: h.add }) }));
vi.mock('../src/lib/sandbox-kill.js', () => ({ killTaskSandboxes: h.kill }));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { configService } from '@haive/shared';
import { stepRoutes } from '../src/routes/tasks/steps.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';
import { seedStepCatalog } from './step-flags-fixture.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000d1';
const TASK = '00000000-0000-4000-8000-000000000001';
const STEP_ROW = '00000000-0000-4000-8000-0000000000c1';
const STEP = '11d-skill-sync';

const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  c.set('userId', USER);
  await next();
});
app.route('/', stepRoutes);
app.onError(errorHandler);
vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');

/** A task at `status` whose fan-out step failed with one agent left to re-run. */
function setup(
  status: string,
  stepOver: Record<string, unknown> = {},
  agentOver: Record<string, unknown> = {},
) {
  const fake = createFakeDb({
    modules: schema.modules,
    repositories: schema.repositories,
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
    cliInvocations: schema.cliInvocations,
    taskStepAgentMinings: schema.taskStepAgentMinings,
    taskDagPlans: schema.taskDagPlans,
    stepCatalog: schema.stepCatalog,
  });
  seedStepCatalog(fake);
  fake.insert(schema.repositories, { id: REPO, userId: USER, name: 'repo', status: 'ready' });
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    repositoryId: REPO,
    status,
    orchestrationEpoch: 3,
    currentStepId: STEP,
    currentRound: 0,
  });
  fake.insert(schema.taskSteps, {
    id: STEP_ROW,
    taskId: TASK,
    stepId: STEP,
    stepIndex: 1,
    runSeq: 1,
    round: 0,
    status: 'failed',
    errorMessage: 'boom',
    idleMs: 0,
    ...stepOver,
  });
  fake.insert(schema.taskStepAgentMinings, {
    id: '00000000-0000-4000-8000-000000000001',
    taskStepId: STEP_ROW,
    agentId: 'peer-reviewer',
    status: 'failed',
    ...agentOver,
  });
  h.db = fake.db;
  return fake;
}

async function act(action: 'retry' | 'skip' | 'resume'): Promise<number> {
  const res = await app.request(`/${TASK}/steps/${STEP}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, round: 0 }),
  });
  return res.status;
}

describe('Resume after mining replies were saved', () => {
  beforeEach(() => {
    h.add.mockClear();
    h.kill.mockClear();
  });

  function savedStep(stepStatus = 'failed', agentOver: Record<string, unknown> = {}) {
    return setup(
      'failed',
      {
        status: stepStatus,
        detectOutput: { detected: true },
        formValues: { approved: true },
        iterationCount: 0,
      },
      {
        status: 'done',
        rawOutput: 'Saved reply',
        output: null,
        userRetryRequestedAt: null,
        ...agentOver,
      },
    );
  }

  it('reopens a failed apply with only done agents and queues its fenced continuation', async () => {
    const fake = savedStep();
    expect(await act('resume')).toBe(200);
    expect(fake.rows(schema.taskSteps)[0]).toMatchObject({
      status: 'running',
      detectOutput: { detected: true },
      formValues: { approved: true },
    });
    expect(fake.rows(schema.taskStepAgentMinings)[0]).toMatchObject({
      status: 'done',
      rawOutput: 'Saved reply',
      userRetryRequestedAt: null,
    });
    expect(fake.rows(schema.cliInvocations)).toHaveLength(0);
    expect(fake.rows(schema.tasks)[0]).toMatchObject({ status: 'running', orchestrationEpoch: 4 });
    expect(h.add).toHaveBeenCalledWith(
      'advance-step',
      expect.objectContaining({
        taskId: TASK,
        stepId: STEP,
        round: 0,
        epoch: 4,
      }),
      expect.anything(),
    );
    expect(
      fake.rows(schema.taskEvents).find((r) => r.eventType === 'step.resume')?.payload,
    ).toMatchObject({ retriedAgents: 0 });
  });

  it.each(['09_5-skill-generation', '07b-phase-4-validate'])(
    'keeps the loop Resume arm for %s after fan-out replies have landed',
    async (loop) => {
      const iterations = [{ pass: 1 }, { pass: 2 }];
      const fake = setup(
        'failed',
        { stepId: loop, iterationCount: 2, iterations, formValues: { approved: true } },
        { status: 'done', rawOutput: 'Saved reply', userRetryRequestedAt: null },
      );
      for (const [index, exitCode] of [0, 1].entries()) {
        fake.insert(schema.cliInvocations, {
          id: `00000000-0000-4000-8000-00000000000${index + 5}`,
          taskId: TASK,
          taskStepId: STEP_ROW,
          endedAt: new Date(),
          exitCode,
          consumedAt: null,
          supersededAt: null,
        });
      }
      const response = await app.request(`/${TASK}/steps/${loop}/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'resume', round: 0 }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ resumedFromIteration: 2 });
      expect(fake.rows(schema.taskSteps)[0]).toMatchObject({
        status: 'running',
        iterationCount: 2,
        iterations,
        formValues: { approved: true },
      });
      expect(fake.rows(schema.cliInvocations).every((r) => r.supersededAt instanceof Date)).toBe(
        true,
      );
      expect(fake.rows(schema.taskStepAgentMinings)[0]).toMatchObject({
        status: 'done',
        rawOutput: 'Saved reply',
        userRetryRequestedAt: null,
      });
      expect(fake.rows(schema.taskEvents)[0]?.payload).toMatchObject({ fromIteration: 2 });
      expect(h.add).toHaveBeenCalledWith(
        'advance-step',
        expect.objectContaining({ stepId: loop, epoch: 4 }),
        expect.anything(),
      );
    },
  );

  it.each([null, '', '  \n '])(
    'marks a done row with missing reply %j for re-dispatch',
    async (rawOutput) => {
      const fake = savedStep('failed', { rawOutput });
      expect(await act('resume')).toBe(200);
      expect(fake.rows(schema.taskStepAgentMinings)[0]).toMatchObject({
        status: 'failed',
        userRetryRequestedAt: expect.any(Date),
      });
      expect(
        fake.rows(schema.taskEvents).find((r) => r.eventType === 'step.resume')?.payload,
      ).toMatchObject({ retriedAgents: 1 });
    },
  );

  it('keeps a structured reply even without raw prose', async () => {
    const fake = savedStep('failed', { rawOutput: null, output: { findings: [] } });
    expect(await act('resume')).toBe(200);
    expect(fake.rows(schema.taskStepAgentMinings)[0]!.userRetryRequestedAt).toBeNull();
  });

  it('re-dispatches an empty parsed reply instead of folding it as empty', async () => {
    const fake = savedStep('failed', { output: '   ', rawOutput: null });
    expect(await act('resume')).toBe(200);
    expect(fake.rows(schema.taskStepAgentMinings)[0]!.userRetryRequestedAt).toBeInstanceOf(Date);
  });

  it('marks only failed rows in a mixed fan-out', async () => {
    const fake = savedStep();
    fake.insert(schema.taskStepAgentMinings, {
      id: '00000000-0000-4000-8000-000000000002',
      taskStepId: STEP_ROW,
      agentId: 'security-reviewer',
      status: 'failed',
    });
    expect(await act('resume')).toBe(200);
    expect(fake.rows(schema.taskStepAgentMinings)[0]!.userRetryRequestedAt).toBeNull();
    expect(fake.rows(schema.taskStepAgentMinings)[1]!.userRetryRequestedAt).toBeInstanceOf(Date);
  });

  it('Retry still discards every saved mining row', async () => {
    const fake = savedStep();
    expect(await act('retry')).toBe(200);
    expect(fake.rows(schema.taskStepAgentMinings)).toHaveLength(0);
    expect(fake.rows(schema.taskSteps)[0]!.status).toBe('pending');
  });

  it('refuses an already done step with all agents done', async () => {
    const fake = savedStep('done');
    expect(await act('resume')).toBe(409);
    expect(fake.rows(schema.taskSteps)[0]!.status).toBe('done');
    expect(h.add).not.toHaveBeenCalled();
  });

  it('refuses when another action changed the step before its row lock', async () => {
    const fake = savedStep();
    const transaction = fake.db.transaction.bind(fake.db);
    vi.spyOn(fake.db, 'transaction').mockImplementationOnce(async (fn) => {
      await fake.db
        .update(schema.taskSteps)
        .set({ status: 'done' })
        .where(eq(schema.taskSteps.id, STEP_ROW));
      return transaction(fn);
    });
    expect(await act('resume')).toBe(409);
    expect(fake.rows(schema.taskSteps)[0]!.status).toBe('done');
    expect(fake.rows(schema.tasks)[0]!.orchestrationEpoch).toBe(3);
    expect(h.add).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'completed'])(
    'keeps a %s task ended when all replies are saved',
    async (status) => {
      const fake = savedStep();
      await fake.db.update(schema.tasks).set({ status }).where(eq(schema.tasks.id, TASK));
      expect(await act('resume')).toBe(409);
      expect(fake.rows(schema.taskSteps)[0]!.status).toBe('failed');
      expect(fake.rows(schema.tasks)[0]).toMatchObject({ status, orchestrationEpoch: 3 });
      expect(h.add).not.toHaveBeenCalled();
      expect(h.kill).not.toHaveBeenCalled();
    },
  );

  it('refuses while any sibling is still working', async () => {
    const fake = savedStep();
    fake.insert(schema.taskStepAgentMinings, {
      id: '00000000-0000-4000-8000-000000000002',
      taskStepId: STEP_ROW,
      agentId: 'security-reviewer',
      status: 'running',
    });
    expect(await act('resume')).toBe(409);
    expect(h.add).not.toHaveBeenCalled();
    expect(h.kill).not.toHaveBeenCalled();
  });
});
