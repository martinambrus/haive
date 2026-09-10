import { describe, expect, it } from 'vitest';
import { SKIPPABLE_STEP_IDS } from '@haive/shared';
import { StepRegistry } from '../src/step-engine/registry.js';
import { registerAllSteps } from '../src/step-engine/steps/index.js';

/**
 * `metadata.allowSkip` lives in the worker registry and SKIPPABLE_STEP_IDS in @haive/shared,
 * because the api enforces the Skip action and cannot import the registry. Two lists that
 * must agree, edited in different packages, so only a check catches a one-sided edit — and a
 * one-sided edit fails SILENTLY: the api answers `canSkip: false` and the button never
 * renders, which reads as "this step is not skippable" rather than as a bug.
 *
 * That is not hypothetical. `07c-ddev-reconcile` set `allowSkip: true` in its very first
 * commit (06abea1f, 2026-06-11) and was NEVER added to the shared list, so for three months
 * its Skip button did not exist and the api would have answered 409 — while the "keep in
 * sync" comment sat directly above the list it had drifted from.
 *
 * `registerAllSteps` now carries `assertSkippableListInSync`, so the invariant fails the
 * worker BOOT the way its two sibling constants already did. This test is the CI half of the
 * same check: it fails the PR rather than the deploy, and pins the two cases whose absence
 * would be a silent capability regression.
 */
describe('SKIPPABLE_STEP_IDS mirrors metadata.allowSkip', () => {
  // The production composer, never a hand-written list of registrars or workflow types: such
  // a list is the same shape of second copy this test exists to police, and adding a pipeline
  // without updating it would put that pipeline's steps outside the assertion entirely.
  const registry = new StepRegistry();
  registerAllSteps(registry);

  const declared = registry
    .all()
    .filter((s) => s.metadata.allowSkip === true)
    .map((s) => s.metadata.id)
    .sort();

  it('every step that opts in is in the list the api enforces', () => {
    expect(declared.filter((id) => !SKIPPABLE_STEP_IDS.includes(id))).toEqual([]);
  });

  it('every id in the list is a step that actually opts in', () => {
    // A stale entry is the mirror failure: the api would accept a skip for a step whose
    // definition never sanctioned one.
    expect([...SKIPPABLE_STEP_IDS].filter((id) => !declared.includes(id))).toEqual([]);
  });

  it('the two sets are exactly equal', () => {
    expect([...SKIPPABLE_STEP_IDS].sort()).toEqual(declared);
  });

  it('07c-ddev-reconcile is present — the drift this check exists for', () => {
    expect(SKIPPABLE_STEP_IDS).toContain('07c-ddev-reconcile');
    expect(registry.require('07c-ddev-reconcile').metadata.allowSkip).toBe(true);
  });

  it('08b-test-management is present — its pre-flight gate is a dead end without Skip', () => {
    // The gate parks 08b with a retry-only schema, so a user who cannot supply the missing
    // file has no other way forward.
    expect(SKIPPABLE_STEP_IDS).toContain('08b-test-management');
    expect(registry.require('08b-test-management').metadata.allowSkip).toBe(true);
  });
});
