import { registerStepsOnce } from '../step-engine/boot.js';
import { stepRegistry } from '../step-engine/registry.js';
import { taskRunListIds } from '@haive/shared/run-list';
import { beforeAll, describe, it, expect } from 'vitest';
import {
  PATH_STEP_SETS,
  PATH_REQUIRED_TARGETS,
  keepForPath,
  orderWorkflowRunList,
  SYNC_BASE_STEP_ID,
  TRIAGE_STEP_ID,
  type OrderableStep,
} from './execution-paths.js';

function step(id: string, workflowType = 'workflow'): OrderableStep {
  return { metadata: { id, workflowType } };
}

describe('keepForPath', () => {
  it('full_workflow keeps everything', () => {
    expect(keepForPath('08d-adversarial-qa', 'full_workflow')).toBe(true);
    expect(keepForPath('anything-at-all', 'full_workflow')).toBe(true);
  });

  it('quick_bugfix keeps the spine + implement, drops the heavy steps', () => {
    expect(keepForPath(TRIAGE_STEP_ID, 'quick_bugfix')).toBe(true);
    expect(keepForPath('07-phase-2-implement', 'quick_bugfix')).toBe(true);
    expect(keepForPath('08-phase-5-verify', 'quick_bugfix')).toBe(true);
    expect(keepForPath('04-phase-0b-pre-planning', 'quick_bugfix')).toBe(false);
    expect(keepForPath('05-phase-0b5-spec-quality', 'quick_bugfix')).toBe(false);
    expect(keepForPath('08c-code-review', 'quick_bugfix')).toBe(true);
    expect(keepForPath('08e-insights-triage', 'quick_bugfix')).toBe(true);
    expect(keepForPath('08d-adversarial-qa', 'quick_bugfix')).toBe(false);
    expect(keepForPath('06b-sprint-planning', 'quick_bugfix')).toBe(false);
  });

  it('plan_tasklist keeps spec audit + DAG + code review, drops adversarial/browser', () => {
    expect(keepForPath('04-phase-0b-pre-planning', 'plan_tasklist')).toBe(true);
    expect(keepForPath('05-phase-0b5-spec-quality', 'plan_tasklist')).toBe(true);
    expect(keepForPath('06-gate-1-spec-approval', 'plan_tasklist')).toBe(true);
    expect(keepForPath('06b-sprint-planning', 'plan_tasklist')).toBe(true);
    expect(keepForPath('06c-dag-execute', 'plan_tasklist')).toBe(true);
    expect(keepForPath('08c-code-review', 'plan_tasklist')).toBe(true);
    expect(keepForPath('08d-adversarial-qa', 'plan_tasklist')).toBe(false);
    expect(keepForPath('08a-browser-verify', 'plan_tasklist')).toBe(false);
  });
});

describe('PATH_STEP_SETS invariants', () => {
  it('triage + commit/push spine present in every non-full set', () => {
    for (const set of Object.values(PATH_STEP_SETS)) {
      expect(set.has(SYNC_BASE_STEP_ID)).toBe(true);
      expect(set.has(TRIAGE_STEP_ID)).toBe(true);
      expect(set.has('01-worktree-setup')).toBe(true);
      expect(set.has('07-phase-2-implement')).toBe(true);
      expect(set.has('10-gate-3-commit')).toBe(true);
      expect(set.has('11a-gate-4-push')).toBe(true);
      expect(set.has('12-worktree-cleanup')).toBe(true);
    }
  });

  it('loop-target closure: a retained emitter keeps its loop target', () => {
    for (const [path, set] of Object.entries(PATH_STEP_SETS)) {
      for (const [src, tgt] of Object.entries(PATH_REQUIRED_TARGETS)) {
        if (set.has(src)) {
          expect(set.has(tgt), `${path}: '${src}' retained but target '${tgt}' missing`).toBe(true);
        }
      }
    }
  });
});

describe('orderWorkflowRunList', () => {
  const main: OrderableStep[] = [
    step('00-model-health-workflow'),
    step(TRIAGE_STEP_ID),
    step('01-worktree-setup'),
    step('04-phase-0b-pre-planning'),
    step('06b-sprint-planning'),
    step('07-phase-2-implement'),
    step('08d-adversarial-qa'),
    step('10-gate-3-commit'),
    // Deliberately out of position to prove orderWorkflowRunList pulls it to slot 1.
    step(SYNC_BASE_STEP_ID),
  ];
  const prelude: OrderableStep[] = [
    step('01-declare-deps', 'env_replicate'),
    step('03-build-image', 'env_replicate'),
  ];
  it.each([null, 'full_workflow', 'quick_bugfix', 'plan_tasklist'] as const)(
    'syncs the base before env detection and retains the prelude after triage on %s',
    (path) => {
      const ids = orderWorkflowRunList(main, prelude, path).map((s) => s.metadata.id);
      expect(ids.slice(0, 5)).toEqual([
        '00-model-health-workflow',
        SYNC_BASE_STEP_ID,
        TRIAGE_STEP_ID,
        '01-declare-deps',
        '03-build-image',
      ]);
      expect(ids[ids.indexOf(TRIAGE_STEP_ID) + 1]).toBe('01-declare-deps');
    },
  );

  const ids = (path: Parameters<typeof orderWorkflowRunList>[2]) =>
    orderWorkflowRunList(main, prelude, path).map((s) => s.metadata.id);

  it('null path: model-health, base-sync, triage, then prelude, then the rest', () => {
    const r = ids(null);
    expect(r[0]).toBe('00-model-health-workflow');
    expect(r[1]).toBe(SYNC_BASE_STEP_ID);
    expect(r[2]).toBe(TRIAGE_STEP_ID);
    expect(r.slice(3, 5)).toEqual(['01-declare-deps', '03-build-image']);
    expect(r).toContain('08d-adversarial-qa');
  });

  it('quick_bugfix: model-health + base-sync + triage first, prelude kept, heavy steps dropped', () => {
    const r = ids('quick_bugfix');
    expect(r[0]).toBe('00-model-health-workflow');
    expect(r[1]).toBe(SYNC_BASE_STEP_ID);
    expect(r[2]).toBe(TRIAGE_STEP_ID);
    expect(r).toContain('01-declare-deps'); // prelude is never filtered
    expect(r).toContain('07-phase-2-implement');
    expect(r).not.toContain('08d-adversarial-qa');
    expect(r).not.toContain('04-phase-0b-pre-planning');
  });

  it('plan_tasklist: model-health + base-sync first, spec + DAG kept, adversarial dropped', () => {
    const r = ids('plan_tasklist');
    expect(r[0]).toBe('00-model-health-workflow');
    expect(r[1]).toBe(SYNC_BASE_STEP_ID);
    expect(r).toContain('04-phase-0b-pre-planning');
    expect(r).toContain('06b-sprint-planning');
    expect(r).not.toContain('08d-adversarial-qa');
  });
});

describe('complete registered workflow paths', () => {
  beforeAll(() => registerStepsOnce());
  const expected = {
    null: [
      '00-model-health-workflow',
      '00a-sync-base',
      '00-triage',
      '01-declare-deps',
      '02-generate-dockerfile',
      '03-build-image',
      '04-verify-environment',
      '00b-estimate',
      '01-worktree-setup',
      '01-debug-mode',
      '01b-install-plugins',
      '01d-browser-access',
      '01a-app-boot',
      '01c-ddev-env',
      '01c1-restore-database',
      '01e-external-kb-sync',
      '01f-external-plan-sync',
      '01g-rag-source-selection',
      '02-pre-rag-sync',
      '03-phase-0a-discovery',
      '03b-business-requirements',
      '03b2-humanize-requirements',
      '03c-business-requirements-review',
      '04-phase-0b-pre-planning',
      '04a-spec-audit',
      '05-phase-0b5-spec-quality',
      '05a-resolve-spec-warnings',
      '06-gate-1-spec-approval',
      '06-run-config',
      '06a-db-migrate',
      '06b-sprint-planning',
      '06c-dag-execute',
      '07-phase-2-implement',
      '07a-code-simplify',
      '07c-ddev-reconcile',
      '07b-phase-4-validate',
      '08b-test-management',
      '08-phase-5-verify',
      '08a-browser-setup',
      '08a-browser-verify',
      '08c-code-review',
      '08c2-code-audit',
      '08d-adversarial-qa',
      '08d2-adversarial-qa-review',
      '08e-insights-triage',
      '09-gate-2-verify-approval',
      '10-gate-3-commit',
      '11-phase-8-learning',
      '11d-skill-sync',
      '11b-kb-commit',
      '11b1-rag-source-selection',
      '11c-rag-reindex',
      '11e-prompt-guidance',
      '11f-plan-reconcile',
      '11a-gate-4-push',
      '11g-save-database',
      '12-worktree-cleanup',
      '13-pr-wait',
    ],
    full_workflow: [
      '00-model-health-workflow',
      '00a-sync-base',
      '00-triage',
      '01-declare-deps',
      '02-generate-dockerfile',
      '03-build-image',
      '04-verify-environment',
      '00b-estimate',
      '01-worktree-setup',
      '01-debug-mode',
      '01b-install-plugins',
      '01d-browser-access',
      '01a-app-boot',
      '01c-ddev-env',
      '01c1-restore-database',
      '01e-external-kb-sync',
      '01f-external-plan-sync',
      '01g-rag-source-selection',
      '02-pre-rag-sync',
      '03-phase-0a-discovery',
      '03b-business-requirements',
      '03b2-humanize-requirements',
      '03c-business-requirements-review',
      '04-phase-0b-pre-planning',
      '04a-spec-audit',
      '05-phase-0b5-spec-quality',
      '05a-resolve-spec-warnings',
      '06-gate-1-spec-approval',
      '06-run-config',
      '06a-db-migrate',
      '06b-sprint-planning',
      '06c-dag-execute',
      '07-phase-2-implement',
      '07a-code-simplify',
      '07c-ddev-reconcile',
      '07b-phase-4-validate',
      '08b-test-management',
      '08-phase-5-verify',
      '08a-browser-setup',
      '08a-browser-verify',
      '08c-code-review',
      '08c2-code-audit',
      '08d-adversarial-qa',
      '08d2-adversarial-qa-review',
      '08e-insights-triage',
      '09-gate-2-verify-approval',
      '10-gate-3-commit',
      '11-phase-8-learning',
      '11d-skill-sync',
      '11b-kb-commit',
      '11b1-rag-source-selection',
      '11c-rag-reindex',
      '11e-prompt-guidance',
      '11f-plan-reconcile',
      '11a-gate-4-push',
      '11g-save-database',
      '12-worktree-cleanup',
      '13-pr-wait',
    ],
    quick_bugfix: [
      '00-model-health-workflow',
      '00a-sync-base',
      '00-triage',
      '01-declare-deps',
      '02-generate-dockerfile',
      '03-build-image',
      '04-verify-environment',
      '00b-estimate',
      '01-worktree-setup',
      '01-debug-mode',
      '01b-install-plugins',
      '01d-browser-access',
      '01a-app-boot',
      '01c-ddev-env',
      '01c1-restore-database',
      '01g-rag-source-selection',
      '02-pre-rag-sync',
      '06a-db-migrate',
      '07-phase-2-implement',
      '07c-ddev-reconcile',
      '07b-phase-4-validate',
      '08b-test-management',
      '08-phase-5-verify',
      '08c-code-review',
      '08e-insights-triage',
      '09-gate-2-verify-approval',
      '10-gate-3-commit',
      '11b1-rag-source-selection',
      '11a-gate-4-push',
      '11g-save-database',
      '12-worktree-cleanup',
      '13-pr-wait',
    ],
    plan_tasklist: [
      '00-model-health-workflow',
      '00a-sync-base',
      '00-triage',
      '01-declare-deps',
      '02-generate-dockerfile',
      '03-build-image',
      '04-verify-environment',
      '00b-estimate',
      '01-worktree-setup',
      '01-debug-mode',
      '01b-install-plugins',
      '01d-browser-access',
      '01a-app-boot',
      '01c-ddev-env',
      '01c1-restore-database',
      '01e-external-kb-sync',
      '01f-external-plan-sync',
      '01g-rag-source-selection',
      '02-pre-rag-sync',
      '03-phase-0a-discovery',
      '04-phase-0b-pre-planning',
      '04a-spec-audit',
      '05-phase-0b5-spec-quality',
      '05a-resolve-spec-warnings',
      '06-gate-1-spec-approval',
      '06-run-config',
      '06a-db-migrate',
      '06b-sprint-planning',
      '06c-dag-execute',
      '07-phase-2-implement',
      '07c-ddev-reconcile',
      '07b-phase-4-validate',
      '08b-test-management',
      '08-phase-5-verify',
      '08c-code-review',
      '08c2-code-audit',
      '08e-insights-triage',
      '09-gate-2-verify-approval',
      '10-gate-3-commit',
      '11-phase-8-learning',
      '11b-kb-commit',
      '11b1-rag-source-selection',
      '11c-rag-reindex',
      '11e-prompt-guidance',
      '11f-plan-reconcile',
      '11a-gate-4-push',
      '11g-save-database',
      '12-worktree-cleanup',
      '13-pr-wait',
    ],
  } as const;
  it.each([null, 'full_workflow', 'quick_bugfix', 'plan_tasklist'] as const)(
    'pins the whole ordered %s path',
    (executionPath) => {
      expect(
        taskRunListIds(
          {
            workflowType: 'workflow',
            runListStrategy: 'workflow_paths',
            runListSnapshot: null,
            executionPath,
          },
          (type) => stepRegistry.listByWorkflow(type).map((s) => s.metadata.id),
        ),
      ).toEqual(expected[String(executionPath) as keyof typeof expected]);
    },
  );
});
