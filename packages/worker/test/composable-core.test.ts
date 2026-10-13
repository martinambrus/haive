import { beforeAll, describe, expect, it } from 'vitest';
import { validateComposition, type ComposableStepEntry } from '@haive/shared/modularity';
import { registerStepsOnce } from '../src/step-engine/boot.js';
import {
  assertCoreComposableCatalog,
  CORE_COMPOSABLE_STEPS,
  MERGE_CAPABLE_STEP_IDS,
} from '../src/step-engine/composable-core.js';
import { stepRegistry } from '../src/step-engine/registry.js';

const catalog = new Map(CORE_COMPOSABLE_STEPS.map((e) => [e.stepId, e] as const));
const replace = (stepId: string, patch: Partial<ComposableStepEntry>): ComposableStepEntry[] =>
  CORE_COMPOSABLE_STEPS.map((e) => (e.stepId === stepId ? { ...e, ...patch } : e));

describe('core composable catalog', () => {
  beforeAll(() => registerStepsOnce());

  it('holds the 30 curated steps and passes the assert on the real registry', () => {
    expect(CORE_COMPOSABLE_STEPS).toHaveLength(30);
    expect(() => assertCoreComposableCatalog(stepRegistry)).not.toThrow();
  });

  it('lists the two merge-capable steps explicitly', () => {
    expect([...MERGE_CAPABLE_STEP_IDS].sort()).toEqual(['00a-sync-base', '12-worktree-cleanup']);
  });

  it('throws naming a step that is not registered', () => {
    const bad = replace('01-debug-mode', { stepId: '99-not-a-step' });
    expect(() => assertCoreComposableCatalog(stepRegistry, bad)).toThrow(/99-not-a-step/);
  });

  it('throws naming a step whose dispatchesCli disagrees with the registry', () => {
    const bad = replace('01-debug-mode', { dispatchesCli: true });
    expect(() => assertCoreComposableCatalog(stepRegistry, bad)).toThrow(/01-debug-mode/);
  });

  it('throws for a merge-capable step marked not dispatching', () => {
    const bad = replace('12-worktree-cleanup', { dispatchesCli: false });
    expect(() => assertCoreComposableCatalog(stepRegistry, bad)).toThrow(/12-worktree-cleanup/);
  });

  it('throws naming a need that no entry provides', () => {
    const bad = replace('04-verify-environment', {
      requires: [{ needs: 'nobody-provides-this', reason: 'x' }],
    });
    expect(() => assertCoreComposableCatalog(stepRegistry, bad)).toThrow(
      /04-verify-environment.*nobody-provides-this/,
    );
  });

  it('throws naming a loop target that is not in the catalog', () => {
    const bad = replace('08-phase-5-verify', { loopTargetStepId: '99-not-in-catalog' });
    expect(() => assertCoreComposableCatalog(stepRegistry, bad)).toThrow(/08-phase-5-verify/);
  });

  it('throws naming an entry the schema rejects', () => {
    const bad = replace('01-debug-mode', { label: '' });
    expect(() => assertCoreComposableCatalog(stepRegistry, bad)).toThrow(/01-debug-mode/);
  });

  it('throws when a looping step declares no loop target', () => {
    const bad = replace('08-phase-5-verify', { loopTargetStepId: undefined });
    expect(() => assertCoreComposableCatalog(stepRegistry, bad)).toThrow(
      /08-phase-5-verify must declare a loop target exactly when its step loops/,
    );
  });

  it('throws when a fix-loop step targets anything but the implement step', () => {
    const bad = replace('08-phase-5-verify', { loopTargetStepId: '04-phase-0b-pre-planning' });
    expect(() => assertCoreComposableCatalog(stepRegistry, bad)).toThrow(
      /08-phase-5-verify loops back to 07-phase-2-implement/,
    );
  });

  it('marks the four finish steps as closing', () => {
    const closing = CORE_COMPOSABLE_STEPS.filter((e) => e.closes).map((e) => e.stepId);
    expect(closing.sort()).toEqual(
      ['10-gate-3-commit', '11a-gate-4-push', '12-worktree-cleanup', '13-pr-wait'].sort(),
    );
  });

  it('rejects a verify step placed after the commit', () => {
    const order = [
      '01-worktree-setup',
      '07-phase-2-implement',
      '10-gate-3-commit',
      '08-phase-5-verify',
    ];
    expect(validateComposition(order, catalog)).toEqual([
      {
        kind: 'loop-after-closing',
        index: 3,
        stepId: '08-phase-5-verify',
        closingStepId: '10-gate-3-commit',
      },
    ]);
  });

  it('accepts a worktree, implement, verify, commit order', () => {
    const order = [
      '01-worktree-setup',
      '07-phase-2-implement',
      '08-phase-5-verify',
      '10-gate-3-commit',
    ];
    expect(validateComposition(order, catalog)).toEqual([]);
  });

  it('accepts learning capture after the commit, as the built-in workflow runs it', () => {
    const order = [
      '01-worktree-setup',
      '07-phase-2-implement',
      '10-gate-3-commit',
      '11-phase-8-learning',
    ];
    expect(validateComposition(order, catalog)).toEqual([]);
  });

  it('rejects plugin installation before the worktree step', () => {
    const issues = validateComposition(['01b-install-plugins', '01-worktree-setup'], catalog);
    expect(issues).toEqual([
      expect.objectContaining({
        kind: 'unmet-need',
        stepId: '01b-install-plugins',
        needs: 'worktree',
      }),
    ]);
  });

  const runtimeSetup: Record<string, string[]> = {
    '01c-ddev-env': ['01-declare-deps', '01-worktree-setup'],
    '01a-app-boot': [
      '01-declare-deps',
      '02-generate-dockerfile',
      '03-build-image',
      '01-worktree-setup',
    ],
  };

  it.each([
    ['01c-ddev-env', '01-debug-mode'],
    ['01c-ddev-env', '01d-browser-access'],
    ['01a-app-boot', '01-debug-mode'],
    ['01a-app-boot', '01d-browser-access'],
  ])('rejects %s starting before %s, and accepts it without that step', (runtime, choice) => {
    const setup = runtimeSetup[runtime]!;
    expect(validateComposition([...setup, choice, runtime], catalog)).toEqual([]);
    expect(validateComposition([...setup, runtime], catalog)).toEqual([]);
    expect(validateComposition([...setup, runtime, choice], catalog)).toEqual([
      { kind: 'too-late', index: setup.length + 1, stepId: choice, token: 'app-runtime' },
    ]);
  });

  it('rejects syncing the base after the worktree is cut', () => {
    expect(validateComposition(['00a-sync-base', '01-worktree-setup'], catalog)).toEqual([]);
    expect(validateComposition(['01-worktree-setup', '00a-sync-base'], catalog)).toEqual([
      { kind: 'too-late', index: 1, stepId: '00a-sync-base', token: 'worktree' },
    ]);
  });

  it('rejects a worktree step after cleanup removed the worktree', () => {
    const order = [
      '01-worktree-setup',
      '07-phase-2-implement',
      '10-gate-3-commit',
      '12-worktree-cleanup',
      '11c-rag-reindex',
    ];
    expect(validateComposition(order, catalog)).toEqual([
      expect.objectContaining({ kind: 'unmet-need', stepId: '11c-rag-reindex', needs: 'worktree' }),
    ]);
    expect(
      validateComposition(
        [...order.slice(0, 3), '11c-rag-reindex', '12-worktree-cleanup', '13-pr-wait'],
        catalog,
      ),
    ).toEqual([]);
  });

  it('rejects verify without implement earlier', () => {
    const issues = validateComposition(['01-worktree-setup', '08-phase-5-verify'], catalog);
    expect(issues).toEqual([
      {
        kind: 'missing-loop-target',
        index: 1,
        stepId: '08-phase-5-verify',
        target: '07-phase-2-implement',
      },
    ]);
  });

  it('rejects implement before the worktree step', () => {
    const issues = validateComposition(['07-phase-2-implement', '01-worktree-setup'], catalog);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      kind: 'unmet-need',
      index: 0,
      stepId: '07-phase-2-implement',
      needs: 'worktree',
    });
  });
});
