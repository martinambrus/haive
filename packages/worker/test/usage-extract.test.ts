import { describe, expect, it } from 'vitest';
import { sumTokenUsage } from '../src/cli-executor/usage-extract.js';

const usage = (peak?: number) => ({
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
  ...(peak === undefined ? {} : { peakPromptTokens: peak }),
});

describe('sumTokenUsage peakPromptTokens', () => {
  it('takes the max of the two peaks and still sums the other fields', () => {
    expect(sumTokenUsage(usage(100), usage(250))).toEqual({
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
      peakPromptTokens: 250,
    });
  });

  it('keeps the one peak when only one side has it', () => {
    expect(sumTokenUsage(usage(100), usage())?.peakPromptTokens).toBe(100);
    expect(sumTokenUsage(usage(), usage(250))?.peakPromptTokens).toBe(250);
  });

  it('leaves the key absent when neither side has it', () => {
    expect(sumTokenUsage(usage(), usage())).not.toHaveProperty('peakPromptTokens');
  });
});
