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

  it('holds the 34 curated steps and passes the assert on the real registry', () => {
    expect(CORE_COMPOSABLE_STEPS).toHaveLength(34);
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
    '01c-ddev-env': ['01-worktree-setup'],
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

  it.each(['07-phase-2-implement', '07a-code-simplify'])(
    'rejects %s after the commit, whose edits it would leave out',
    (stepId) => {
      const order = ['01-worktree-setup', '07-phase-2-implement', '10-gate-3-commit', stepId];
      expect(validateComposition(order, catalog)).toContainEqual({
        kind: 'too-late',
        index: 3,
        stepId,
        token: 'commit',
      });
    },
  );

  it('rejects the push gate after cleanup removed the worktree', () => {
    const base = ['01-worktree-setup', '07-phase-2-implement', '10-gate-3-commit'];
    expect(
      validateComposition([...base, '11a-gate-4-push', '12-worktree-cleanup'], catalog),
    ).toEqual([]);
    expect(
      validateComposition([...base, '12-worktree-cleanup', '11a-gate-4-push'], catalog),
    ).toEqual([
      expect.objectContaining({ kind: 'unmet-need', stepId: '11a-gate-4-push', needs: 'worktree' }),
    ]);
  });

  it('raises no ordering issue on the built-in workflow and environment orders', () => {
    const orderKinds = new Set([
      'too-late',
      'loop-after-closing',
      'missing-loop-target',
      'duplicate-step',
    ]);
    for (const workflowType of ['workflow', 'env_replicate'] as const) {
      const order = stepRegistry
        .listByWorkflow(workflowType)
        .map((s) => s.metadata.id)
        .filter((id) => catalog.has(id));
      expect(order.length).toBeGreaterThan(3);
      expect(validateComposition(order, catalog).filter((i) => orderKinds.has(i.kind))).toEqual([]);
    }
  });

  it.each([
    ['07c-ddev-reconcile', '08-phase-5-verify', 'verification'],
    ['07c-ddev-reconcile', '08b-test-management', 'tests'],
    ['08b-test-management', '08c-code-review', 'review'],
    ['07a-code-simplify', '08c-code-review', 'review'],
    ['07a-code-simplify', '08-phase-5-verify', 'verification'],
    ['06-gate-1-spec-approval', '07-phase-2-implement', 'implementation'],
    ['11-phase-8-learning', '11a-gate-4-push', 'pushed'],
    ['11b-kb-commit', '11a-gate-4-push', 'pushed'],
    ['06a-db-migrate', '07-phase-2-implement', 'implementation'],
    ['05-phase-0b5-spec-quality', '06-gate-1-spec-approval', 'spec-approved'],
    ['07a-code-simplify', '07b-phase-4-validate', 'validation'],
    ['07-phase-2-implement', '11c-rag-reindex', 'reindexed'],
    ['01c1-restore-database', '06a-db-migrate', 'db-migrated'],
    ['01c1-restore-database', '07-phase-2-implement', 'implementation'],
    ['07b-phase-4-validate', '08-phase-5-verify', 'verification'],
    ['07b-phase-4-validate', '10-gate-3-commit', 'commit'],
    ['07-phase-2-implement', '11g-save-database', 'db-saved'],
    ['08-phase-5-verify', '11g-save-database', 'db-saved'],
    ['01c1-restore-database', '11g-save-database', 'db-saved'],
    ['03-phase-0a-discovery', '04-phase-0b-pre-planning', 'spec'],
    ['04-phase-0b-pre-planning', '07-phase-2-implement', 'implementation'],
    ['05-phase-0b5-spec-quality', '07-phase-2-implement', 'implementation'],
    ['10-gate-3-commit', '11-phase-8-learning', 'learnings'],
    ['08-phase-5-verify', '11-phase-8-learning', 'learnings'],
    ['01b-install-plugins', '07-phase-2-implement', 'implementation'],
    ['07b-phase-4-validate', '07c-ddev-reconcile', 'reconciled'],
    ['07-phase-2-implement', '11b1-rag-source-selection', 'rag-scope'],
    ['04-verify-environment', '07-phase-2-implement', 'implementation'],
    ['04-verify-environment', '03-phase-0a-discovery', 'discovery'],
    ['04-verify-environment', '04-phase-0b-pre-planning', 'spec'],
    ['01c-ddev-env', '11b1-rag-source-selection', 'rag-scope'],
    ['01b-install-plugins', '11d-skill-sync', 'skills-synced'],
    ['11b-kb-commit', '11c-rag-reindex', 'reindexed'],
    ['11b-kb-commit', '11b1-rag-source-selection', 'rag-scope'],
    ['11d-skill-sync', '11a-gate-4-push', 'pushed'],
  ])('rejects %s placed after %s', (early, late, token) => {
    const setup = [
      '04-phase-0b-pre-planning',
      '01-worktree-setup',
      '01-declare-deps',
      '01c-ddev-env',
      '07-phase-2-implement',
      '10-gate-3-commit',
    ].filter((id) => id !== early && id !== late);
    const issues = validateComposition([...setup, late, early], catalog);
    expect(issues).toContainEqual(
      expect.objectContaining({ kind: 'too-late', stepId: early, token }),
    );
  });

  it('keeps the built-in workflow tree committed before push and cleanup', () => {
    const order = stepRegistry
      .listByWorkflow('workflow')
      .map((s) => s.metadata.id)
      .filter((id) => catalog.has(id));
    expect(
      validateComposition(order, catalog).filter(
        (i) => i.kind === 'unmet-need' && i.needs === 'clean-tree',
      ),
    ).toEqual([]);
  });

  it('refuses push and cleanup over learning files nobody committed', () => {
    const head = [
      '01-worktree-setup',
      '07-phase-2-implement',
      '10-gate-3-commit',
      '11-phase-8-learning',
    ];
    const tail = ['11a-gate-4-push', '12-worktree-cleanup'];
    expect(validateComposition([...head, ...tail], catalog)).toEqual([
      expect.objectContaining({
        kind: 'unmet-need',
        stepId: '11a-gate-4-push',
        needs: 'clean-tree',
      }),
      expect.objectContaining({
        kind: 'unmet-need',
        stepId: '12-worktree-cleanup',
        needs: 'clean-tree',
      }),
    ]);
    expect(
      validateComposition([...head, '11d-skill-sync', '11b-kb-commit', ...tail], catalog),
    ).toEqual([]);
  });

  it('places the database save after the push and before cleanup', () => {
    const head = ['01-worktree-setup', '01c-ddev-env', '07-phase-2-implement', '10-gate-3-commit'];
    expect(
      validateComposition(
        [...head, '11a-gate-4-push', '11g-save-database', '12-worktree-cleanup'],
        catalog,
      ),
    ).toEqual([]);
    expect(
      validateComposition(
        [...head, '11g-save-database', '11a-gate-4-push', '12-worktree-cleanup'],
        catalog,
      ),
    ).toContainEqual({ kind: 'too-late', index: 5, stepId: '11a-gate-4-push', token: 'db-saved' });
    expect(
      validateComposition([...head, '12-worktree-cleanup', '11g-save-database'], catalog),
    ).toContainEqual({ kind: 'too-late', index: 5, stepId: '11g-save-database', token: 'cleaned' });
  });

  it('needs the skill sync before the knowledge commit and the scope picker before re-indexing', () => {
    const head = [
      '01-worktree-setup',
      '07-phase-2-implement',
      '10-gate-3-commit',
      '11-phase-8-learning',
    ];
    expect(validateComposition([...head, '11b-kb-commit'], catalog)).toEqual([
      expect.objectContaining({
        kind: 'unmet-need',
        stepId: '11b-kb-commit',
        needs: 'skills-synced',
      }),
    ]);
    expect(validateComposition([...head, '11d-skill-sync', '11b-kb-commit'], catalog)).toEqual([]);
    expect(validateComposition(['01-worktree-setup', '11c-rag-reindex'], catalog)).toEqual([
      expect.objectContaining({
        kind: 'unmet-need',
        stepId: '11c-rag-reindex',
        needs: 'rag-scope',
      }),
    ]);
    expect(
      validateComposition(
        ['01-worktree-setup', '11b1-rag-source-selection', '11c-rag-reindex'],
        catalog,
      ),
    ).toEqual([]);
  });

  it('raises no issue at all on the environment order followed by the workflow order', () => {
    const ordered = (type: 'workflow' | 'env_replicate') =>
      stepRegistry
        .listByWorkflow(type)
        .map((s) => s.metadata.id)
        .filter((id) => catalog.has(id));
    const order = [...ordered('env_replicate'), ...ordered('workflow')];
    expect(validateComposition(order, catalog)).toEqual([]);
  });

  it('runs the RAG scope picker inside the worktree', () => {
    expect(
      validateComposition(['11b1-rag-source-selection', '01-worktree-setup'], catalog),
    ).toContainEqual(
      expect.objectContaining({
        kind: 'unmet-need',
        stepId: '11b1-rag-source-selection',
        needs: 'worktree',
      }),
    );
  });

  it('requires an image build after declaring dependencies', () => {
    expect(validateComposition(['01-declare-deps', '01-worktree-setup'], catalog)).toEqual([
      { kind: 'unfulfilled', index: 0, stepId: '01-declare-deps', token: 'env-image' },
    ]);
    expect(
      validateComposition(
        ['01-declare-deps', '02-generate-dockerfile', '03-build-image', '01-worktree-setup'],
        catalog,
      ),
    ).toEqual([]);
  });

  it('lets a DDEV composition use the repository declarations without redeclaring', () => {
    expect(
      validateComposition(['01-worktree-setup', '01c-ddev-env', '01d-browser-access'], catalog),
    ).toContainEqual(expect.objectContaining({ kind: 'too-late', stepId: '01d-browser-access' }));
    expect(
      validateComposition(['01-worktree-setup', '01d-browser-access', '01c-ddev-env'], catalog),
    ).toEqual([]);
  });

  it('remembers a capability cleanup removed when checking precedence', () => {
    const order = [
      '01-worktree-setup',
      '07-phase-2-implement',
      '10-gate-3-commit',
      '12-worktree-cleanup',
      '00a-sync-base',
    ];
    expect(validateComposition(order, catalog)).toEqual([
      { kind: 'too-late', index: 4, stepId: '00a-sync-base', token: 'worktree' },
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
      '11b1-rag-source-selection',
      '12-worktree-cleanup',
      '11c-rag-reindex',
    ];
    expect(validateComposition(order, catalog)).toEqual([
      expect.objectContaining({ kind: 'unmet-need', stepId: '11c-rag-reindex', needs: 'worktree' }),
    ]);
    expect(
      validateComposition(
        [...order.slice(0, 4), '11c-rag-reindex', '12-worktree-cleanup', '13-pr-wait'],
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
