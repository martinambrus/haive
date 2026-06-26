import { describe, expect, it } from 'vitest';
import { taskHostPort } from '../src/constants/index.js';

const RANGE_START = 49152;
const RANGE_END = 65535;
const RANGE_SIZE = 16384;

describe('taskHostPort', () => {
  it('is deterministic for the same (taskId, slot, attempt)', () => {
    expect(taskHostPort('task-abc', 0, 0)).toBe(taskHostPort('task-abc', 0, 0));
    expect(taskHostPort('task-abc', 1, 3)).toBe(taskHostPort('task-abc', 1, 3));
  });

  it('always lands in the ephemeral range 49152–65535', () => {
    for (const id of ['a', 'task-1', 'd4f2-9981-uuid', '']) {
      for (let slot = 0; slot < 2; slot++) {
        for (let attempt = 0; attempt < 5; attempt++) {
          const p = taskHostPort(id, slot, attempt);
          expect(p).toBeGreaterThanOrEqual(RANGE_START);
          expect(p).toBeLessThanOrEqual(RANGE_END);
        }
      }
    }
  });

  it("separates a DDEV runner's https (slot 0) and http (slot 1) ports", () => {
    // Same task, different slot keys → different hash → distinct ports so the two
    // -p publishes never collide on one runner.
    expect(taskHostPort('ddev-task', 0)).not.toBe(taskHostPort('ddev-task', 1));
  });

  it('shifts by a fixed stride of 257 per retry attempt (next collision candidate)', () => {
    const base = taskHostPort('coll', 0, 0) - RANGE_START;
    for (let attempt = 1; attempt < 6; attempt++) {
      const expected = RANGE_START + ((base + attempt * 257) % RANGE_SIZE);
      expect(taskHostPort('coll', 0, attempt)).toBe(expected);
    }
  });

  it('yields distinct candidates across consecutive retries (257 coprime to 2^14)', () => {
    // The collision-retry loop relies on each attempt producing an unused port;
    // 257 is prime and the range is 2^14, so the first 16384 attempts never repeat.
    const seen = new Set<number>();
    for (let attempt = 0; attempt < 32; attempt++) {
      seen.add(taskHostPort('retry-seq', 0, attempt));
    }
    expect(seen.size).toBe(32);
  });
});
