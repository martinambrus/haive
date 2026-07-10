import { describe, expect, it } from 'vitest';
import { softTimeoutDelayMs } from './exec-core.js';
import { DEFAULT_RUN_TIMEOUT_MS } from '../../sandbox/docker-runner.js';

const THIRTY_MIN = 30 * 60_000;

describe('softTimeoutDelayMs', () => {
  it('fires at the configured percent of the budget', () => {
    expect(softTimeoutDelayMs(THIRTY_MIN, 80)).toBe(24 * 60_000);
    // The plan's verification setting: a 30-minute review winds down after 90 seconds.
    expect(softTimeoutDelayMs(THIRTY_MIN, 5)).toBe(90_000);
  });

  it('leaves headroom for a tool-call boundary plus the JSON write', () => {
    // Steers apply at the next tool-call boundary, so the unspent remainder is the
    // only budget the CLI has to actually emit its findings before the SIGKILL.
    const delay = softTimeoutDelayMs(THIRTY_MIN, 80)!;
    expect(THIRTY_MIN - delay).toBe(6 * 60_000);
  });

  it('refuses a percent that would land the wind-down uselessly', () => {
    expect(softTimeoutDelayMs(THIRTY_MIN, 0)).toBeNull(); // before the CLI reads anything
    expect(softTimeoutDelayMs(THIRTY_MIN, 100)).toBeNull(); // after the SIGKILL
    expect(softTimeoutDelayMs(THIRTY_MIN, -10)).toBeNull();
    expect(softTimeoutDelayMs(THIRTY_MIN, 120)).toBeNull();
  });

  it('winds down against the runner default when the step named no timeout', () => {
    // A step with no timeoutMs is not un-timed: docker-runner SIGKILLs it at its own
    // default. The soft timeout must fire inside that budget, not be skipped.
    const delay = softTimeoutDelayMs(DEFAULT_RUN_TIMEOUT_MS, 80);
    expect(delay).not.toBeNull();
    expect(delay!).toBeLessThan(DEFAULT_RUN_TIMEOUT_MS);
  });

  it('refuses a budget with no room in it', () => {
    expect(softTimeoutDelayMs(0, 80)).toBeNull();
    expect(softTimeoutDelayMs(-1, 80)).toBeNull();
    // 80% of 1ms floors to 0 -- a timer at 0 would fire before the CLI spawns
    expect(softTimeoutDelayMs(1, 80)).toBeNull();
  });
});
