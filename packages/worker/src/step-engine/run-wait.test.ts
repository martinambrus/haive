import { describe, expect, it } from 'vitest';
import { runIsLive } from './run-wait.js';

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
