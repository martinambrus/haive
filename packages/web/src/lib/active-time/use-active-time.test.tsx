// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveTime } from './use-active-time';
import { visibleWords } from './visible-words';
import { ATTENTION_LEASE_KEY } from './attention-lease';
vi.mock('./visible-words', () => ({ visibleWords: vi.fn(() => 0) }));
let listeners: Map<string, Set<EventListenerOrEventListenerObject>>;
function event(type: string, extra: Record<string, unknown> = {}) {
  // Invoke the installed capture listener: jsdom cannot generate trusted input.
  for (const listener of listeners.get(type) ?? []) {
    if (typeof listener === 'function')
      listener({ type, target: window, isTrusted: true, ...extra } as unknown as Event);
  }
}
const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });
function setup(options: Partial<Parameters<typeof useActiveTime>[0]> = {}) {
  const sink = vi.fn();
  const props = {
    enabled: true,
    pending: false,
    contentKey: 'step-a',
    sink,
    baseMs: 100,
    ...options,
  };
  return { sink, props, ...renderHook((p) => useActiveTime(p), { initialProps: props }) };
}
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.mocked(visibleWords).mockReturnValue(0);
  listeners = new Map();
  const add = window.addEventListener.bind(window);
  const remove = window.removeEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    if (listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    }
    add(type, listener, options);
  });
  vi.spyOn(window, 'removeEventListener').mockImplementation((type, listener, options) => {
    if (listener) listeners.get(type)?.delete(listener);
    remove(type, listener, options);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useActiveTime', () => {
  it('does no input, timer, render or storage work without a waiting step', () => {
    const renders = vi.fn();
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    const interval = vi.spyOn(window, 'setInterval');
    const h = renderHook(() => {
      renders();
      return useActiveTime({ enabled: false, pending: false, contentKey: null, sink });
    });
    function sink() {}
    renders.mockClear();
    writes.mockClear();
    for (let i = 0; i < 20; i++) act(() => event('pointermove', { clientX: i, clientY: 0 }));
    for (let i = 0; i < 10; i++) advance(1000);
    expect(renders).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(window.addEventListener).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
    h.unmount();
  });
  it('publishes and touches storage at most once per tick during input bursts', () => {
    const renders = vi.fn();
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    const sink = vi.fn();
    const h = renderHook(() => {
      renders();
      return useActiveTime({ enabled: true, pending: false, contentKey: 'a', sink });
    });
    renders.mockClear();
    writes.mockClear();
    for (let tick = 0; tick < 10; tick++) {
      for (let i = 0; i < 20; i++) {
        advance(25);
        act(() => event('pointermove', { clientX: tick * 20 + i, clientY: 0 }));
      }
      expect(renders).toHaveBeenCalledTimes(tick);
      expect(writes).toHaveBeenCalledTimes(tick);
      advance(500);
      expect(renders).toHaveBeenCalledTimes(tick + 1);
      expect(writes).toHaveBeenCalledTimes(tick + 1);
    }
    expect(h.result.current).toBe(10000);
    advance(90000);
    renders.mockClear();
    advance(10000);
    expect(renders).not.toHaveBeenCalled();
  });
  it('counts when randomUUID is unavailable on an insecure origin', () => {
    vi.stubGlobal('crypto', { randomUUID: undefined });
    const h = setup();
    advance(2000);
    expect(h.result.current).toBe(2100);
    expect(crypto.randomUUID).toBeUndefined();
  });
  it('counts when accessing localStorage throws', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('blocked site data');
    });
    const h = setup();
    advance(2000);
    expect(h.result.current).toBe(2100);
  });
  it('stops at the allowance, stays stopped on polls, and resumes on trusted input', () => {
    const h = setup();
    advance(90000);
    expect(h.result.current).toBe(60100);
    h.rerender({ ...h.props, baseMs: 999 });
    advance(20000);
    expect(h.result.current).toBe(60100);
    act(() => event('keydown'));
    advance(1000);
    expect(h.result.current).toBe(61100);
  });
  it('ignores synthetic input, same-coordinate motion, and unassisted scroll', () => {
    const h = setup();
    act(() => event('pointerdown', { clientX: 10, clientY: 20 }));
    act(() => event('pointerup'));
    advance(59000);
    act(() => {
      event('pointermove', { clientX: 10, clientY: 20 });
      event('scroll');
      event('keydown', { isTrusted: false });
    });
    advance(2000);
    expect(h.result.current).toBe(60100);
    act(() => event('pointermove', { clientX: 11, clientY: 20 }));
    advance(1000);
    expect(h.result.current).toBe(61100);
  });
  it.each(['keydown', 'pointerdown', 'wheel', 'touchmove'])(
    'captures %s even when a child stops propagation',
    (type) => {
      const h = setup();
      advance(90000);
      act(() => event(type, { clientX: 1, clientY: 1 }));
      advance(1000);
      expect(h.result.current).toBe(61100);
      expect(window.addEventListener).toHaveBeenCalledWith(type, expect.any(Function), {
        capture: true,
        passive: true,
      });
    },
  );
  it('allows scrollbar dragging but stops accepting scroll after release', () => {
    const h = setup();
    act(() => event('pointerdown'));
    advance(59000);
    act(() => event('scroll'));
    advance(2000);
    expect(h.result.current).toBe(61100);
    act(() => event('pointerup'));
    advance(58000);
    act(() => event('scroll'));
    advance(2000);
    expect(h.result.current).toBe(119100);
  });
  it('measures once after input settles, never on ticks or polling', () => {
    vi.mocked(visibleWords).mockReturnValue(300);
    const h = setup();
    advance(1000);
    act(() => event('keydown'));
    advance(1000);
    expect(visibleWords).not.toHaveBeenCalled();
    advance(1000);
    expect(visibleWords).toHaveBeenCalledTimes(1);
    h.rerender({ ...h.props });
    advance(120000);
    expect(h.result.current).toBe(121100);
    expect(visibleWords).toHaveBeenCalledTimes(1);
  });
  it('a measurement delayed past presence cannot revive counting', () => {
    vi.mocked(visibleWords).mockReturnValue(750);
    const h = setup();
    const monotonic = vi.spyOn(performance, 'now').mockReturnValue(61000);
    advance(2000);
    expect(visibleWords).toHaveBeenCalledOnce();
    monotonic.mockReturnValue(62000);
    advance(1000);
    expect(h.result.current).toBe(60100);
  });
  it('flushes the final partial tick without publishing another display', () => {
    const h = setup();
    advance(500);
    h.unmount();
    expect(h.sink).toHaveBeenCalledExactlyOnceWith(500);
  });
  it('uses the base allowance on measurement overflow or failure', () => {
    vi.mocked(visibleWords).mockReturnValue(null);
    const h = setup();
    advance(61000);
    expect(h.result.current).toBe(60100);
  });
  it('content restarts with recent real input but repeated content never replaces real input', () => {
    const h = setup();
    advance(120000);
    h.rerender({ ...h.props, contentKey: 'step-b' });
    advance(1000);
    expect(h.result.current).toBe(61100);
    advance(800000);
    h.rerender({ ...h.props, contentKey: 'step-c' });
    const before = h.result.current;
    advance(1000);
    expect(h.result.current).toBe(before);
  });
  it('pending extends only a present epoch and exit restores its reading allowance', () => {
    const h = setup();
    advance(30000);
    h.rerender({ ...h.props, pending: true });
    advance(120000);
    expect(h.result.current).toBe(150100);
    h.rerender(h.props);
    advance(1000);
    expect(h.result.current).toBe(150100);
    h.rerender({ ...h.props, pending: true });
    advance(1000);
    expect(h.result.current).toBe(150100);
  });
  it('caps pending work at fifteen minutes', () => {
    const h = setup({ pending: true });
    advance(910000);
    expect(h.result.current).toBe(900100);
  });
  it('iframe entry grants its allowance once and cannot revive an idle epoch', () => {
    const h = setup();
    advance(30000);
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    vi.spyOn(document, 'activeElement', 'get').mockReturnValue(iframe);
    act(() => event('blur'));
    advance(880000);
    expect(h.result.current).toBe(900100);
    act(() => event('blur'));
    advance(1000);
    expect(h.result.current).toBe(900100);
    iframe.remove();
  });
  it('flushes before changing sinks, and polls do not recreate listeners or reset base', () => {
    const h = setup();
    advance(1500);
    const count = vi.mocked(window.addEventListener).mock.calls.length;
    h.rerender({ ...h.props, baseMs: 500 });
    expect(window.addEventListener).toHaveBeenCalledTimes(count);
    expect(h.result.current).toBe(1100);
    const next = vi.fn();
    h.rerender({ ...h.props, sink: next, contentKey: 'step-b', baseMs: 2000 });
    expect(h.sink).toHaveBeenCalledExactlyOnceWith(1500);
    expect(next).not.toHaveBeenCalled();
    advance(1000);
    h.unmount();
    expect(next).toHaveBeenCalledExactlyOnceWith(1000);
  });
  it('flushes the fractional last interval on blur and resumes without counting the gap', () => {
    const h = setup();
    advance(1500);
    act(() => event('blur'));
    expect(h.sink).toHaveBeenCalledExactlyOnceWith(1500);
    advance(90000);
    expect(h.result.current).toBe(1600);
    act(() => event('focus'));
    advance(1000);
    expect(h.result.current).toBe(2100);
  });
  it('programmatic element focus and synthetic window focus do not renew presence', () => {
    const h = setup();
    advance(90000);
    const element = document.createElement('input');
    document.body.append(element);
    act(() => {
      element.focus();
      event('focus', { target: element });
      event('focus', { isTrusted: false });
    });
    advance(1000);
    expect(h.result.current).toBe(60100);
    element.remove();
  });
  it('flushes visibility loss before pausing and does not backfill on return', () => {
    const h = setup();
    advance(1500);
    act(() => {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(h.sink).toHaveBeenCalledExactlyOnceWith(1500);
    advance(90000);
    act(() => {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      event('focus');
    });
    advance(1000);
    expect(h.result.current).toBeLessThanOrEqual(2600);
  });
  it('disabled time is not counted and does not grant fresh presence after a long absence', () => {
    const h = setup({ enabled: false });
    advance(1000000);
    h.rerender({ ...h.props, enabled: true, contentKey: 'step-b' });
    advance(1000);
    expect(h.result.current).toBe(100);
    act(() => event('keydown'));
    advance(1000);
    expect(h.result.current).toBe(1100);
  });
  it('only one consumer counts; release allows takeover without backfilling', () => {
    const first = setup();
    const second = setup();
    advance(2000);
    expect(first.result.current).toBe(2100);
    expect(second.result.current).toBe(100);
    first.unmount();
    advance(1000);
    expect(second.result.current).toBe(100);
    advance(1000);
    expect(second.result.current).toBe(1100);
  });
  it('flushes the partial interval after a takeover baseline without backfilling', () => {
    const first = setup();
    const second = setup();
    advance(2000);
    first.unmount();
    advance(1500);
    second.unmount();
    expect(second.sink).toHaveBeenCalledExactlyOnceWith(500);
  });
  it('an expired foreign lease can be claimed, with a fresh baseline', () => {
    localStorage.setItem(
      ATTENTION_LEASE_KEY,
      JSON.stringify({ owner: 'other-tab', until: Date.now() + 2500 }),
    );
    const h = setup();
    advance(3000);
    expect(h.result.current).toBe(100);
    advance(1000);
    expect(h.result.current).toBe(1100);
  });
  it('storage failure fails open', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('unavailable');
    });
    const h = setup();
    advance(2000);
    expect(h.result.current).toBe(2100);
  });
  it.each(['rejected', 'thrown'])('never retries an ambiguous %s flush', async (kind) => {
    const sink = vi.fn(() => {
      if (kind === 'thrown') throw new Error('network');
      return Promise.reject(new Error('network'));
    });
    const h = setup({ sink });
    advance(60000);
    await act(async () => {});
    expect(sink).toHaveBeenCalledExactlyOnceWith(60000);
    advance(30000);
    h.unmount();
    expect(sink).toHaveBeenCalledTimes(1);
    await act(async () => {});
  });
  it('page hide flushes once and unmount cannot send the delta again', () => {
    const h = setup();
    advance(1500);
    act(() => event('pagehide'));
    h.unmount();
    expect(h.sink).toHaveBeenCalledExactlyOnceWith(1500);
  });
  it('an external window blur still stops counting with an iframe selected', () => {
    const h = setup();
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    vi.spyOn(document, 'activeElement', 'get').mockReturnValue(iframe);
    act(() => event('blur'));
    advance(2000);
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    act(() => event('blur'));
    const before = h.result.current;
    advance(10000);
    expect(h.result.current).toBe(before);
    iframe.remove();
  });
});
