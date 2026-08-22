import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PANE_DEFAULT,
  PANE_MAX,
  PANE_MIN,
  clampPaneRatio,
  paneRatioFromPointer,
  readSplitState,
  writeSplitState,
} from './split-pane';

describe('clampPaneRatio', () => {
  it('keeps a ratio inside the band', () => {
    expect(clampPaneRatio(0.3)).toBe(0.3);
  });

  it('floors and caps out-of-band ratios', () => {
    expect(clampPaneRatio(0.01)).toBe(PANE_MIN);
    expect(clampPaneRatio(0.99)).toBe(PANE_MAX);
  });

  it('falls back to the default for a non-finite ratio', () => {
    expect(clampPaneRatio(Number.NaN)).toBe(PANE_DEFAULT);
  });
});

describe('paneRatioFromPointer', () => {
  const VW = 1000;

  it('measures from the right edge for a right-hand column', () => {
    expect(paneRatioFromPointer(700, VW, 'right')).toBeCloseTo(0.3, 5);
  });

  it('measures from the left edge for a left-hand column', () => {
    expect(paneRatioFromPointer(300, VW, 'left')).toBeCloseTo(0.3, 5);
  });

  it('clamps a drag past either limit', () => {
    expect(paneRatioFromPointer(-500, VW, 'right')).toBe(PANE_MAX);
    expect(paneRatioFromPointer(VW + 500, VW, 'right')).toBe(PANE_MIN);
    expect(paneRatioFromPointer(VW + 500, VW, 'left')).toBe(PANE_MAX);
    expect(paneRatioFromPointer(-500, VW, 'left')).toBe(PANE_MIN);
  });

  it('falls back to the default on a zero-width viewport', () => {
    expect(paneRatioFromPointer(0, 0, 'right')).toBe(PANE_DEFAULT);
  });
});

describe('split state persistence', () => {
  const store = new Map<string, string>();
  const stub = () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    });
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    store.clear();
  });

  it('round-trips a split state', () => {
    stub();
    writeSplitState('k', { split: true, ratio: 0.33, side: 'left' });
    expect(readSplitState('k')).toEqual({ split: true, ratio: 0.33, side: 'left' });
  });

  it('reads an absent key as "never used"', () => {
    stub();
    expect(readSplitState('missing')).toBeNull();
  });

  it('discards a state with no split flag and repairs the rest', () => {
    stub();
    store.set('no-flag', JSON.stringify({ ratio: 0.3, side: 'left' }));
    store.set('bad-json', '{nope');
    store.set('bad-parts', JSON.stringify({ split: true, ratio: 'wide', side: 'up' }));
    expect(readSplitState('no-flag')).toBeNull();
    expect(readSplitState('bad-json')).toBeNull();
    expect(readSplitState('bad-parts')).toEqual({
      split: true,
      ratio: PANE_DEFAULT,
      side: 'right',
    });
  });

  it('clamps a stored ratio from outside the band', () => {
    stub();
    store.set('wide', JSON.stringify({ split: true, ratio: 0.95, side: 'right' }));
    expect(readSplitState('wide')?.ratio).toBe(PANE_MAX);
  });

  it('is a no-op without a key', () => {
    stub();
    writeSplitState(null, { split: true, ratio: 0.3, side: 'right' });
    expect(store.size).toBe(0);
    expect(readSplitState(null)).toBeNull();
  });
});
