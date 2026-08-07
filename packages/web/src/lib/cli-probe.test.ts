import { describe, it, expect } from 'vitest';
import { probePhaseForState, PROBE_POLL_TIMEOUT_MS } from './cli-probe.js';

describe('probePhaseForState', () => {
  it('calls only an active job running', () => {
    expect(probePhaseForState('active')).toBe('running');
  });

  it('collapses every way of waiting into one queued phase', () => {
    // The bug this whole polling path replaced: a probe sitting behind multi-minute agent
    // runs was indistinguishable from a broken provider. Which flavour of waiting it is
    // ('prioritized' vs 'waiting' is a BullMQ storage detail, not user-facing) must not
    // leak into the label — all of them mean the same thing to the person clicking Test.
    for (const state of ['waiting', 'prioritized', 'delayed', 'waiting-children']) {
      expect(probePhaseForState(state)).toBe('queued');
    }
  });

  it('treats an unreported state as queued', () => {
    // A pending response with no state is still pending; guessing "running" would claim
    // work that may not have started.
    expect(probePhaseForState(undefined)).toBe('queued');
  });
});

describe('PROBE_POLL_TIMEOUT_MS', () => {
  it('stays under the server-side job retention', () => {
    // PROBE_JOB_RETENTION_S in packages/api/src/routes/cli-providers.ts. Polling past the
    // point where the finished job is reaped would report "expired" for a probe that
    // succeeded — the exact false failure this change exists to remove.
    expect(PROBE_POLL_TIMEOUT_MS).toBeLessThan(900 * 1000);
  });
});
