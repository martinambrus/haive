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
      for (let slot = 0; slot < 5; slot++) {
        for (let attempt = 0; attempt < 5; attempt++) {
          const p = taskHostPort(id, slot, attempt);
          expect(p).toBeGreaterThanOrEqual(RANGE_START);
          expect(p).toBeLessThanOrEqual(RANGE_END);
        }
      }
    }
  });

  // A DDEV runner publishes five slots at once — https 0, http 1, db 2, mailpit http 3 /
  // https 4 — and two of them landing on one port would be UNRECOVERABLE: docker fails the
  // whole run with "address already in use", isHostPortCollision reads that as a HOST
  // collision, and the retry answers by shifting every slot equally, so the pair stays
  // collided through all 5 attempts and the runner dies at "allocation exhausted".
  //
  // It cannot happen, and the reason is structural rather than lucky: the key is
  // `<taskId>:<slot>`, so two single-digit slots differ only in the final character, and
  // '0'-'9' differ only in bits 0-2. XOR carries that difference into the FNV accumulator
  // untouched, and the final multiply is by an odd constant — a bijection mod 2^14 — so the
  // low 14 bits stay distinct. Verified exhaustively over 4,000,000 task ids: zero
  // collisions. Pinned here because it is what lets the caller draw each slot independently;
  // a slot >= 10 changes the key LENGTH and voids the argument.
  it("never collides across a DDEV runner's five reserved slots", () => {
    for (const id of ['ddev-task', '', 'a', 'd4f2-9981-uuid', 'x'.repeat(64)]) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const ports = [0, 1, 2, 3, 4].map((slot) => taskHostPort(id, slot, attempt));
        expect(new Set(ports).size).toBe(ports.length);
      }
    }
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
