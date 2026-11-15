import { describe, expect, it, vi } from 'vitest';
import { createFakeDb } from '@haive/database/testing';
import { schema } from '@haive/database';
import { EXECUTION_PATHS } from '@haive/shared';
import { parseDerivedRunPlan } from '@haive/shared/modularity';
import { CORE_COMPOSABLE_STEPS } from '../src/step-engine/composable-core.js';
import { pinDerivedWorkflowPath } from '../src/step-engine/derived-path.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';

vi.mock('../src/step-engine/step-ownership.js', async (original) => ({
  ...(await original<object>()),
  lockOwnedStep: async () => true,
}));

const prefix = ['00-model-health-workflow', '00a-sync-base', '00-triage'];
const verify = '08-phase-5-verify';
const review = '08c-code-review';
const triage = '08e-insights-triage';

describe('derived first-triage composition recheck', () => {
  it.each([
    { order: [review, verify, triage], refused: true },
    { order: [verify, review, triage], refused: false },
    { order: [review, verify], refused: false },
  ])('rechecks the pinned token-provider order: $order', async ({ order, refused }) => {
    const stepIds = [...prefix, '01-worktree-setup', '07-phase-2-implement', ...order];
    const candidates = [null, ...EXECUTION_PATHS].map((executionPath) => ({
      executionPath,
      stepIds,
    }));
    const plan = parseDerivedRunPlan({
      version: 1,
      base: {
        slug: 'workflow',
        runListStrategy: 'workflow_paths',
        candidates,
        catalogFingerprint: 'test',
      },
      overlay: { revision: 'test', changes: [] },
      requiresRepository: true,
      composableEntries: CORE_COMPOSABLE_STEPS.filter((entry) => stepIds.includes(entry.stepId)),
      candidates: candidates.map((candidate) => ({
        ...candidate,
        outcomes: [],
        compositionIssues: [],
      })),
      commonPrefix: prefix,
      warnings: [],
    });
    const fake = createFakeDb({
      tasks: schema.tasks,
      taskSteps: schema.taskSteps,
      taskEvents: schema.taskEvents,
    });
    const task = fake.insert(schema.tasks, {
      type: 'derived-test',
      derivedRunPlan: plan,
      status: 'running',
      currentStepId: '00-triage',
      currentRound: 0,
      orchestrationEpoch: 3,
      executionPath: null,
      deadAt: null,
      customSteps: {},
      stepLoopLimits: {},
      preAnswers: {},
      runListSnapshot: stepIds,
    });
    const step = fake.insert(schema.taskSteps, { taskId: task.id, stepId: '00-triage', round: 0 });
    const registry = { get: (id: string) => ({ metadata: { id } }) as StepDefinition };
    const selecting = pinDerivedWorkflowPath(
      {
        db: fake.db as unknown as Parameters<typeof pinDerivedWorkflowPath>[0]['db'],
        taskId: task.id as string,
        taskStepId: step.id as string,
        round: 0,
        epoch: 3,
      },
      'full_workflow',
      false,
      registry,
    );
    if (refused) {
      await expect(selecting).rejects.toMatchObject({ code: 'invalid-derived-run-plan' });
      expect(fake.rows(schema.tasks)[0]!.executionPath).toBeNull();
      expect(fake.rows(schema.taskEvents)).toEqual([]);
    } else {
      await expect(selecting).resolves.toEqual({ path: 'full_workflow', broadAudit: false });
      expect(fake.rows(schema.tasks)[0]!.runListSnapshot).toEqual(stepIds);
    }
  });
});
