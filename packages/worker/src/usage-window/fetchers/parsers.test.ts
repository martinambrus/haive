import { describe, it, expect } from 'vitest';
import { parseClaudeUsage } from './claude-code.js';
import { parseCodexUsage } from './codex.js';
import { parseZaiUsage } from './zai.js';
import { parseGeminiUsage } from './gemini.js';

describe('parseClaudeUsage', () => {
  it('maps five_hour/seven_day utilization (0-100 used) + ISO resets', () => {
    const w = parseClaudeUsage({
      five_hour: { utilization: 33, resets_at: '2026-04-11T07:00:00.528743+00:00' },
      seven_day: { utilization: 13, resets_at: '2026-04-17T00:59:59.951713+00:00' },
      seven_day_opus: null,
      extra_usage: { is_enabled: false },
    });
    expect(w.fiveHour?.usedPct).toBe(33);
    expect(w.sevenDay?.usedPct).toBe(13);
    expect(w.fiveHour?.resetsAt).toBe('2026-04-11T07:00:00.528Z');
  });

  it('returns empty object on missing/foreign shape', () => {
    expect(parseClaudeUsage({})).toEqual({});
    expect(parseClaudeUsage(null)).toEqual({});
  });
});

describe('parseCodexUsage', () => {
  it('reads used_percent (protocol shape) with unix-seconds reset', () => {
    const w = parseCodexUsage({
      primary: { used_percent: 18, resets_at: 1_781_000_000 },
      secondary: { used_percent: 64 },
    });
    expect(w.fiveHour?.usedPct).toBe(18);
    expect(w.sevenDay?.usedPct).toBe(64);
    expect(w.fiveHour?.resetsAt).toBe(new Date(1_781_000_000 * 1000).toISOString());
  });

  it('inverts percent_left (raw-HTTP shape) nested under rate_limit', () => {
    const w = parseCodexUsage({
      rate_limit: {
        primary_window: { percent_left: 82 },
        secondary_window: { percent_left: 36 },
      },
    });
    expect(w.fiveHour?.usedPct).toBe(18);
    expect(w.sevenDay?.usedPct).toBe(64);
  });

  it('maps a lone window (Plus) to weekly when its reset is far out, not 5h', () => {
    // Plus returns ONE window in the `primary` slot, but it is the WEEKLY limit
    // (reset days out). Slot position would mislabel it "5h"; the horizon must win.
    const now = Date.UTC(2026, 6, 13, 7, 0, 0);
    const w = parseCodexUsage(
      { primary: { used_percent: 5, resets_at: '2026-07-19T19:05:49Z' } },
      now,
    );
    expect(w.sevenDay?.usedPct).toBe(5);
    expect(w.fiveHour).toBeUndefined();
  });

  it('maps a lone window to 5h when it resets within a few hours', () => {
    const now = Date.UTC(2026, 6, 13, 7, 0, 0);
    const w = parseCodexUsage(
      { primary: { used_percent: 20, resets_at: '2026-07-13T10:00:00Z' } },
      now,
    );
    expect(w.fiveHour?.usedPct).toBe(20);
    expect(w.sevenDay).toBeUndefined();
  });

  it('returns empty on unknown shape', () => {
    expect(parseCodexUsage({ foo: 1 })).toEqual({});
  });
});

describe('parseZaiUsage', () => {
  it('picks TOKENS_LIMIT percentage as the 5-hour window, ignores TIME_LIMIT', () => {
    const w = parseZaiUsage([
      { type: 'TIME_LIMIT', percentage: 10 },
      { type: 'TOKENS_LIMIT', percentage: 45 },
    ]);
    expect(w.fiveHour?.usedPct).toBe(45);
    expect(w.sevenDay).toBeUndefined();
    expect(w.daily).toBeUndefined();
  });

  it('accepts a {data:[...]} envelope', () => {
    const w = parseZaiUsage({ data: [{ type: 'TOKENS_LIMIT', percentage: 7 }] });
    expect(w.fiveHour?.usedPct).toBe(7);
  });
});

describe('parseGeminiUsage', () => {
  it('inverts remainingFraction to a daily used-% and reads resetTime', () => {
    const w = parseGeminiUsage({
      buckets: [
        { tokenType: 'REQUESTS', remainingFraction: 0.76175, resetTime: '2025-12-10T22:19:52Z' },
      ],
    });
    // (1 - 0.76175) * 100 = 23.825 -> 24
    expect(w.daily?.usedPct).toBe(24);
    expect(w.daily?.resetsAt).toBe('2025-12-10T22:19:52.000Z');
    expect(w.fiveHour).toBeUndefined();
  });

  it('returns empty when no bucket carries a remainingFraction', () => {
    expect(parseGeminiUsage({ buckets: [{ tokenType: 'REQUESTS' }] })).toEqual({});
  });
});
