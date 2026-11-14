import { computeWorkByCategory, type TaskTimingStep } from '@haive/shared/timing';

export function TaskTestsTimeCell({
  steps,
  nowMs,
  format,
}: {
  steps: (TaskTimingStep & { stepId: string })[];
  nowMs: number;
  format: (ms: number) => string;
}) {
  const testsMs = computeWorkByCategory(steps, nowMs).tests;
  return (
    <div
      className="flex flex-col items-end"
      title="Test phase elapsed time — part of work; includes setup and skipped commands"
    >
      <span className="font-mono text-lg text-teal-300">{format(testsMs)}</span>
      <span className="text-[10px] uppercase tracking-wider text-neutral-400">tests</span>
    </div>
  );
}
