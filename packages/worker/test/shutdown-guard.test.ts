import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@haive/shared';

const FIRST_STEP_MS = 5_000;
const SECOND_STEP_MS = 1_000;

const loadGuard = async () => (await import('../src/shutdown-guard.js')).guardShutdown;

const track = (promise: Promise<unknown>) => {
  const state = { settled: false };
  const settle = () => {
    state.settled = true;
  };
  void promise.then(settle, settle);
  return state;
};

describe('guardShutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function guarded() {
    const guardShutdown = await loadGuard();
    const stops = { reapers: vi.fn(), modules: vi.fn(), workers: vi.fn() };
    const exit = vi.fn();
    const run = vi.fn(async () => {
      stops.reapers();
      await new Promise<void>((resolve) => setTimeout(resolve, FIRST_STEP_MS));
      stops.modules();
      await new Promise<void>((resolve) => setTimeout(resolve, SECOND_STEP_MS));
      stops.workers();
    });
    return { shutdown: guardShutdown(run, exit), run, stops, exit };
  }

  it('calls each stop once when a second signal arrives while the first shutdown runs, and lets the second wait on it', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { shutdown, run, stops, exit } = await guarded();

    const first = track(shutdown('SIGTERM'));
    await vi.advanceTimersByTimeAsync(FIRST_STEP_MS - 1);
    const second = track(shutdown('SIGINT'));
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ signal: 'SIGINT' }),
      expect.any(String),
    );

    await vi.advanceTimersByTimeAsync(SECOND_STEP_MS);
    expect(first.settled).toBe(false);
    expect(second.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(first.settled).toBe(true);
    expect(second.settled).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith('SIGTERM');
    for (const stop of Object.values(stops)) expect(stop).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
  });

  it('exits with code 1 at the third signal and not before, and runs each stop it had reached once', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { shutdown, run, stops, exit } = await guarded();

    void shutdown('SIGTERM');
    void shutdown('SIGINT');
    await vi.advanceTimersByTimeAsync(FIRST_STEP_MS - 1);
    expect(exit).not.toHaveBeenCalled();

    void shutdown('SIGTERM');
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ signal: 'SIGTERM' }),
      expect.any(String),
    );

    expect(run).toHaveBeenCalledOnce();
    expect(stops.reapers).toHaveBeenCalledOnce();
    expect(stops.modules).not.toHaveBeenCalled();
    expect(stops.workers).not.toHaveBeenCalled();
  });
});

describe('the worker entry point', () => {
  const boot = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

  it('binds both signals to the one guarded shutdown', () => {
    expect(boot).toMatch(
      /const shutdown = guardShutdown\(runShutdown, \(code\) => process\.exit\(code\)\);/,
    );
    expect(boot).toMatch(
      /process\.on\('SIGTERM', \(\) => void shutdown\('SIGTERM'\)\);\s*process\.on\('SIGINT', \(\) => void shutdown\('SIGINT'\)\);/,
    );
  });

  it('bounds the in-flight reconcile pass and the module stops with one call', () => {
    expect(boot).toMatch(/moduleJobs\.shutdown\(moduleJobsScheduler\.inFlight\(\)\)/);
    expect(boot).not.toMatch(/await moduleJobsScheduler\.inFlight\(\)/);
    expect(boot).not.toMatch(/moduleJobs\.stopAll\(/);
  });

  it('stops the terminal manager beside the module shutdown, not after it', () => {
    expect(boot).toMatch(
      /await Promise\.all\(\[\s*moduleJobs\.shutdown\(moduleJobsScheduler\.inFlight\(\)\),\s*terminalManager\.stop\(\)/,
    );
    expect(boot).not.toMatch(/await terminalManager\.stop\(\)/);
  });

  it('bounds the shutdown sandbox reap with the budget and leaves the boot reap unbounded', () => {
    expect(boot).toMatch(/reapAllCliSandboxes\(`worker \$\{signal\}`, SHUTDOWN_REAP_BUDGET_MS\)/);
    expect(boot).toContain("reapAllCliSandboxes('worker boot')");
  });
});
