import { describe, expect, it } from 'vitest';
import { StepRegistry } from '../src/step-engine/registry.js';
import { registerWorkflowSteps } from '../src/step-engine/steps/workflow/index.js';
import { orderWorkflowRunList } from '../src/orchestrator/execution-paths.js';
import type { ExecutionPath } from '@haive/shared';
import { registerOnboardingSteps } from '../src/step-engine/steps/onboarding/index.js';

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

describe('workflow RAG scope precedes indexing', () => {
  const registry = new StepRegistry();
  registerWorkflowSteps(registry);
  for (const path of ['full_workflow', 'quick_bugfix', 'plan_tasklist'] as const) {
    it(`${path}: pre-sync is immediately preceded by its scope picker`, () => {
      const ids = orderWorkflowRunList(registry.listByWorkflow('workflow'), [], path).map(
        (s) => s.metadata.id,
      );
      expect(ids.indexOf('01g-rag-source-selection')).toBeGreaterThan(-1);
      expect(ids.indexOf('02-pre-rag-sync')).toBe(ids.indexOf('01g-rag-source-selection') + 1);
    });
  }
  it('quick_bugfix has no end-of-task ingestion', () => {
    const ids = orderWorkflowRunList(registry.listByWorkflow('workflow'), [], 'quick_bugfix').map(
      (s) => s.metadata.id,
    );
    expect(ids.indexOf('11b1-rag-source-selection')).toBeGreaterThan(
      ids.indexOf('10-gate-3-commit'),
    );
    expect(ids.indexOf('11b1-rag-source-selection')).toBeLessThan(
      ids.indexOf('12-worktree-cleanup'),
    );
    expect(ids).not.toContain('11c-rag-reindex');
  });
  it('onboarding population is immediately preceded by its scope picker', () => {
    const onboarding = new StepRegistry();
    registerOnboardingSteps(onboarding);
    const ids = onboarding.listByWorkflow('onboarding').map((s) => s.metadata.id);
    expect(ids.indexOf('10-rag-populate')).toBe(ids.indexOf('09_7-rag-source-selection') + 1);
  });
  for (const path of ['full_workflow', 'plan_tasklist'] as const) {
    it(`${path}: KB commit → RAG scope → re-index`, () => {
      const ids = orderWorkflowRunList(registry.listByWorkflow('workflow'), [], path).map(
        (s) => s.metadata.id,
      );
      expect(ids.indexOf('11b1-rag-source-selection')).toBe(ids.indexOf('11b-kb-commit') + 1);
      expect(ids.indexOf('11c-rag-reindex')).toBe(ids.indexOf('11b1-rag-source-selection') + 1);
    });
  }
});
