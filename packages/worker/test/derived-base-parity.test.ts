import { beforeAll, describe, expect, it } from 'vitest';
import { EXECUTION_PATHS } from '@haive/shared';
import {
  taskRunListIds,
  workflowBaseCandidates,
  catalogWorkflowBaseCandidates,
  baseCandidateParityIssues,
} from '@haive/shared/run-list';
import { evaluateDerivedTaskType } from '@haive/shared/modularity';
import { registerStepsOnce } from '../src/step-engine/boot.js';
import { stepRegistry } from '../src/step-engine/registry.js';
import { CORE_COMPOSABLE_STEPS } from '../src/step-engine/composable-core.js';

describe('derived workflow registry/catalog parity', () => {
  beforeAll(() => registerStepsOnce());
  it('matches taskRunListIds on the real registry for null and every path including the prelude', () => {
    const source = (type: string) =>
      stepRegistry.listByWorkflow(type).map((step) => step.metadata.id);
    const expected = [null, ...EXECUTION_PATHS].map((executionPath) => ({
      executionPath,
      stepIds: taskRunListIds(
        {
          workflowType: 'workflow',
          runListStrategy: 'workflow_paths',
          runListSnapshot: null,
          executionPath,
        },
        source,
      ),
    }));
    const rows = stepRegistry
      .all()
      .map(({ metadata }) => ({
        stepId: metadata.id,
        workflowType: metadata.workflowType,
        stepIndex: metadata.index,
      }))
      .reverse();
    expect(workflowBaseCandidates(source)).toEqual(expected);
    const fromCatalog = catalogWorkflowBaseCandidates(rows);
    expect(baseCandidateParityIssues(expected, fromCatalog)).toEqual([]);
    const result = evaluateDerivedTaskType({
      baseCandidates: fromCatalog,
      changes: [],
      catalog: new Map(CORE_COMPOSABLE_STEPS.map((e) => [e.stepId, e])),
      installedStepIds: new Set(stepRegistry.all().map((s) => s.metadata.id)),
    });
    expect(result.issues).toEqual([]);
    expect(
      result.candidates.map(({ executionPath, stepIds }) => ({ executionPath, stepIds })),
    ).toEqual(expected);
    for (const candidate of result.candidates) {
      expect(candidate.stepIds.slice(3, 7)).toEqual(source('env_replicate'));
      expect(candidate.compositionIssues).toEqual([]);
    }
  });
});
