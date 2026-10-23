import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModulePassScheduler } from '../src/modules/pass-scheduler.js';

const INTERVAL = 1000;

const gated = () => {
  const gates: Array<() => void> = [];
  const run = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        gates.push(resolve);
      }),
  );
  return { run, gates };
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('ModulePassScheduler', () => {
  it('S1: request runs a pass at once, once per request', async () => {
    const run = vi.fn(async () => {});
    const scheduler = new ModulePassScheduler({ run, intervalMs: INTERVAL });
    scheduler.request();
    expect(run).toHaveBeenCalledTimes(1);
    await scheduler.inFlight();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('S2: start runs an idle tick every interval and drops a tick while a pass runs', async () => {
    const { run, gates } = gated();
    const scheduler = new ModulePassScheduler({ run, intervalMs: INTERVAL });
    scheduler.start();
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(run).toHaveBeenCalledTimes(1);
    gates[0]!();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(run).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it('S3: requests during a pass run exactly one more pass right after it', async () => {
    const { run, gates } = gated();
    const scheduler = new ModulePassScheduler({ run, intervalMs: INTERVAL });
    scheduler.request();
    scheduler.request();
    scheduler.request();
    scheduler.request();
    expect(run).toHaveBeenCalledTimes(1);
    gates[0]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    gates[1]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('S4: stop ends ticks and requests, and a pass ending after stop does not rerun', async () => {
    const { run, gates } = gated();
    const scheduler = new ModulePassScheduler({ run, intervalMs: INTERVAL });
    scheduler.start();
    scheduler.request();
    scheduler.request();
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.stop();
    gates[0]!();
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.request();
    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('S4: stop before any pass leaves no timer and no tick', async () => {
    const run = vi.fn(async () => {});
    const scheduler = new ModulePassScheduler({ run, intervalMs: INTERVAL });
    scheduler.start();
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('S5: a rejecting run is caught and the next request still runs', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const run = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue(undefined);
      const scheduler = new ModulePassScheduler({ run, intervalMs: INTERVAL });
      scheduler.request();
      await scheduler.inFlight();
      await vi.advanceTimersByTimeAsync(0);
      scheduler.request();
      expect(run).toHaveBeenCalledTimes(2);
      await scheduler.inFlight();
      await vi.advanceTimersByTimeAsync(0);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('S6: inFlight is the running pass, and null when idle and after the rerun ended', async () => {
    const { run, gates } = gated();
    const scheduler = new ModulePassScheduler({ run, intervalMs: INTERVAL });
    expect(scheduler.inFlight()).toBeNull();
    scheduler.request();
    scheduler.request();
    const first = scheduler.inFlight();
    expect(first).toBeInstanceOf(Promise);
    gates[0]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.inFlight()).toBeInstanceOf(Promise);
    gates[1]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.inFlight()).toBeNull();
  });
});
