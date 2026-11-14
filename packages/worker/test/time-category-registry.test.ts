import { expect, it } from 'vitest';
import { TIME_CATEGORY_BY_STEP } from '@haive/shared/timing';
import { StepRegistry } from '../src/step-engine/registry.js';
import { registerWorkflowSteps } from '../src/step-engine/steps/workflow/index.js';

it('classifies every id in the real workflow registry, including constant ids', () => {
  const registry = new StepRegistry();
  registerWorkflowSteps(registry);
  const missing = registry
    .listByWorkflow('workflow')
    .map((s) => s.metadata.id)
    .filter((id) => !Object.hasOwn(TIME_CATEGORY_BY_STEP, id));
  expect(missing).toEqual([]);
});
