import { describe, expect, it } from 'vitest';
import { sumStepOutputTokens } from './step-output-tokens.js';

const u = (outputTokens: number | null, totalTokens = 100, outputUnknownRuns?: number) => ({
  outputTokens,
  totalTokens,
  ...(outputUnknownRuns === undefined ? {} : { outputUnknownRuns }),
});

describe('sumStepOutputTokens', () => {
  it('is null when every step with usage is unknown', () => {
    expect(sumStepOutputTokens([u(null), u(null), null])).toEqual({
      output: null,
      unknownRuns: 2,
    });
  });

  it('sums the known outputs and counts the unknown runs', () => {
    expect(sumStepOutputTokens([u(10), u(null), u(5, 100, 2)])).toEqual({
      output: 15,
      unknownRuns: 3,
    });
  });

  it('keeps no usage and a known zero at zero', () => {
    expect(sumStepOutputTokens([null, null])).toEqual({ output: 0, unknownRuns: 0 });
    expect(sumStepOutputTokens([u(0)])).toEqual({ output: 0, unknownRuns: 0 });
  });

  it('does not count a null output with no tokens as unknown', () => {
    expect(sumStepOutputTokens([u(null, 0)])).toEqual({ output: null, unknownRuns: 0 });
  });

  it('is order independent', () => {
    const list = [u(10), u(null), u(5, 100, 2)];
    expect(sumStepOutputTokens([...list].reverse())).toEqual(sumStepOutputTokens(list));
  });
});
