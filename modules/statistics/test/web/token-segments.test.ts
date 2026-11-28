import { describe, expect, it } from 'vitest';
import type { StatsNormalizedTokens } from '../../src/web/api.js';
import { tokenSegments } from '../../src/web/stats-page.js';

const tokens = (over: Partial<StatsNormalizedTokens>): StatsNormalizedTokens => ({
  freshInputTokens: 10,
  outputTokens: 5,
  outputUnknownRuns: 0,
  cacheReadTokens: 100,
  cacheCreationTokens: 20,
  totalTokens: 135,
  cacheHitRatio: null,
  cacheWriteShare: null,
  ...over,
});

const output = (t: StatsNormalizedTokens) => tokenSegments(t).find((s) => s.key === 'output')!;

describe('tokenSegments output', () => {
  it('keeps a known output and its plain label', () => {
    expect(output(tokens({}))).toMatchObject({ label: 'Output', value: 5 });
  });

  it('labels the output as a lower bound when runs never reported it', () => {
    expect(output(tokens({ outputUnknownRuns: 2 }))).toMatchObject({
      label: 'Output (at least)',
      value: 5,
    });
  });

  it('draws an unknown output as nothing without throwing', () => {
    expect(output(tokens({ outputTokens: null, outputUnknownRuns: 1 })).value).toBe(0);
  });
});
