import { describe, it, expect } from 'vitest';
import {
  runtimeAdmissionDecision,
  parseRunnerWeights,
  type RuntimeAdmissionInput,
} from './runtime-admission.js';

/** A 16 GB host: budget 11469 MB, ddev 4096 MB, app 2048 MB. */
const BUDGET = 11469;
const DDEV = 4096;
const APP = 2048;

function decide(over: Partial<RuntimeAdmissionInput> = {}): 'proceed' | 'park' {
  return runtimeAdmissionDecision({
    budgetMb: BUDGET,
    busyMb: 0,
    myWeightMb: DDEV,
    weightsAheadMb: [],
    hasLiveRunner: false,
    maxCount: null,
    busyCount: 0,
    ...over,
  });
}

describe('runtimeAdmissionDecision', () => {
  it('proceeds when the governor is disabled, whatever the load', () => {
    expect(decide({ budgetMb: null, busyMb: 999_999, busyCount: 99 })).toBe('proceed');
  });

  it('proceeds when the task already holds a runner, even past the budget', () => {
    // reuse/warm-start needs no new capacity, so a task that already owns its runner is
    // never parked.
    expect(decide({ hasLiveRunner: true, busyMb: BUDGET, busyCount: 5 })).toBe('proceed');
  });

  it('admits DDEV runners up to the budget and parks the third', () => {
    expect(decide({ busyMb: 0, busyCount: 0 })).toBe('proceed');
    expect(decide({ busyMb: DDEV, busyCount: 1 })).toBe('proceed');
    expect(decide({ busyMb: DDEV * 2, busyCount: 2 })).toBe('park');
  });

  it('lets a light runner use capacity a DDEV cannot — the point of a byte budget', () => {
    // 11469 - 2*4096 = 3277 MB left: too little for another DDEV, plenty for an app-runner.
    const busyMb = DDEV * 2;
    expect(decide({ busyMb, busyCount: 2, myWeightMb: DDEV })).toBe('park');
    expect(decide({ busyMb, busyCount: 2, myWeightMb: APP })).toBe('proceed');
  });

  it('packs five app-runners where the old count cap allowed two runtimes', () => {
    for (let n = 0; n < 5; n++) {
      expect(decide({ busyMb: APP * n, busyCount: n, myWeightMb: APP })).toBe('proceed');
    }
    expect(decide({ busyMb: APP * 5, busyCount: 5, myWeightMb: APP })).toBe('park');
  });

  it('never lets a latecomer take capacity the queue ahead of it needs', () => {
    // 7373 MB free with one DDEV up. A light runner fits on its own...
    expect(decide({ busyMb: DDEV, busyCount: 1, myWeightMb: APP })).toBe('proceed');
    // ...but not when two DDEV runners have been waiting longer.
    expect(
      decide({ busyMb: DDEV, busyCount: 1, myWeightMb: APP, weightsAheadMb: [DDEV, DDEV] }),
    ).toBe('park');
    // One queued ahead still leaves room for it.
    expect(decide({ busyMb: DDEV, busyCount: 1, myWeightMb: APP, weightsAheadMb: [DDEV] })).toBe(
      'proceed',
    );
  });

  it('admits on an idle machine even when the weight exceeds the whole budget', () => {
    // A fat per-task memory pin (or a mis-set weight) must not park forever waiting for
    // capacity that cannot exist — running it alone beats running nothing.
    expect(decide({ myWeightMb: BUDGET + 8192, busyMb: 0, busyCount: 0 })).toBe('proceed');
    // But it still yields to anything already running or queued ahead.
    expect(decide({ myWeightMb: BUDGET + 8192, busyMb: APP, busyCount: 1 })).toBe('park');
    expect(decide({ myWeightMb: BUDGET + 8192, weightsAheadMb: [APP] })).toBe('park');
  });

  it('enforces an admin-pinned count cap alongside the budget', () => {
    // Budget alone would take four app-runners; the pin stops at two.
    expect(decide({ myWeightMb: APP, busyMb: APP * 2, busyCount: 2, maxCount: 2 })).toBe('park');
    expect(decide({ myWeightMb: APP, busyMb: APP, busyCount: 1, maxCount: 2 })).toBe('proceed');
  });
});

describe('parseRunnerWeights', () => {
  it('reads the task id and stamped weight off each runner line', () => {
    expect(parseRunnerWeights('task-a|c001|4096\ntask-b|c002|2048\n', DDEV)).toEqual(
      new Map([
        ['task-a', 4096],
        ['task-b', 2048],
      ]),
    );
  });

  it('falls back to the caller-supplied weight for a runner with no weight label', () => {
    // Runners started before the label existed, or with the governor off, must still occupy
    // capacity — counting them as free is what overcommits the host. Callers pass the heaviest
    // kind for exactly this reason.
    expect(parseRunnerWeights('task-a|c001|\ntask-b|c002|not-a-number\n', DDEV)).toEqual(
      new Map([
        ['task-a', DDEV],
        ['task-b', DDEV],
      ]),
    );
  });

  it('falls back to the container id when a runner carries no task label', () => {
    // Occupancy is keyed by task; an unlabeled runner still consumes machine capacity, so it
    // must contribute its own distinct key rather than collapsing with every other unlabeled
    // runner under the empty string.
    expect(parseRunnerWeights('|c001|2048\n|c002|2048\n', DDEV)).toEqual(
      new Map([
        ['container:c001', 2048],
        ['container:c002', 2048],
      ]),
    );
  });

  it('counts a task holding two runners at the heavier one, not their sum', () => {
    // One task = one environment; taskHasLiveRunner already treats both labels as one holding.
    expect(parseRunnerWeights('task-a|c001|2048\ntask-a|c002|4096\n', DDEV)).toEqual(
      new Map([['task-a', 4096]]),
    );
  });

  it('ignores blank lines and empty output', () => {
    expect(parseRunnerWeights('', DDEV).size).toBe(0);
    expect(parseRunnerWeights('\n  \ntask-a|c001|4096\n', DDEV)).toEqual(
      new Map([['task-a', 4096]]),
    );
  });
});
