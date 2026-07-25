import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CLI_TIMEOUT_BASE_MINUTES,
  DEFAULT_CLI_TIMEOUT_LADDER,
  escalatedTimeoutMs,
  parseTimeoutLadder,
} from '../src/constants/index.js';

const MIN = 60_000;
const DEFAULTS = {
  baseMinutes: DEFAULT_CLI_TIMEOUT_BASE_MINUTES,
  ladder: [...DEFAULT_CLI_TIMEOUT_LADDER],
};

describe('parseTimeoutLadder', () => {
  it('parses fractional multipliers', () => {
    expect(parseTimeoutLadder('1,1.33,2')).toEqual([1, 1.33, 2]);
    expect(parseTimeoutLadder(' 1 , 1.5 , 3 ')).toEqual([1, 1.5, 3]);
  });

  it('drops entries that are not finite positive numbers', () => {
    expect(parseTimeoutLadder('1,abc,2')).toEqual([1, 2]);
    expect(parseTimeoutLadder('1,0,-2,2')).toEqual([1, 2]);
  });

  it('falls back to the built-in ladder when nothing usable survives', () => {
    // A typo in the admin field must never yield an empty ladder — escalatedTimeoutMs
    // would then have no rung to read and a zero budget SIGKILLs every CLI at spawn.
    for (const junk of ['', '   ', 'nonsense', '0', null, undefined]) {
      expect(parseTimeoutLadder(junk)).toEqual([...DEFAULT_CLI_TIMEOUT_LADDER]);
    }
  });
});

describe('escalatedTimeoutMs', () => {
  it('lifts a step that declares less than the base up to the base', () => {
    // 07b-phase-4-validate declares 30m; the fixer pass that burned three 31-minute
    // attempts is exactly the case this floor exists for.
    expect(escalatedTimeoutMs(30 * MIN, 0, DEFAULTS)).toBe(45 * MIN);
    expect(escalatedTimeoutMs(30 * MIN, 1, DEFAULTS)).toBe(Math.round(45 * 1.33) * MIN);
    expect(escalatedTimeoutMs(30 * MIN, 2, DEFAULTS)).toBe(90 * MIN);
  });

  it('keeps a step that declares more than the base and escalates from there', () => {
    // 07-phase-2-implement asks 60m; the floor must not shorten it.
    expect(escalatedTimeoutMs(60 * MIN, 0, DEFAULTS)).toBe(60 * MIN);
    expect(escalatedTimeoutMs(60 * MIN, 1, DEFAULTS)).toBe(Math.round(60 * 1.33) * MIN);
    expect(escalatedTimeoutMs(60 * MIN, 2, DEFAULTS)).toBe(120 * MIN);
  });

  it('treats an undeclared timeout as the base', () => {
    expect(escalatedTimeoutMs(undefined, 0, DEFAULTS)).toBe(45 * MIN);
  });

  it('clamps an attempt past the end of the ladder to the last rung', () => {
    // MAX_ORPHAN_REDISPATCH bounds this in practice, but a mixed orphan/timeout run
    // must not index off the end and produce NaN.
    expect(escalatedTimeoutMs(30 * MIN, 7, DEFAULTS)).toBe(90 * MIN);
  });

  it('clamps a negative attempt to the first rung', () => {
    expect(escalatedTimeoutMs(30 * MIN, -1, DEFAULTS)).toBe(45 * MIN);
  });

  it('never returns zero for an empty ladder', () => {
    expect(escalatedTimeoutMs(30 * MIN, 0, { baseMinutes: 45, ladder: [] })).toBe(45 * MIN);
  });

  it('honours a custom base and ladder', () => {
    expect(escalatedTimeoutMs(10 * MIN, 1, { baseMinutes: 20, ladder: [1, 3] })).toBe(60 * MIN);
  });
});
