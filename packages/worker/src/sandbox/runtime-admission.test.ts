import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CONFIG_KEYS, ConfigUnavailableError, configService } from '@haive/shared';
import { getRedis } from '../redis.js';
import {
  RuntimeSlotAbortedError,
  acquireRuntimeSlot,
  runtimeAdmission,
  runtimeAdmissionDecision,
  parseRunnerWeights,
  type BrowserSurcharge,
  type RuntimeAdmissionInput,
} from './runtime-admission.js';

// docker ps answers nothing and Redis is not initialised: the gate sees an idle host and every
// Redis side effect is a soft failure, so only the config reads steer these tests.
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: null, out: { stdout: string }) => void;
    cb(null, { stdout: '' });
  },
}));
vi.mock('../redis.js', () => ({
  getRedis: vi.fn(() => {
    throw new Error('Redis not initialized');
  }),
}));

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

describe('parseRunnerWeights browser surcharge', () => {
  /** A 16 GB host's calibrated weights: ddev 1536 + browser 1536. */
  const DDEV_BASE = 1536;
  const BROWSER = 1536;
  const surcharge = (containers: string[]): BrowserSurcharge => ({
    containers: new Set(containers),
    weightMb: BROWSER,
    capMb: DDEV_BASE + BROWSER,
  });

  it('charges a runner only while its desktop is up', () => {
    const line = `task-a|c001|${DDEV_BASE}|haive-ddev-aaaa\n`;
    expect(parseRunnerWeights(line, DDEV_BASE, surcharge([]))).toEqual(
      new Map([['task-a', DDEV_BASE]]),
    );
    expect(parseRunnerWeights(line, DDEV_BASE, surcharge(['haive-ddev-aaaa']))).toEqual(
      new Map([['task-a', DDEV_BASE + BROWSER]]),
    );
  });

  it('never double-charges a runner whose label already includes the surcharge', () => {
    // Every runner created before the surcharge moved out of the label carries base+browser in
    // it. Adding the live surcharge on top would price one Chromium twice.
    const legacy = `task-a|c001|${DDEV_BASE + BROWSER}|haive-ddev-aaaa\n`;
    expect(parseRunnerWeights(legacy, DDEV_BASE, surcharge(['haive-ddev-aaaa']))).toEqual(
      new Map([['task-a', DDEV_BASE + BROWSER]]),
    );
  });

  it('leaves a per-task memory pin alone', () => {
    // A pin states exactly what the container may occupy, desktop included, so the cap must not
    // clamp it DOWN to the class ceiling either.
    const pinned = `task-a|c001|8192|haive-ddev-aaaa\n`;
    expect(parseRunnerWeights(pinned, DDEV_BASE, surcharge(['haive-ddev-aaaa']))).toEqual(
      new Map([['task-a', 8192]]),
    );
  });

  it('only charges the containers on the list', () => {
    const two = `task-a|c001|${DDEV_BASE}|haive-ddev-aaaa\ntask-b|c002|${DDEV_BASE}|haive-ddev-bbbb\n`;
    expect(parseRunnerWeights(two, DDEV_BASE, surcharge(['haive-ddev-bbbb']))).toEqual(
      new Map([
        ['task-a', DDEV_BASE],
        ['task-b', DDEV_BASE + BROWSER],
      ]),
    );
  });

  it('is a no-op for callers that pass no surcharge', () => {
    // The pre-feature shape (three fields, no name) must parse identically.
    expect(parseRunnerWeights(`task-a|c001|${DDEV_BASE}|haive-ddev-aaaa\n`, DDEV_BASE)).toEqual(
      new Map([['task-a', DDEV_BASE]]),
    );
  });
});

type ReadMode = 'ok' | 'down' | 'plain' | 'off';

describe('runtime admission over an unreadable config store', () => {
  let mode: ReadMode;
  let maxConcurrent: number;
  const down = () => new ConfigUnavailableError('get');

  beforeEach(() => {
    mode = 'ok';
    maxConcurrent = 0;
    vi.mocked(getRedis).mockClear();
    vi.spyOn(configService, 'getBoolean').mockImplementation(async () => {
      if (mode === 'down') throw down();
      if (mode === 'plain') throw new Error('ConfigService not initialized');
      return mode !== 'off';
    });
    vi.spyOn(configService, 'getNumber').mockImplementation(async (key: string) => {
      if (mode === 'down') throw down();
      if (mode === 'plain') throw new Error('ConfigService not initialized');
      return key === CONFIG_KEYS.MAX_CONCURRENT_RUNTIMES ? maxConcurrent : 0;
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('runtimeAdmission', () => {
    it('parks, flagged unreadable, and touches no park queue', async () => {
      mode = 'down';
      const r = await runtimeAdmission('task-a', 'app');
      expect(r.decision).toBe('park');
      expect(r.unreadable).toBe(true);
      expect(getRedis).not.toHaveBeenCalled();
    });

    it('still proceeds idle when the switch is readable and off', async () => {
      mode = 'off';
      const r = await runtimeAdmission('task-a', 'app');
      expect(r.decision).toBe('proceed');
      expect(r.unreadable).toBeUndefined();
    });

    it('keeps the lenient result for a non-config error', async () => {
      mode = 'plain';
      const r = await runtimeAdmission('task-a', 'app');
      expect(r.decision).toBe('proceed');
      expect(r.unreadable).toBeUndefined();
    });
  });

  describe('pump', () => {
    it('keeps a queued waiter queued while the store is unreadable, then follows the normal decision', async () => {
      vi.useFakeTimers();
      maxConcurrent = 1;
      const first = await acquireRuntimeSlot('pump-1', 'app');
      let second: (() => void) | null = null;
      let secondErr: unknown = null;
      void acquireRuntimeSlot('pump-2', 'app').then(
        (rel) => (second = rel),
        (e) => (secondErr = e),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(second).toBeNull();

      mode = 'down';
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(second).toBeNull();
      expect(secondErr).toBeNull();

      mode = 'ok';
      await vi.advanceTimersByTimeAsync(15_000);
      // pool is still full, so the normal decision keeps it waiting
      expect(second).toBeNull();
      first();
      await vi.advanceTimersByTimeAsync(0);
      expect(second).not.toBeNull();
      (second as unknown as () => void)();
    });
  });

  describe('acquireRuntimeSlot', () => {
    it('stays pending while reads fail and resolves once they answer', async () => {
      vi.useFakeTimers();
      mode = 'down';
      let rel: (() => void) | null = null;
      void acquireRuntimeSlot('acq-1', 'app').then((r) => (rel = r));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(rel).toBeNull();
      mode = 'ok';
      await vi.advanceTimersByTimeAsync(2_000);
      expect(rel).not.toBeNull();
      (rel as unknown as () => void)();
    });

    it('rejects with the config error once the admission deadline passes', async () => {
      vi.useFakeTimers();
      mode = 'down';
      const result = expect(acquireRuntimeSlot('acq-2', 'app')).rejects.toBeInstanceOf(
        ConfigUnavailableError,
      );
      await vi.advanceTimersByTimeAsync(8 * 60_000 + 4_000);
      await result;
    });

    it('rejects as aborted when the signal fires while waiting', async () => {
      vi.useFakeTimers();
      mode = 'down';
      const ac = new AbortController();
      const result = expect(
        acquireRuntimeSlot('acq-3', 'app', undefined, ac.signal),
      ).rejects.toBeInstanceOf(RuntimeSlotAbortedError);
      await vi.advanceTimersByTimeAsync(3_000);
      ac.abort();
      await vi.advanceTimersByTimeAsync(2_000);
      await result;
    });
  });
});
