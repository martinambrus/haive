import { describe, it, expect } from 'vitest';
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
    expect(keepForPath('08c-code-review', 'quick_bugfix')).toBe(false);
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
    // Deliberately out of position: sync belongs after the complete environment prelude.
    step(SYNC_BASE_STEP_ID),
  ];
  const prelude: OrderableStep[] = [
    step('01-declare-deps', 'env_replicate'),
    step('02-generate-dockerfile', 'env_replicate'),
    step('03-build-image', 'env_replicate'),
    step('04-verify-environment', 'env_replicate'),
  ];
  const ids = (path: Parameters<typeof orderWorkflowRunList>[2]) =>
    orderWorkflowRunList(main, prelude, path).map((s) => s.metadata.id);

  it('null path: model-health, prelude, base-sync, triage, then the rest', () => {
    const r = ids(null);
    expect(r[0]).toBe('00-model-health-workflow');
    expect(r[5]).toBe(SYNC_BASE_STEP_ID);
    expect(r[6]).toBe(TRIAGE_STEP_ID);
    expect(r.slice(1, 5)).toEqual(prelude.map((s) => s.metadata.id));
    expect(r).toContain('08d-adversarial-qa');
  });

  it('quick_bugfix: model-health + prelude + base-sync + triage, prelude kept, heavy steps dropped', () => {
    const r = ids('quick_bugfix');
    expect(r[0]).toBe('00-model-health-workflow');
    expect(r[5]).toBe(SYNC_BASE_STEP_ID);
    expect(r[6]).toBe(TRIAGE_STEP_ID);
    expect(r).toContain('01-declare-deps'); // prelude is never filtered
    expect(r).toContain('07-phase-2-implement');
    expect(r).not.toContain('08d-adversarial-qa');
    expect(r).not.toContain('04-phase-0b-pre-planning');
  });

  it('plan_tasklist: model-health + prelude + base-sync first, spec + DAG kept, adversarial dropped', () => {
    const r = ids('plan_tasklist');
    expect(r[0]).toBe('00-model-health-workflow');
    expect(r[5]).toBe(SYNC_BASE_STEP_ID);
    expect(r).toContain('04-phase-0b-pre-planning');
    expect(r).toContain('06b-sprint-planning');
    expect(r).not.toContain('08d-adversarial-qa');
  });
  it.each([null, 'full_workflow', 'quick_bugfix', 'plan_tasklist'] as const)(
    'has image and LSP checks ready before a divergent-base merge fixer on path %s',
    (path) => {
      const r = ids(path);
      expect(r.indexOf('04-verify-environment')).toBeLessThan(r.indexOf(SYNC_BASE_STEP_ID));
      expect(r.indexOf(SYNC_BASE_STEP_ID)).toBeLessThan(r.indexOf(TRIAGE_STEP_ID));
      expect(r.indexOf(SYNC_BASE_STEP_ID)).toBeLessThan(r.indexOf('01-worktree-setup'));
    },
  );
});
