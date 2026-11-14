import { sampledRatio } from './deltas.js';

export type TestCheckOutcome = 'running' | 'passed' | 'failed' | 'not_run' | 'interrupted';
export interface TimeCostCheckRun {
  taskId: string;
  slot: string;
  outcome: TestCheckOutcome;
  startedAt: Date | string;
  endedAt: Date | string | null;
}

/** Only test slots measure suites. No duration is inferred for an unfinished run,
 * and environment stops never become zero-duration successes or pass-rate samples. */
export function summarizeTestChecks(checks: readonly TimeCostCheckRun[]) {
  const testCheckCounts: Record<TestCheckOutcome, number> = {
    passed: 0,
    failed: 0,
    not_run: 0,
    running: 0,
    interrupted: 0,
  };
  let testSuiteMs: number | null = null;
  for (const r of checks) {
    if (r.slot !== 'test') continue;
    testCheckCounts[r.outcome]++;
    if ((r.outcome === 'passed' || r.outcome === 'failed') && r.endedAt !== null) {
      const elapsed = new Date(r.endedAt).getTime() - new Date(r.startedAt).getTime();
      if (Number.isFinite(elapsed) && elapsed >= 0) testSuiteMs = (testSuiteMs ?? 0) + elapsed;
    }
  }
  const testSuiteRuns = testCheckCounts.passed + testCheckCounts.failed;
  return {
    testSuiteMs,
    testSuiteRuns,
    testCheckCounts,
    testPassShare: sampledRatio(testCheckCounts.passed, testSuiteRuns),
  };
}
