import { describe, it, expect } from 'vitest';
import { jobPhaseForState, POLL_TIMEOUT_MS } from './cli-jobs';

describe('jobPhaseForState', () => {
  it('calls only an active job running', () => {
    expect(jobPhaseForState('active')).toBe('running');
  });

  it('collapses every way of waiting into one queued phase', () => {
    // The bug this whole polling path replaced: a job sitting behind multi-minute agent runs
    // was indistinguishable from a broken provider. Which flavour of waiting it is
    // ('prioritized' vs 'waiting' is a BullMQ storage detail, not user-facing) must not leak
    // into the label — all of them mean the same thing to the person who clicked the button.
    for (const state of ['waiting', 'prioritized', 'delayed', 'waiting-children']) {
      expect(jobPhaseForState(state)).toBe('queued');
    }
  });

  it('treats an unreported state as queued', () => {
    // A pending response with no state is still pending; guessing "running" would claim work
    // that may not have started.
    expect(jobPhaseForState(undefined)).toBe('queued');
  });
});

describe('POLL_TIMEOUT_MS', () => {
  it('stays under the server-side job retention', () => {
    // POLLABLE_JOB_RETENTION_S in packages/api/src/routes/cli-providers.ts. Polling past the
    // point where the finished job is reaped would report "expired" for work that succeeded —
    // the exact false failure this change exists to remove.
    expect(POLL_TIMEOUT_MS).toBeLessThan(900 * 1000);
  });
});
