import { describe, expect, it } from 'vitest';
import {
  convertCost,
  describeCostSource,
  formatCost,
  USD_DISPLAY,
  type CostDisplay,
} from './format-cost';

// Live ECB figure for 2026-08-18: 1 EUR = 1.1576 USD.
const EUR: CostDisplay = {
  currency: 'EUR',
  usdPerUnit: 1.1576,
  rateDate: '2026-08-18',
  approximate: false,
};

describe('convertCost', () => {
  it('divides by USD-per-unit', () => {
    expect(convertCost(11.576, EUR)).toBeCloseTo(10, 9);
    expect(convertCost(5, USD_DISPLAY)).toBe(5);
  });

  it('falls back to the USD amount on an unusable rate instead of NaN', () => {
    expect(convertCost(5, null)).toBe(5);
    expect(convertCost(5, { ...EUR, usdPerUnit: 0 })).toBe(5);
    expect(convertCost(5, { ...EUR, usdPerUnit: Number.NaN })).toBe(5);
  });
});

describe('formatCost', () => {
  it('formats in the display currency', () => {
    expect(formatCost(11.576, EUR)).toContain('10.00');
    expect(formatCost(7.18, USD_DISPLAY)).toContain('7.18');
  });

  it('keeps four decimals for a small non-zero cost', () => {
    // A third of a cent must not render as "$0.00" — a displayed zero reads as free.
    const out = formatCost(0.0034, USD_DISPLAY);
    expect(out).toContain('0.0034');
  });

  it('renders an exact zero plainly', () => {
    expect(formatCost(0, USD_DISPLAY)).toContain('0.00');
  });

  it('degrades to a plain number for an unknown currency code rather than throwing', () => {
    const out = formatCost(5, {
      currency: 'XXZ',
      usdPerUnit: 1,
      rateDate: null,
      approximate: false,
    });
    expect(out).toContain('XXZ');
  });
});

describe('describeCostSource', () => {
  it('names where the figure came from', () => {
    expect(describeCostSource('reported', USD_DISPLAY)).toMatch(/Reported by the CLI/);
    expect(describeCostSource('computed', USD_DISPLAY)).toMatch(/synced per-model rates/);
    expect(describeCostSource('manual', USD_DISPLAY)).toMatch(/admin-entered/);
    expect(describeCostSource('legacy', USD_DISPLAY)).toMatch(/before per-model pricing/);
  });

  it('mentions the conversion only when one happened', () => {
    expect(describeCostSource('computed', USD_DISPLAY)).not.toMatch(/converted/);
    expect(describeCostSource('computed', EUR)).toMatch(/converted at the 2026-08-18 ECB rate/);
    expect(describeCostSource('computed', { ...EUR, approximate: true })).toMatch(
      /nearest known rate/,
    );
  });

  it('surfaces excluded invocations so a low total is explained', () => {
    expect(describeCostSource('computed', USD_DISPLAY, 3)).toMatch(/3 invocation\(s\) unpriced/);
  });
});
