import { describe, expect, it } from 'vitest';
import {
  deltaToneClass,
  formatAgentHours,
  formatBucketLabel,
  formatConcurrency,
  formatCount,
  formatDeltaPercent,
  formatPercent,
  formatSampledRatio,
  isUnderSampled,
  STATS_DASH,
} from './format-stats';

const delta = (current: number, previous: number, changeRatio: number | null) => ({
  current,
  previous,
  changeRatio,
  direction:
    current > previous
      ? ('up' as const)
      : current < previous
        ? ('down' as const)
        : ('flat' as const),
});

describe('formatPercent', () => {
  it('renders a ratio as a percentage', () => {
    expect(formatPercent(0.141)).toBe('14%');
    expect(formatPercent(0.141, 1)).toBe('14.1%');
    expect(formatPercent(1)).toBe('100%');
  });

  it('renders a missing figure as a dash, never as zero', () => {
    // "Nothing ran" and "we have no data" are different claims; 0% would assert the first.
    expect(formatPercent(null)).toBe(STATS_DASH);
    expect(formatPercent(undefined)).toBe(STATS_DASH);
    expect(formatPercent(Number.NaN)).toBe(STATS_DASH);
    expect(formatPercent(0)).toBe('0%');
  });
});

describe('formatDeltaPercent', () => {
  it('signs the change and tightens the precision on small moves', () => {
    expect(formatDeltaPercent(delta(150, 100, 0.5))).toBe('+50%');
    expect(formatDeltaPercent(delta(75, 100, -0.25))).toBe('-25%');
    expect(formatDeltaPercent(delta(101, 100, 0.01))).toBe('+1.0%');
  });

  it('says "new" rather than inventing a percentage when there is no baseline', () => {
    // +100% and +∞% are both fabrications when the previous window was zero.
    expect(formatDeltaPercent(delta(42, 0, null))).toBe('new');
    expect(formatDeltaPercent(delta(0, 0, null))).toBe(STATS_DASH);
  });

  it('renders a missing delta as a dash', () => {
    expect(formatDeltaPercent(null)).toBe(STATS_DASH);
  });
});

describe('deltaToneClass', () => {
  it('reads the same direction differently depending on what is growing', () => {
    // More completed tasks is good; more money spent is not. The polarity is the caller's to
    // state — guessing it here would colour a spend increase green.
    const up = delta(150, 100, 0.5);
    expect(deltaToneClass(up, true)).toContain('emerald');
    expect(deltaToneClass(up, false)).toContain('amber');
    const down = delta(75, 100, -0.25);
    expect(deltaToneClass(down, true)).toContain('amber');
    expect(deltaToneClass(down, false)).toContain('emerald');
  });

  it('stays neutral when nothing changed or nothing is known', () => {
    expect(deltaToneClass(delta(100, 100, 0), true)).toContain('neutral');
    expect(deltaToneClass(null, true)).toContain('neutral');
  });
});

describe('formatAgentHours', () => {
  it('labels the unit so it cannot be read as elapsed time', () => {
    // The measured figure: 63.59 agent-hours inside a 17.35 h busy span. Rendering it as
    // "63h 35m" beside a duration invites exactly the wrong comparison.
    expect(formatAgentHours(63.59 * 3_600_000)).toBe('63.6 ah');
    expect(formatAgentHours(2.5 * 3_600_000)).toBe('2.50 ah');
    expect(formatAgentHours(0)).toBe('0 ah');
  });

  it('renders a missing or impossible value as a dash', () => {
    expect(formatAgentHours(null)).toBe(STATS_DASH);
    expect(formatAgentHours(-1)).toBe(STATS_DASH);
    expect(formatAgentHours(Number.NaN)).toBe(STATS_DASH);
  });
});

describe('formatConcurrency', () => {
  it('renders the measured factor', () => {
    expect(formatConcurrency(3.665)).toBe('3.67×');
    expect(formatConcurrency(1)).toBe('1.00×');
  });

  it('renders "no concurrency measurable" as a dash rather than 0x', () => {
    expect(formatConcurrency(null)).toBe(STATS_DASH);
  });
});

describe('formatSampledRatio', () => {
  it('shows the percentage once there are enough observations', () => {
    expect(formatSampledRatio({ ratio: 0.5385, n: 26, sufficient: true })).toBe('54%');
  });

  it('shows the sample count INSTEAD of the percentage when under-sampled', () => {
    // The live install's real shape: one review finding. "100%" from one row is indis-
    // tinguishable from "100%" from a thousand, which is how a stats page misleads its owner.
    expect(formatSampledRatio({ ratio: 1, n: 1, sufficient: false })).toBe('n=1');
    expect(isUnderSampled({ ratio: 1, n: 1, sufficient: false })).toBe(true);
    expect(isUnderSampled({ ratio: 0.5, n: 26, sufficient: true })).toBe(false);
  });

  it('renders no ratio at all as a dash', () => {
    expect(formatSampledRatio({ ratio: null, n: 0, sufficient: false })).toBe(STATS_DASH);
    expect(formatSampledRatio(null)).toBe(STATS_DASH);
    expect(isUnderSampled(null)).toBe(false);
  });
});

describe('formatCount', () => {
  it('separates thousands and dashes a missing count', () => {
    expect(formatCount(2584)).toBe((2584).toLocaleString());
    expect(formatCount(0)).toBe('0');
    expect(formatCount(null)).toBe(STATS_DASH);
  });
});

describe('formatBucketLabel', () => {
  it('shortens a bucket key for a dense axis', () => {
    expect(formatBucketLabel('2026-09-06')).toMatch(/6/);
    expect(formatBucketLabel('2026-09-06')).toMatch(/Sep/);
  });

  it('does not shift the day when the viewer is behind UTC', () => {
    // The bucket key is ALREADY a local calendar day. Re-parsing it at midnight would let a
    // negative offset roll it back to the 5th; parsing at noon cannot.
    for (const key of ['2026-01-01', '2026-09-06', '2026-12-31']) {
      const label = formatBucketLabel(key);
      const day = String(Number(key.slice(8, 10)));
      expect(label).toContain(day);
    }
  });

  it('passes a malformed key through untouched', () => {
    expect(formatBucketLabel('not-a-date')).toBe('not-a-date');
  });
});
