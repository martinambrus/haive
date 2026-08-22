import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MIN_H,
  MIN_W,
  clampRect,
  defaultRect,
  moveRect,
  readFloatState,
  resizeRect,
  writeFloatState,
  type FloatRect,
} from './float-window';

const VW = 1600;
const VH = 900;

const rect = (x: number, y: number, w: number, h: number): FloatRect => ({ x, y, w, h });

describe('defaultRect', () => {
  it('anchors bottom-right inside the viewport', () => {
    const r = defaultRect(VW, VH);
    expect(r.x + r.w).toBeLessThanOrEqual(VW);
    expect(r.y + r.h).toBeLessThanOrEqual(VH);
    expect(r.x).toBeGreaterThan(0);
  });

  it('floors at the minimum size on a viewport smaller than it', () => {
    const r = defaultRect(300, 200);
    expect(r).toEqual({ x: 0, y: 0, w: MIN_W, h: MIN_H });
  });
});

describe('clampRect', () => {
  it('floors the size at the minimum', () => {
    expect(clampRect(rect(10, 10, 10, 10), VW, VH)).toEqual({ x: 10, y: 10, w: MIN_W, h: MIN_H });
  });

  it('caps the size at the viewport', () => {
    expect(clampRect(rect(0, 0, 9000, 9000), VW, VH)).toEqual({ x: 0, y: 0, w: VW, h: VH });
  });

  it('pulls a window that hangs off the right/bottom edge back in', () => {
    expect(clampRect(rect(1500, 800, 600, 400), VW, VH)).toEqual({
      x: VW - 600,
      y: VH - 400,
      w: 600,
      h: 400,
    });
  });

  it('pulls a window with a negative origin back in', () => {
    expect(clampRect(rect(-200, -50, 600, 400), VW, VH)).toEqual({ x: 0, y: 0, w: 600, h: 400 });
  });
});

describe('moveRect', () => {
  it('keeps the size and applies the delta', () => {
    expect(moveRect(rect(100, 100, 600, 400), 50, -30, VW, VH)).toEqual({
      x: 150,
      y: 70,
      w: 600,
      h: 400,
    });
  });

  it('stops at the viewport edge instead of leaving the header unreachable', () => {
    expect(moveRect(rect(100, 100, 600, 400), -9000, -9000, VW, VH)).toEqual({
      x: 0,
      y: 0,
      w: 600,
      h: 400,
    });
  });
});

describe('resizeRect', () => {
  const start = rect(400, 200, 600, 400);

  it('grows east without moving the origin', () => {
    expect(resizeRect(start, 'e', 120, 0, VW, VH)).toEqual({ x: 400, y: 200, w: 720, h: 400 });
  });

  it('grows south without moving the origin', () => {
    expect(resizeRect(start, 's', 0, 80, VW, VH)).toEqual({ x: 400, y: 200, w: 600, h: 480 });
  });

  it('keeps the east edge pinned when dragging the west edge', () => {
    const r = resizeRect(start, 'w', 100, 0, VW, VH);
    expect(r).toEqual({ x: 500, y: 200, w: 500, h: 400 });
    expect(r.x + r.w).toBe(start.x + start.w);
  });

  it('keeps the south edge pinned when dragging the north edge', () => {
    const r = resizeRect(start, 'n', 0, 100, VW, VH);
    expect(r).toEqual({ x: 400, y: 300, w: 600, h: 300 });
    expect(r.y + r.h).toBe(start.y + start.h);
  });

  it('drives both axes from a corner', () => {
    expect(resizeRect(start, 'se', 100, 50, VW, VH)).toEqual({
      x: 400,
      y: 200,
      w: 700,
      h: 450,
    });
    expect(resizeRect(start, 'nw', 100, 50, VW, VH)).toEqual({
      x: 500,
      y: 250,
      w: 500,
      h: 350,
    });
  });

  it('parks the dragged edge at the minimum instead of dragging the pinned edge along', () => {
    const r = resizeRect(start, 'w', 9000, 0, VW, VH);
    expect(r.w).toBe(MIN_W);
    expect(r.x + r.w).toBe(start.x + start.w);
    const t = resizeRect(start, 'n', 0, 9000, VW, VH);
    expect(t.h).toBe(MIN_H);
    expect(t.y + t.h).toBe(start.y + start.h);
  });

  it('stops growing at the viewport edge', () => {
    const r = resizeRect(start, 'se', 9000, 9000, VW, VH);
    expect(r.x + r.w).toBe(VW);
    expect(r.y + r.h).toBe(VH);
    const t = resizeRect(start, 'nw', -9000, -9000, VW, VH);
    expect(t.x).toBe(0);
    expect(t.y).toBe(0);
  });
});

describe('float state persistence', () => {
  // The module reads `window.localStorage` behind a typeof guard; vitest runs in node,
  // so stand one up for the round-trip.
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

  it('round-trips a detached window', () => {
    stub();
    writeFloatState('k', { detached: true, rect: rect(10, 20, 600, 400) });
    expect(readFloatState('k')).toEqual({ detached: true, rect: rect(10, 20, 600, 400) });
  });

  it('reads an absent key as "never popped out"', () => {
    stub();
    expect(readFloatState('missing')).toBeNull();
  });

  it('discards malformed or partial state rather than half-applying it', () => {
    stub();
    store.set('bad-json', '{nope');
    store.set('no-flag', JSON.stringify({ rect: rect(1, 2, 600, 400) }));
    store.set('bad-rect', JSON.stringify({ detached: true, rect: { x: 'a', y: 2, w: 3, h: 4 } }));
    expect(readFloatState('bad-json')).toBeNull();
    expect(readFloatState('no-flag')).toBeNull();
    expect(readFloatState('bad-rect')).toEqual({ detached: true, rect: null });
  });

  it('is a no-op without a key (in-memory panels)', () => {
    stub();
    writeFloatState(null, { detached: true, rect: null });
    expect(store.size).toBe(0);
    expect(readFloatState(null)).toBeNull();
  });
});
