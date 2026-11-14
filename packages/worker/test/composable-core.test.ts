import { beforeAll, describe, expect, it } from 'vitest';
import { EXECUTION_PATHS } from '@haive/shared';
import { taskRunListIds } from '@haive/shared/run-list';
import { validateComposition, type ComposableStepEntry } from '@haive/shared/modularity';
import { registerStepsOnce } from '../src/step-engine/boot.js';
import {
  assertCoreComposableCatalog,
  CORE_COMPOSABLE_STEPS,
} from '../src/step-engine/composable-core.js';
import { stepRegistry } from '../src/step-engine/registry.js';
import { dispatchesAnyCli } from '../src/step-engine/steps/index.js';
import { orderWorkflowRunList } from '../src/orchestrator/execution-paths.js';

const catalog = new Map(CORE_COMPOSABLE_STEPS.map((e) => [e.stepId, e] as const));
const replace = (stepId: string, patch: Partial<ComposableStepEntry>): ComposableStepEntry[] =>
  CORE_COMPOSABLE_STEPS.map((e) => (e.stepId === stepId ? { ...e, ...patch } : e));

describe('core composable catalog', () => {
  beforeAll(() => registerStepsOnce());

  it('holds the 58 curated steps and passes the assert on the real registry', () => {
    expect(CORE_COMPOSABLE_STEPS).toHaveLength(58);
    expect(() => assertCoreComposableCatalog(stepRegistry)).not.toThrow();
  });

  it('accepts run configuration before implementation without requiring a spec or runtime', () => {
    expect(
      validateComposition(
        [
          '06-run-config',
          '01-worktree-setup',
          '07-phase-2-implement',
          '08b-test-management',
          '08-phase-5-verify',
        ],
        catalog,
      ),
    ).toEqual([]);
  });

  it('allows run configuration after commit because commit consumes none of its settings', () => {
    expect(
      validateComposition(['01-worktree-setup', '10-gate-3-commit', '06-run-config'], catalog),
    ).toEqual([]);
  });

  it.each([
    ['01-worktree-setup', '07-phase-2-implement'],
    ['01-worktree-setup', '07-phase-2-implement', '08b-test-management'],
    ['01-worktree-setup', '07-phase-2-implement', '08-phase-5-verify'],
    ['01-worktree-setup', '01c-ddev-env', '01c1-restore-database', '06a-db-migrate'],
  ])('refuses run configuration after a consumer: %j', (...order) => {
    expect(validateComposition([...order, '06-run-config'], catalog)).toContainEqual(
      expect.objectContaining({ kind: 'too-late', stepId: '06-run-config' }),
    );
  });

  it('flags exactly the steps whose stored output is purely agent-authored', () => {
    expect(
      CORE_COMPOSABLE_STEPS.filter((e) => e.agentAuthoredOutput === true)
        .map((e) => e.stepId)
        .sort(),
    ).toEqual(
      [
        '01-declare-deps',
        '02-generate-dockerfile',
        '04-verify-environment',
        '01-debug-mode',
        '01b-install-plugins',
        '01d-browser-access',
        '01c1-restore-database',
        '03b-business-requirements',
        '03b2-humanize-requirements',
        '04a-spec-audit',
        '07a-code-simplify',
        '07b-phase-4-validate',
        '08c-code-review',
        '08c2-code-audit',
        '11d-skill-sync',
        '11c-rag-reindex',
        '11g-save-database',
      ].sort(),
    );
  });

  it('counts the merge-fixer steps as CLI work', () => {
    const merging = stepRegistry
      .all()
      .filter((d) => d.mergeResolve !== undefined)
      .map((d) => d.metadata.id);
    expect(merging).toEqual(expect.arrayContaining(['00a-sync-base', '12-worktree-cleanup']));
    for (const id of merging) expect(dispatchesAnyCli(stepRegistry.get(id)!)).toBe(true);
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
    const tail = runtime === '01c-ddev-env' ? ['01c1-restore-database', '11g-save-database'] : [];
    expect(validateComposition([...setup, choice, runtime, ...tail], catalog)).toEqual([]);
    expect(validateComposition([...setup, runtime, ...tail], catalog)).toEqual([]);
    expect(validateComposition([...setup, runtime, choice, ...tail], catalog)).toEqual([
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
    ['03-phase-0a-discovery', '03b-business-requirements', 'business-requirements'],
    ['04a-spec-audit', '05-phase-0b5-spec-quality', 'spec-reviewed'],
    ['05a-resolve-spec-warnings', '06-gate-1-spec-approval', 'spec-approved'],
    ['07-phase-2-implement', '08c2-code-audit', 'code-audit'],
    ['07a-code-simplify', '08d-adversarial-qa', 'adversarial-qa'],
    ['07b-phase-4-validate', '09-gate-2-verify-approval', 'verify-approved'],
    ['08b-test-management', '09-gate-2-verify-approval', 'verify-approved'],
    ['08c-code-review', '09-gate-2-verify-approval', 'verify-approved'],
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
    ['07c-ddev-reconcile', '07b-phase-4-validate', 'validation'],
    ['07-phase-2-implement', '11b1-rag-source-selection', 'rag-scope'],
    ['04-verify-environment', '07-phase-2-implement', 'implementation'],
    ['04-verify-environment', '03-phase-0a-discovery', 'discovery'],
    ['04-verify-environment', '04-phase-0b-pre-planning', 'spec'],
    ['01c-ddev-env', '11b1-rag-source-selection', 'rag-scope'],
    ['01b-install-plugins', '11d-skill-sync', 'skills-synced'],
    ['11b-kb-commit', '11c-rag-reindex', 'reindexed'],
    ['00a-sync-base', '01-declare-deps', 'env-deps'],
    ['00a-sync-base', '03-build-image', 'env-image'],
    ['01b-install-plugins', '01a-app-boot', 'app-runtime'],
    ['01c1-restore-database', '04-phase-0b-pre-planning', 'spec'],
    ['01c1-restore-database', '03-phase-0a-discovery', 'discovery'],
    ['01c1-restore-database', '11-phase-8-learning', 'learnings'],
    ['06a-db-migrate', '11-phase-8-learning', 'learnings'],
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

  it.each([null, 'full_workflow', 'quick_bugfix', 'plan_tasklist'] as const)(
    'reconciles after implementation and before validation on path %s (including DAG)',
    (path) => {
      const main = stepRegistry.listByWorkflow('workflow');
      const lists = [
        main,
        orderWorkflowRunList(main, stepRegistry.listByWorkflow('env_replicate'), path),
      ];
      for (const list of lists) {
        const ids = list.map((s) => s.metadata.id);
        const reconcile = ids.indexOf('07c-ddev-reconcile');
        expect(reconcile).toBeGreaterThan(ids.indexOf('07-phase-2-implement'));
        if (ids.includes('06c-dag-execute')) {
          expect(reconcile).toBeGreaterThan(ids.indexOf('06c-dag-execute'));
        }
        if (ids.includes('07a-code-simplify')) {
          expect(reconcile).toBeGreaterThan(ids.indexOf('07a-code-simplify'));
        }
        expect(reconcile).toBeLessThan(ids.indexOf('07b-phase-4-validate'));
      }
    },
  );

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

  it.each(['01a-app-boot', '01c-ddev-env'])('treats %s as a tree editor', (stepId) => {
    const order = [
      '01-worktree-setup',
      '07-phase-2-implement',
      '10-gate-3-commit',
      stepId,
      '11a-gate-4-push',
    ];
    const issues = validateComposition(order, catalog);
    expect(issues).toContainEqual(
      expect.objectContaining({ kind: 'too-late', stepId, token: 'commit' }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({
        kind: 'unmet-need',
        stepId: '11a-gate-4-push',
        needs: 'clean-tree',
      }),
    );
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
    const head = [
      '01-worktree-setup',
      '01c-ddev-env',
      '01c1-restore-database',
      '07-phase-2-implement',
      '07c-ddev-reconcile',
      '10-gate-3-commit',
    ];
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
    ).toContainEqual({ kind: 'too-late', index: 7, stepId: '11a-gate-4-push', token: 'db-saved' });
    expect(
      validateComposition([...head, '12-worktree-cleanup', '11g-save-database'], catalog),
    ).toContainEqual({ kind: 'too-late', index: 7, stepId: '11g-save-database', token: 'cleaned' });
  });

  it('allows knowledge commit without skill sync but orders it first when present', () => {
    const head = [
      '01-worktree-setup',
      '07-phase-2-implement',
      '10-gate-3-commit',
      '11-phase-8-learning',
    ];
    expect(validateComposition([...head, '11b-kb-commit'], catalog)).toEqual([]);
    expect(
      validateComposition([...head, '11b-kb-commit', '11d-skill-sync'], catalog),
    ).toContainEqual(
      expect.objectContaining({
        kind: 'too-late',
        stepId: '11d-skill-sync',
        token: 'knowledge-committed',
      }),
    );
    expect(validateComposition([...head, '11d-skill-sync', '11b-kb-commit'], catalog)).toEqual([]);
  });

  it('needs the scope picker before re-indexing', () => {
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

  it.each([null, ...EXECUTION_PATHS])(
    'catalogues every step of shipped workflow path %s, environment prelude included',
    (executionPath) => {
      const order = taskRunListIds(
        {
          workflowType: 'workflow',
          runListStrategy: 'workflow_paths',
          runListSnapshot: null,
          executionPath,
        },
        (type) => stepRegistry.listByWorkflow(type).map((step) => step.metadata.id),
      );
      expect(order.filter((id) => !catalog.has(id))).toEqual([]);
    },
  );

  it.each([null, ...EXECUTION_PATHS])(
    'validates the entire shipped workflow path %s without filtering out steps or issues',
    (executionPath) => {
      const order = taskRunListIds(
        {
          workflowType: 'workflow',
          runListStrategy: 'workflow_paths',
          runListSnapshot: null,
          executionPath,
        },
        (type) => stepRegistry.listByWorkflow(type).map((step) => step.metadata.id),
      );
      expect(validateComposition(order, catalog)).toEqual([]);
    },
  );

  it('keeps broad audits report-only and gate 2 usable without optional reports', () => {
    expect(validateComposition(['04-phase-0b-pre-planning', '04a-spec-audit'], catalog)).toEqual(
      [],
    );
    expect(validateComposition(['01-worktree-setup', '08c2-code-audit'], catalog)).toEqual([]);
    const head = ['01-worktree-setup', '07-phase-2-implement', '08-phase-5-verify'];
    expect(
      validateComposition([...head, '09-gate-2-verify-approval', '10-gate-3-commit'], catalog),
    ).toEqual([]);
    expect(
      validateComposition([...head, '10-gate-3-commit', '09-gate-2-verify-approval'], catalog),
    ).toContainEqual(
      expect.objectContaining({ kind: 'loop-after-closing', stepId: '09-gate-2-verify-approval' }),
    );
    expect(
      validateComposition([...head, '09-gate-2-verify-approval', '08c2-code-audit'], catalog),
    ).toContainEqual(
      expect.objectContaining({
        kind: 'too-late',
        stepId: '08c2-code-audit',
        token: 'verify-approved',
      }),
    );
  });

  it('requires a prior worktree for external knowledge-base sync', () => {
    expect(validateComposition(['01e-external-kb-sync'], catalog)).toContainEqual(
      expect.objectContaining({
        kind: 'unmet-need',
        stepId: '01e-external-kb-sync',
        needs: 'worktree',
      }),
    );
    expect(
      validateComposition(['01e-external-kb-sync', '01-worktree-setup'], catalog),
    ).toContainEqual(expect.objectContaining({ kind: 'unmet-need', needs: 'worktree' }));
    expect(validateComposition(['01-worktree-setup', '01e-external-kb-sync'], catalog)).toEqual([]);
  });

  it.each(['01f-external-plan-sync', '05a-resolve-spec-warnings', '11f-plan-reconcile'])(
    'requires a prior worktree for repository writer %s',
    (stepId) => {
      const head = stepId === '05a-resolve-spec-warnings' ? ['04-phase-0b-pre-planning'] : [];
      expect(validateComposition([...head, stepId], catalog)).toContainEqual(
        expect.objectContaining({ kind: 'unmet-need', stepId, needs: 'worktree' }),
      );
      expect(validateComposition([...head, stepId, '01-worktree-setup'], catalog)).toContainEqual(
        expect.objectContaining({ kind: 'unmet-need', stepId, needs: 'worktree' }),
      );
      expect(validateComposition(['01-worktree-setup', ...head, stepId], catalog)).toEqual([]);
    },
  );

  it.each([
    ['08a-browser-verify', 'verify-approved'],
    ['09-gate-2-verify-approval', 'browser-verification'],
  ])('requires both browser method routes when only %s is present', (stepId, token) => {
    const head = [
      '01-declare-deps',
      '02-generate-dockerfile',
      '03-build-image',
      '01-worktree-setup',
      '01a-app-boot',
      '07-phase-2-implement',
      '08-phase-5-verify',
      '08a-browser-setup',
    ];
    expect(validateComposition([...head, stepId], catalog)).toEqual([
      expect.objectContaining({ kind: 'unfulfilled', stepId: '08a-browser-setup', token }),
    ]);
    expect(
      validateComposition(
        [...head, '08a-browser-verify', '09-gate-2-verify-approval', '10-gate-3-commit'],
        catalog,
      ),
    ).toEqual([]);
  });

  it('requires the DAG planner before execution and run configuration before planning', () => {
    expect(validateComposition(['01-worktree-setup', '06c-dag-execute'], catalog)).toContainEqual(
      expect.objectContaining({
        kind: 'unmet-need',
        stepId: '06c-dag-execute',
        needs: 'sprint-plan',
      }),
    );
    const order = [
      '01-worktree-setup',
      '04-phase-0b-pre-planning',
      '06-gate-1-spec-approval',
      '06b-sprint-planning',
      '06c-dag-execute',
      '07-phase-2-implement',
    ];
    expect(validateComposition(order, catalog)).toEqual([]);
    expect(validateComposition([...order, '06-run-config'], catalog)).toContainEqual(
      expect.objectContaining({ kind: 'too-late', stepId: '06-run-config', token: 'sprint-plan' }),
    );
  });

  it.each([
    ['06c-dag-execute', 'single-implementation'],
    ['07-phase-2-implement', 'dag-implementation'],
  ])('requires both planner mode implementations when only %s is present', (stepId, token) => {
    const head = [
      '01-worktree-setup',
      '04-phase-0b-pre-planning',
      '06-gate-1-spec-approval',
      '06b-sprint-planning',
    ];
    expect(validateComposition([...head, stepId, '10-gate-3-commit'], catalog)).toContainEqual(
      expect.objectContaining({ kind: 'unfulfilled', stepId: '06b-sprint-planning', token }),
    );
  });

  it('requires a draft for humanization and the revise target for requirements approval', () => {
    expect(validateComposition(['03b2-humanize-requirements'], catalog)).toContainEqual(
      expect.objectContaining({ kind: 'unmet-need', needs: 'business-requirements' }),
    );
    expect(validateComposition(['03c-business-requirements-review'], catalog)).toContainEqual(
      expect.objectContaining({ kind: 'missing-loop-target', target: '03b-business-requirements' }),
    );
    expect(
      validateComposition(
        [
          '03b-business-requirements',
          '03c-business-requirements-review',
          '04-phase-0b-pre-planning',
        ],
        catalog,
      ),
    ).toEqual([]);
  });

  it('requires QA findings for their review and keeps its human fix loop before commit', () => {
    const head = ['01-worktree-setup', '07-phase-2-implement'];
    expect(validateComposition([...head, '08d2-adversarial-qa-review'], catalog)).toContainEqual(
      expect.objectContaining({ kind: 'unmet-need', needs: 'adversarial-qa' }),
    );
    const qa = [...head, '08d-adversarial-qa'];
    expect(
      validateComposition([...qa, '08d2-adversarial-qa-review', '10-gate-3-commit'], catalog),
    ).toEqual([]);
    expect(
      validateComposition([...qa, '10-gate-3-commit', '08d2-adversarial-qa-review'], catalog),
    ).toContainEqual(
      expect.objectContaining({ kind: 'loop-after-closing', stepId: '08d2-adversarial-qa-review' }),
    );
  });

  it('does not let insight edits leave push with an uncommitted tree', () => {
    const head = ['01-worktree-setup', '07-phase-2-implement', '10-gate-3-commit'];
    expect(
      validateComposition([...head, '08e-insights-triage', '11a-gate-4-push'], catalog),
    ).toContainEqual(
      expect.objectContaining({
        kind: 'unmet-need',
        stepId: '11a-gate-4-push',
        needs: 'clean-tree',
      }),
    );
  });

  it('requires the separate repository scope before pre-sync', () => {
    expect(validateComposition(['02-pre-rag-sync'], catalog)).toContainEqual(
      expect.objectContaining({ kind: 'unmet-need', needs: 'pre-rag-scope' }),
    );
    expect(validateComposition(['01g-rag-source-selection', '02-pre-rag-sync'], catalog)).toEqual(
      [],
    );
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

  it('makes every DDEV composition reach the restore and the final save', () => {
    const base = ['01-worktree-setup', '01c-ddev-env', '07-phase-2-implement', '10-gate-3-commit'];
    expect(validateComposition(base, catalog)).toEqual([
      { kind: 'unfulfilled', index: 1, stepId: '01c-ddev-env', token: 'db-restored' },
      { kind: 'unfulfilled', index: 1, stepId: '01c-ddev-env', token: 'db-saved' },
      { kind: 'unfulfilled', index: 2, stepId: '07-phase-2-implement', token: 'reconciled' },
    ]);
    expect(
      validateComposition(
        [
          '01-worktree-setup',
          '01c-ddev-env',
          '01c1-restore-database',
          '07-phase-2-implement',
          '07c-ddev-reconcile',
          '10-gate-3-commit',
          '11g-save-database',
        ],
        catalog,
      ),
    ).toEqual([]);
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
      validateComposition(
        [
          '01-worktree-setup',
          '01d-browser-access',
          '01c-ddev-env',
          '01c1-restore-database',
          '11g-save-database',
        ],
        catalog,
      ),
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

describe('core composable catalog repository token', () => {
  beforeAll(() => registerStepsOnce());
  const repoLess = { requiresRepository: false };
  const unmet = (index: number, stepId: string, needs: string) =>
    expect.objectContaining({ kind: 'unmet-need', index, stepId, needs });

  it('accepts a spec-only composition for a repo-less type', () => {
    const order = [
      '03-phase-0a-discovery',
      '04-phase-0b-pre-planning',
      '05-phase-0b5-spec-quality',
      '06-gate-1-spec-approval',
    ];
    expect(validateComposition(order, catalog, repoLess)).toEqual([]);
    expect(validateComposition(order, catalog)).toEqual([]);
  });

  it.each(['01-worktree-setup', '00a-sync-base', '01-declare-deps'])(
    'refuses %s for a repo-less type',
    (stepId) => {
      const needs = (opts?: { requiresRepository: boolean }) =>
        validateComposition([stepId], catalog, opts).filter((i) => i.kind === 'unmet-need');
      expect(needs(repoLess)).toEqual([unmet(0, stepId, 'repository')]);
      expect(needs()).toEqual([]);
    },
  );

  it('refuses implementation without a worktree for a repo-less type', () => {
    expect(validateComposition(['07-phase-2-implement'], catalog, repoLess)).toEqual([
      unmet(0, '07-phase-2-implement', 'worktree'),
    ]);
  });

  it('throws for an entry needing an implicit token nobody knows', () => {
    const bad = replace('01-worktree-setup', {
      requires: [{ needs: 'unknown-implicit', reason: 'x' }],
    });
    expect(() => assertCoreComposableCatalog(stepRegistry, bad)).toThrow(
      /01-worktree-setup.*unknown-implicit/,
    );
  });
});
