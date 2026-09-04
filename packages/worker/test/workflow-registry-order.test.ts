import { describe, expect, it } from 'vitest';
import { StepRegistry } from '../src/step-engine/registry.js';
import { registerWorkflowSteps } from '../src/step-engine/steps/workflow/index.js';
import { orderWorkflowRunList } from '../src/orchestrator/execution-paths.js';
import type { ExecutionPath } from '@haive/shared';

// Test management must reconcile the suite BEFORE verify runs it, or a stale assertion
// costs an implementation round instead of a test pass. Registry order comes from
// metadata.index, so nothing else in the codebase pins this.
describe('workflow run order: test management before verify', () => {
  const registry = new StepRegistry();
  registerWorkflowSteps(registry);

  const runOrder = (path: ExecutionPath) =>
    orderWorkflowRunList(registry.listByWorkflow('workflow'), [], path).map((s) => s.metadata.id);

  for (const path of ['full_workflow', 'quick_bugfix'] as const) {
    it(`${path}: 07c-ddev-reconcile → 08b-test-management → 08-phase-5-verify`, () => {
      const ids = runOrder(path);
      const reconcile = ids.indexOf('07c-ddev-reconcile');
      const tests = ids.indexOf('08b-test-management');
      const verify = ids.indexOf('08-phase-5-verify');
      expect(reconcile).toBeGreaterThan(-1);
      expect(tests).toBeGreaterThan(reconcile);
      expect(verify).toBeGreaterThan(tests);
    });
  }
});
