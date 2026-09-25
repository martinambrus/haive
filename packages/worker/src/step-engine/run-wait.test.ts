import { describe, expect, it } from 'vitest';
import { runIsLive, runNeverAnswered } from './run-wait.js';
import { CLI_PREEMPTED_HEADLINE } from '../queues/cli-exec/failure-class.js';

describe('runIsLive', () => {
  it('is live for a run neither ended nor superseded', () => {
    expect(runIsLive({ endedAt: null, supersededAt: null })).toBe(true);
  });

  it('is not live once the run ended', () => {
    expect(runIsLive({ endedAt: new Date(), supersededAt: null })).toBe(false);
  });

  it('is not live for a run superseded before it started', () => {
    expect(runIsLive({ endedAt: null, supersededAt: new Date() })).toBe(false);
  });
});

describe('runNeverAnswered', () => {
  it('is true for a run that never started', () => {
    expect(runNeverAnswered({ errorMessage: null, startedAt: null, supersededAt: null })).toBe(
      true,
    );
  });

  it('is true for a started run the preemption sweeper killed', () => {
    expect(
      runNeverAnswered({
        errorMessage: `${CLI_PREEMPTED_HEADLINE}: killed for a higher-priority task`,
        startedAt: new Date(),
        supersededAt: null,
      }),
    ).toBe(true);
  });

  it('is true for a started run a Retry, Resume or Stop superseded', () => {
    expect(
      runNeverAnswered({ errorMessage: null, startedAt: new Date(), supersededAt: new Date() }),
    ).toBe(true);
  });

  it('is false for a started run neither preempted nor superseded', () => {
    expect(
      runNeverAnswered({ errorMessage: null, startedAt: new Date(), supersededAt: null }),
    ).toBe(false);
  });
});
