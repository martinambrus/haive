import { describe, expect, it } from 'vitest';
import {
  reportDuration,
  reportTestPhase,
  reportTestExecution,
  reportTestSuite,
  reportCheckCoverage,
  REPORT_CATEGORY_COLORS,
} from '../../src/web/components/time-cost-report.js';
import { summarizeTestChecks } from '@haive/shared/stats';

describe('report measurements', () => {
  it('shows missing suite measurements as a dash and unfinished checks as incomplete', () => {
    const summary = summarizeTestChecks([
      { taskId: 't', slot: 'test', outcome: 'running', startedAt: new Date(0), endedAt: null },
      {
        taskId: 't',
        slot: 'test',
        outcome: 'interrupted',
        startedAt: new Date(0),
        endedAt: new Date(1000),
      },
    ]);
    expect(reportTestSuite(summarizeTestChecks([]))).toBe('—');
    expect(reportTestSuite(summary)).toContain('incomplete');
    expect(reportCheckCoverage(summary)).toContain('2 incomplete');
    expect(reportCheckCoverage(summary)).not.toContain('100%');
  });
  it('states command coverage for a mixed population without implying all tasks ran tests', () => {
    expect(reportTestExecution({ ran: 8, not_run: 120, unrecorded: 13 })).toBe(
      '8 of 141 tasks ran a test command · 120 not run · 13 execution not recorded',
    );
  });

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
