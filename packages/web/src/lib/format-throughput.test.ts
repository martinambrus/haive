import { describe, expect, it } from 'vitest';
import { formatSampledTps, formatTps, ratePerSecond } from './format-throughput';

describe('formatTps', () => {
  it('keeps one decimal under 10 and rounds above', () => {
    expect(formatTps(2.75)).toBe('2.8 tok/s');
    expect(formatTps(79.4)).toBe('79 tok/s');
  });

  it('renders a missing rate as a dash, not zero', () => {
    expect(formatTps(null)).toBe('—');
    expect(formatTps(Number.NaN)).toBe('—');
  });
});

describe('ratePerSecond', () => {
  it('divides tokens by seconds', () => {
    expect(ratePerSecond(155, 2275)).toBeCloseTo(68.13, 2);
  });

  it('is null without a positive duration or a token count', () => {
    expect(ratePerSecond(155, 0)).toBeNull();
    expect(ratePerSecond(155, null)).toBeNull();
    expect(ratePerSecond(null, 1000)).toBeNull();
  });
});

describe('formatSampledTps', () => {
  it('prints the sample count instead of a rate below the floor', () => {
    expect(formatSampledTps({ tps: 50, n: 3, sufficient: false })).toBe('n=3');
    expect(formatSampledTps({ tps: 50, n: 9, sufficient: true })).toBe('50 tok/s');
    expect(formatSampledTps({ tps: null, n: 0, sufficient: false })).toBe('—');
  });
});
