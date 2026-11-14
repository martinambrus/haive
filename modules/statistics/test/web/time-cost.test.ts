import { describe, expect, it } from 'vitest';
import {
  reportDuration,
  reportTestPhase,
  REPORT_CATEGORY_COLORS,
} from '../../src/web/components/time-cost-report.js';

describe('report measurements', () => {
  it('distinguishes missing measurements, recorded zero, phase duration and execution', () => {
    expect(reportDuration(null)).toBe('—');
    expect(reportDuration(0)).toBe('0s');
    expect(reportTestPhase(60_000, 'not_run')).toBe('1m 0s · not run');
    expect(reportTestPhase(60_000, 'unrecorded')).toBe('1m 0s · execution not recorded');
    expect(reportTestPhase(null, 'unrecorded')).toBe('— · execution not recorded');
    expect(reportTestPhase(60_000, 'ran')).toBe('1m 0s · command ran');
  });
  it('keeps entity colours legible on the report surface', () => {
    const luminance = (hex: string) =>
      hex
        .match(/[a-f\d]{2}/gi)!
        .map((h) => parseInt(h, 16) / 255)
        .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce((n, v, i) => n + v * [0.2126, 0.7152, 0.0722][i]!, 0);
    for (const color of Object.values(REPORT_CATEGORY_COLORS))
      expect((luminance(color) + 0.05) / (luminance('#0a0a0a') + 0.05)).toBeGreaterThanOrEqual(3);
  });
});
