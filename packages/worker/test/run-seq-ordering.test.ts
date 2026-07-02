import { describe, expect, it } from 'vitest';
import {
  MODEL_HEALTH_STEP_ID,
  SYNC_BASE_STEP_ID,
  TRIAGE_STEP_ID,
  orderWorkflowRunList,
  type OrderableStep,
} from '../src/orchestrator/execution-paths.js';

// The task step list is ordered by run_seq (the step's index in buildRunList, stamped by
// the worker). These tests pin the ordering-key contract used by the API step-list queries
// (packages/api/src/routes/tasks/index.ts + steps.ts) against the scenarios where the old
// (created_at, step_index) key misordered: a step inserted mid-pipeline on a resumed task,
// and steps reused across task types (run_app) whose global step_index is not run-monotonic.

interface Row {
  stepId: string;
  round: number;
  runSeq: number | null;
  createdAt: number; // epoch ms
  stepIndex: number;
}

/** Mirrors the API orderBy: (round, runSeq NULLS LAST, createdAt, stepIndex). */
function byRunSeq(a: Row, b: Row): number {
  if (a.round !== b.round) return a.round - b.round;
  const ar = a.runSeq ?? Number.POSITIVE_INFINITY; // Postgres sorts NULLs last on ASC.
  const br = b.runSeq ?? Number.POSITIVE_INFINITY;
  if (ar !== br) return ar - br;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.stepIndex - b.stepIndex;
}

/** The superseded key, kept only to assert it misordered these inputs. */
function byCreatedAt(a: Row, b: Row): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.stepIndex - b.stepIndex;
}

function byStepIndex(a: Row, b: Row): number {
  return a.stepIndex - b.stepIndex;
}

const ids = (rows: Row[]): string[] => rows.map((r) => r.stepId);

describe('run_seq step ordering', () => {
  it('orders a mid-pipeline step inserted on a resumed task by run position, not creation time', () => {
    // Reproduces task 7af66712: 01-debug-mode + 01d-browser-access were added to the
    // pipeline AFTER the task started, so on resume they were created later (larger
    // createdAt) than the already-present 01a/01c/06 rows, despite running earlier.
    const rows: Row[] = [
      { stepId: '01-worktree', round: 0, runSeq: 0, createdAt: 1, stepIndex: 101 },
      { stepId: '01b-install-plugins', round: 0, runSeq: 2, createdAt: 2, stepIndex: 101.2 },
      { stepId: '01a-app-boot', round: 0, runSeq: 4, createdAt: 3, stepIndex: 101.5 },
      { stepId: '01c-ddev-env', round: 0, runSeq: 5, createdAt: 4, stepIndex: 101.6 },
      { stepId: '06-run-config', round: 0, runSeq: 6, createdAt: 5, stepIndex: 106.05 },
      { stepId: '01-debug-mode', round: 0, runSeq: 1, createdAt: 10, stepIndex: 101.1 },
      { stepId: '01d-browser-access', round: 0, runSeq: 3, createdAt: 11, stepIndex: 101.3 },
    ];
    expect(ids([...rows].sort(byRunSeq))).toEqual([
      '01-worktree',
      '01-debug-mode',
      '01b-install-plugins',
      '01d-browser-access',
      '01a-app-boot',
      '01c-ddev-env',
      '06-run-config',
    ]);
    // The old key dumped the late-created steps to the bottom (the reported bug).
    expect(ids([...rows].sort(byCreatedAt)).slice(-2)).toEqual([
      '01-debug-mode',
      '01d-browser-access',
    ]);
  });

  it('orders run_app reused steps by run position despite non-monotonic step_index', () => {
    // run_app reuses env_replicate steps (declare-deps=1, gen-dockerfile=2, build-image=3)
    // and its own 98-choose-view (global 400) at positions that do not match step_index.
    const rows: Row[] = [
      { stepId: '01-declare-deps', round: 0, runSeq: 0, createdAt: 1, stepIndex: 1 },
      { stepId: '01-worktree', round: 0, runSeq: 1, createdAt: 2, stepIndex: 101 },
      { stepId: '01-debug-mode', round: 0, runSeq: 2, createdAt: 3, stepIndex: 101.1 },
      { stepId: '98-choose-view', round: 0, runSeq: 3, createdAt: 4, stepIndex: 400 },
      { stepId: '02-generate-dockerfile', round: 0, runSeq: 4, createdAt: 5, stepIndex: 2 },
      { stepId: '03-build-image', round: 0, runSeq: 5, createdAt: 6, stepIndex: 3 },
      { stepId: '01a-app-boot', round: 0, runSeq: 6, createdAt: 7, stepIndex: 101.5 },
      { stepId: '99-run-app-ready', round: 0, runSeq: 7, createdAt: 8, stepIndex: 401 },
    ];
    const expected = [
      '01-declare-deps',
      '01-worktree',
      '01-debug-mode',
      '98-choose-view',
      '02-generate-dockerfile',
      '03-build-image',
      '01a-app-boot',
      '99-run-app-ready',
    ];
    expect(ids([...rows].sort(byRunSeq))).toEqual(expected);
    // A step_index sort would hoist gen-dockerfile/build-image and sink choose-view.
    expect(ids([...rows].sort(byStepIndex))).not.toEqual(expected);
  });

  it('groups fix-loop rounds: the whole round-0 block, then each round-N block, by run position', () => {
    const rows: Row[] = [
      { stepId: '07-implement', round: 1, runSeq: 10, createdAt: 20, stepIndex: 107 },
      { stepId: '08-verify', round: 0, runSeq: 11, createdAt: 12, stepIndex: 108 },
      { stepId: '07-implement', round: 0, runSeq: 10, createdAt: 11, stepIndex: 107 },
      { stepId: '08-verify', round: 1, runSeq: 11, createdAt: 21, stepIndex: 108 },
    ];
    expect([...rows].sort(byRunSeq).map((r) => `${r.stepId}@${r.round}`)).toEqual([
      '07-implement@0',
      '08-verify@0',
      '07-implement@1',
      '08-verify@1',
    ]);
  });

  it('falls back to created_at for legacy rows that have no run_seq', () => {
    const rows: Row[] = [
      { stepId: 'b', round: 0, runSeq: null, createdAt: 2, stepIndex: 5 },
      { stepId: 'a', round: 0, runSeq: null, createdAt: 1, stepIndex: 9 },
    ];
    expect(ids([...rows].sort(byRunSeq))).toEqual(['a', 'b']);
  });

  it('run_seq derived from orderWorkflowRunList places the env-replicate prelude after triage', () => {
    // run_seq = index in orderWorkflowRunList, so the prelude (low env_replicate indices)
    // lands between triage and the first workflow step — the position step_index misses.
    const step = (id: string, workflowType: string): OrderableStep => ({
      metadata: { id, workflowType },
    });
    const main: OrderableStep[] = [
      step(MODEL_HEALTH_STEP_ID, 'workflow'),
      step(SYNC_BASE_STEP_ID, 'workflow'),
      step(TRIAGE_STEP_ID, 'workflow'),
      step('01-worktree-setup', 'workflow'),
      step('07-phase-2-implement', 'workflow'),
    ];
    const prelude: OrderableStep[] = [
      step('01-declare-deps', 'env_replicate'),
      step('02-generate-dockerfile', 'env_replicate'),
    ];
    const ordered = orderWorkflowRunList(main, prelude, null).map((s) => s.metadata.id);
    const seq = (id: string): number => ordered.indexOf(id);
    expect(seq('01-declare-deps')).toBeGreaterThan(seq(TRIAGE_STEP_ID));
    expect(seq('02-generate-dockerfile')).toBeLessThan(seq('01-worktree-setup'));
  });
});
