import { describe, expect, it } from 'vitest';
import { StepRegistry } from '../src/step-engine/registry.js';
import { registerWorkflowSteps } from '../src/step-engine/steps/workflow/index.js';
import { orderWorkflowRunList } from '../src/orchestrator/execution-paths.js';
import { resolveFixLoopTarget } from '../src/queues/run-list.js';
import { FIX_LOOP_TARGET_STEP_ID } from '../src/step-engine/steps/workflow/_fix-loop.js';
import type { ExecutionPath } from '@haive/shared';

const registry = new StepRegistry();
registerWorkflowSteps(registry);

describe('resolveFixLoopTarget', () => {
  for (const path of [
    'full_workflow',
    'quick_bugfix',
    'plan_tasklist',
  ] as const satisfies readonly ExecutionPath[]) {
    it(`resolves to the implement step on the ${path} run list`, () => {
      const runList = orderWorkflowRunList(registry.listByWorkflow('workflow'), [], path);
      const resolved = resolveFixLoopTarget({
        taskType: 'workflow',
        fixLoop: null,
        runList,
        registry,
      });
      expect(resolved.ok).toBe(true);
      if (resolved.ok) expect(resolved.def.metadata.id).toBe(FIX_LOOP_TARGET_STEP_ID);
    });
  }

  it('fails by name when the run list lacks the default target', () => {
    const runList = ['01-worktree-setup', '08c-code-review'].map((id) => registry.require(id));
    const resolved = resolveFixLoopTarget({ taskType: 'custom', fixLoop: null, runList, registry });
    expect(resolved).toEqual({
      ok: false,
      reason: `fix loop target ${FIX_LOOP_TARGET_STEP_ID} is not in the run list of task type custom`,
    });
  });

  it('fails by name when the configured target is another step, even one in the run list', () => {
    const runList = orderWorkflowRunList(registry.listByWorkflow('workflow'), [], 'full_workflow');
    const resolved = resolveFixLoopTarget({
      taskType: 'workflow',
      fixLoop: {
        targetStepId: '08c-code-review',
        humanRejectSourceStepIds: [],
        honoredConstraintSourceStepIds: [],
      },
      runList,
      registry,
    });
    expect(runList.some((s) => s.metadata.id === '08c-code-review')).toBe(true);
    expect(resolved).toEqual({
      ok: false,
      reason: `fix loop target 08c-code-review of task type workflow cannot read the fix diagnosis; only ${FIX_LOOP_TARGET_STEP_ID} can`,
    });
  });

  it('fails by name when the configured target is not registered', () => {
    const runList = orderWorkflowRunList(registry.listByWorkflow('workflow'), [], 'full_workflow');
    const resolved = resolveFixLoopTarget({
      taskType: 'workflow',
      fixLoop: {
        targetStepId: '99-ghost',
        humanRejectSourceStepIds: [],
        honoredConstraintSourceStepIds: [],
      },
      runList,
      registry,
    });
    expect(resolved).toEqual({
      ok: false,
      reason: `fix loop target 99-ghost of task type workflow cannot read the fix diagnosis; only ${FIX_LOOP_TARGET_STEP_ID} can`,
    });
  });
});
