import { computeWorkByCategory, timeCategoryOf, type TaskTimingStep } from '@haive/shared/timing';
import type { summarizeTestChecks } from '@haive/shared/stats';

export function TaskTestsTimeCell({
  steps,
  nowMs,
  format,
  testChecks,
}: {
  steps: (TaskTimingStep & { stepId: string })[];
  nowMs: number;
  format: (ms: number) => string;
  testChecks?: ReturnType<typeof summarizeTestChecks>;
}) {
  if (!steps.some((s) => timeCategoryOf(s.stepId) === 'tests')) return null;
  const testsMs = computeWorkByCategory(steps, nowMs).tests;
  const incomplete = testChecks
    ? testChecks.testCheckCounts.running + testChecks.testCheckCounts.interrupted
    : 0;
  const suite = testChecks?.testSuiteMs == null ? '— (unmeasured)' : format(testChecks.testSuiteMs);
  return (
    <div
      className="flex flex-col items-end"
      title={`Test phase elapsed time — part of work; includes setup and skipped commands; suite: ${suite}${incomplete ? `; ${incomplete} incomplete` : ''}`}
    >
      <span className="font-mono text-lg text-teal-300">{format(testsMs)}</span>
      <span className="text-[10px] uppercase tracking-wider text-neutral-400">tests</span>
    </div>
  );
}
