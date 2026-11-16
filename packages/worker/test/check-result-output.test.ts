import { expect, it } from 'vitest';
import {
  VERIFY_SKIPPED_OUTPUT,
  canonicalCheckResult,
  finalizeCanonicalCheckResult,
} from '../src/step-engine/check-result-output.js';
it('projects final host loop exhaustion into validation data without reading iterations downstream', () => {
  const value = { verdict: 'VALID', summary: 'checked' };
  expect(finalizeCanonicalCheckResult('07b-phase-4-validate', value, {}, [])).toEqual({
    ...value,
    resultStatus: 'passed',
    exhaustedBudget: false,
  });
  expect(
    finalizeCanonicalCheckResult('07b-phase-4-validate', value, {}, [{ exhaustedBudget: true }]),
  ).toEqual({ ...value, resultStatus: 'incomplete', exhaustedBudget: true });
  expect(
    finalizeCanonicalCheckResult('module.check.validator', value, {}, [{ exhaustedBudget: true }]),
  ).toBe(value);
});
it('projects declared/off/missing slot metadata and keeps an off slot out of missing runners', () => {
  const o = canonicalCheckResult(
    'haive.verify',
    { passed: true },
    {
      test: { source: 'declared' },
      lint: null,
      typecheck: {},
      offSlots: ['lint'],
      declinedConfigs: ['nested', 1],
    },
  );
  expect(o).toMatchObject({
    resultStatus: 'not-run',
    declaredSlots: ['test'],
    offSlots: ['lint'],
    slotWithoutRunner: false,
    declinedConfigs: ['nested'],
  });
});
it('carries the primary framework even when canonical test management was skipped', () => {
  expect(
    canonicalCheckResult('haive.test-management', null, { primary: 'playwright' }, [], 'skipped'),
  ).toEqual({ primary: 'playwright', resultStatus: 'skipped' });
});

it('distinguishes declined commands from runners that could not execute', () => {
  const skipped = { ran: false, passed: false, output: VERIFY_SKIPPED_OUTPUT };
  expect(
    canonicalCheckResult(
      'haive.verify',
      { passed: true, test: skipped },
      { test: { label: 'test' } },
    ),
  ).toMatchObject({ resultStatus: 'declined' });
  expect(
    canonicalCheckResult(
      'haive.verify',
      {
        passed: true,
        test: { ...skipped, output: 'runner unavailable', note: 'runner unavailable' },
      },
      { test: { label: 'test' } },
    ),
  ).toMatchObject({ resultStatus: 'not-run' });
});

it('retains a validator verdict paired with advisory findings without declaring a role pass', () => {
  const value = { verdict: 'VALID', issues: [{ severity: 'low', description: 'advisory' }] };
  expect(finalizeCanonicalCheckResult('07b-phase-4-validate', value, {}, [])).toMatchObject({
    ...value,
    resultStatus: 'incomplete',
    exhaustedBudget: false,
  });
});
