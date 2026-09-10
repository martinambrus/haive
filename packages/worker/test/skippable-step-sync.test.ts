import { describe, expect, it } from 'vitest';
import { SKIPPABLE_STEP_IDS } from '@haive/shared';
import { StepRegistry } from '../src/step-engine/registry.js';
import { registerWorkflowSteps } from '../src/step-engine/steps/workflow/index.js';

/**
 * `metadata.allowSkip` lives in the worker registry and SKIPPABLE_STEP_IDS lives in
 * @haive/shared, because the api enforces the Skip action and cannot import the registry.
 * Two lists that must agree and are edited in different packages, so nothing but a test
 * catches a one-sided edit — and a one-sided edit fails SILENTLY: the button simply never
 * renders (the api answers `canSkip: false`), which reads as "this step is not skippable"
 * rather than as a bug.
 *
 * Scoped to 08b because the pre-flight gate DEPENDS on it: that gate parks the step with a
 * retry-only schema, so without a Skip button it is a dead end for anyone who cannot supply
 * the missing file. A broader assertion over every allowSkip step is not made here — the two
 * lists have already drifted for 07c-ddev-reconcile, which sets allowSkip but is absent from
 * the shared list, and reconciling that is a separate behaviour change for a separate review.
 */
describe('08b Skip action: worker metadata and the shared list agree', () => {
  const registry = new StepRegistry();
  registerWorkflowSteps(registry);

  it('the step definition opts in', () => {
    expect(registry.require('08b-test-management').metadata.allowSkip).toBe(true);
  });

  it('the api-side list the Skip handler enforces carries it too', () => {
    expect(SKIPPABLE_STEP_IDS).toContain('08b-test-management');
  });
});
