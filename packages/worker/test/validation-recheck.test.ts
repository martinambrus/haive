import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import type { StepDefinition } from '../src/step-engine/step-definition.js';
import type { ResolvedTaskContext } from '../src/queues/run-list.js';
import { validationSuccessor } from '../src/queues/validation-recheck.js';

const h = vi.hoisted(() => ({ snapshot: vi.fn() }));
vi.mock('../src/step-engine/steps/workflow/_validation-snapshot.js', async (original) => ({
  ...(await original<typeof import('../src/step-engine/steps/workflow/_validation-snapshot.js')>()),
  readValidationSnapshot: h.snapshot,
}));

const VALIDATE = '07b-phase-4-validate';
const RECONCILE = '07c-ddev-reconcile';
const step = (id: string) => ({ metadata: { id } }) as StepDefinition;
const ctx = { taskId: 'task' } as ResolvedTaskContext;

describe('validation successor runtime hand-off', () => {
  it.each([0, 1])(
    'reconciles a validator fixer at round %s and keeps its return address',
    async (round) => {
      const steps = [step(RECONCILE), step(VALIDATE), step('verify'), step('commit')];
      const db = {
        query: {
          tasks: { findFirst: vi.fn().mockResolvedValue({ maxFixRounds: 2 }) },
          taskEvents: {
            findFirst: vi.fn().mockResolvedValue(
              round
                ? {
                    payload: { resumeStepId: 'commit' },
                  }
                : undefined,
            ),
          },
        },
      } as unknown as Database;
      Object.assign(db, {
        select: () => ({
          from: () => ({ leftJoin: () => ({ where: async () => [{ n: round }] }) }),
        }),
      });
      h.snapshot.mockResolvedValue({ '.ddev/config.yaml': 'after' });
      expect(
        await validationSuccessor(db, ctx, VALIDATE, round, steps, {
          runtimeChanged: true,
          validationSnapshot: { '.ddev/config.yaml': 'before' },
        }),
      ).toEqual({
        next: steps[0],
        round: round + 1,
        recheck: {
          sourceStepId: VALIDATE,
          resumeStepId: round ? 'commit' : 'verify',
          affectedFiles: ['.ddev/config.yaml'],
        },
      });
    },
  );
  it.each([0, 2])('restores ordinary verdict routing after %s runtime hand-offs', async (cap) => {
    const steps = [step(RECONCILE), step(VALIDATE), step('verify')];
    const db = {
      query: {
        tasks: { findFirst: vi.fn().mockResolvedValue({ maxFixRounds: cap }) },
        taskEvents: { findFirst: vi.fn().mockResolvedValue(undefined) },
      },
      select: () => ({
        from: () => ({ leftJoin: () => ({ where: async () => [{ n: cap }] }) }),
      }),
    } as unknown as Database;
    h.snapshot.mockClear();
    expect(
      await validationSuccessor(db, ctx, VALIDATE, cap, steps, { runtimeChanged: true }),
    ).toEqual({ next: steps[2], round: cap, evaluateFixLoop: true });
    expect(h.snapshot).not.toHaveBeenCalled();
  });

  it.each([{ tail: [] }, { tail: [step(RECONCILE)] }])(
    'restores ordinary routing without an earlier reconciliation step: %j',
    async ({ tail }) => {
      const steps = [step(VALIDATE), ...tail, step('commit')];
      h.snapshot.mockClear();
      expect(
        await validationSuccessor({} as Database, ctx, VALIDATE, 0, steps, {
          runtimeChanged: true,
        }),
      ).toEqual({ next: steps[1], round: 0, evaluateFixLoop: true });
      expect(h.snapshot).not.toHaveBeenCalled();
    },
  );
});

describe('insight validation composition', () => {
  it.each([true, false])(
    'moved=%s returns through verification, never past the editor',
    async (moved) => {
      const steps = [
        step(RECONCILE),
        step(VALIDATE),
        step('08-phase-5-verify'),
        step('08c-code-review'),
        { ...step('08e-insights-triage'), editsCodeOrTests: true },
        step('10-gate-3-commit'),
      ];
      const db = {
        query: {
          taskSteps: {
            findFirst: vi
              .fn()
              .mockResolvedValue({ output: { validationSnapshot: { 'a.ts': 'before' } } }),
          },
        },
      } as unknown as Database;
      h.snapshot.mockResolvedValue({ 'a.ts': moved ? 'after' : 'before' });
      const route = await validationSuccessor(
        db,
        ctx,
        '08e-insights-triage',
        4,
        steps,
        {},
        '08-phase-5-verify',
      );
      expect(route).toEqual(
        moved
          ? {
              next: steps[0],
              round: 5,
              recheck: {
                sourceStepId: '08e-insights-triage',
                resumeStepId: '08-phase-5-verify',
                affectedFiles: ['a.ts'],
              },
            }
          : { next: steps[5], round: 4 },
      );
      if (moved) {
        const resumedDb = {
          query: {
            taskEvents: { findFirst: vi.fn().mockResolvedValue({ payload: route.recheck }) },
          },
        } as unknown as Database;
        expect(await validationSuccessor(resumedDb, ctx, VALIDATE, 5, steps, {})).toEqual({
          next: steps[2],
          round: 5,
        });
      }
    },
  );
});

it('a module validation data binding cannot replace the physical recheck snapshot or fix target', async () => {
  const taskId = 'aaaaaaaa-0000-4000-8000-000000000001';
  const routingCtx = { taskId } as ResolvedTaskContext;
  const { schema } = await import('@haive/database');
  const { createFakeDb } = await import('@haive/database/testing');
  const { buildDataEdgePlan } = await import('@haive/shared/data-edge-plan');
  const { dataPortNodes } = await import('@haive/shared/step-ports');
  const { finishedRoutingVerdict } = await import('../src/step-engine/step-runner.js');
  const { phase4ValidateStep } =
    await import('../src/step-engine/steps/workflow/07b-phase-4-validate.js');
  const { FIX_LOOP_TARGET_STEP_ID } =
    await import('../src/step-engine/steps/workflow/_fix-loop.js');
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
  });
  fake.insert(schema.tasks, { id: taskId });
  fake.insert(schema.taskSteps, {
    id: 'bbbbbbbb-0000-4000-8000-000000000001',
    taskId,
    stepId: VALIDATE,
    round: 0,
    status: 'done',
    output: { validationSnapshot: { 'a.ts': 'same' } },
  });
  fake.insert(schema.taskSteps, {
    id: 'bbbbbbbb-0000-4000-8000-000000000002',
    taskId,
    stepId: 'module.check.validator',
    round: 0,
    status: 'done',
    output: { validationSnapshot: { 'a.ts': 'poison' }, verdict: 'VALID' },
  });
  const steps = [
    step(RECONCILE),
    step(VALIDATE),
    step('module.check.validator'),
    { ...step('editor'), editsCodeOrTests: true },
    step('09-gate-2-verify-approval'),
  ];
  const output = {
    verdict: 'ISSUES_FOUND',
    issues: [{ severity: 'high', file: 'a.ts', description: 'broken' }],
    fixesApplied: [],
    churnFiles: [],
    converged: true,
  };
  h.snapshot.mockResolvedValue({ 'a.ts': 'same' });
  const before = JSON.stringify({
    recheck: await validationSuccessor(
      fake.db as unknown as Database,
      routingCtx,
      'editor',
      0,
      steps,
      {},
    ),
    fix: await finishedRoutingVerdict(
      fake.db as unknown as Database,
      taskId,
      phase4ValidateStep,
      output,
    ),
  });
  const role = 'haive.validation' as const;
  const nodes = dataPortNodes(
    steps.map((s) => s.metadata.id),
    {},
    new Map([
      ['module.check.validator', { providesRoles: [{ role, contract: { id: role, version: 1 } }] }],
    ]),
  );
  fake.patch(schema.tasks, taskId, {
    dataEdgePlan: buildDataEdgePlan('static', [
      { executionPath: null, nodes, bindings: { '4:validation': 2 } },
    ]),
  });
  expect(
    JSON.stringify({
      recheck: await validationSuccessor(
        fake.db as unknown as Database,
        routingCtx,
        'editor',
        0,
        steps,
        {},
      ),
      fix: await finishedRoutingVerdict(
        fake.db as unknown as Database,
        taskId,
        phase4ValidateStep,
        output,
      ),
    }),
  ).toBe(before);
  expect(before).toContain('loop_back');
  expect(before).not.toContain('recheck_requested');
  expect(FIX_LOOP_TARGET_STEP_ID).toBe('07-phase-2-implement');
});
