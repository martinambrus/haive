/** Loaded-row reset selection. Call only under the ordered step batch, before
 * taking the task fence. Explicit reruns invalidate every forward decision in
 * the same round, including decisions on still-pending entries. Recovery and Resume of retained work keep decisions and never reopen a guard-owned skipped row. */
export function guardResetRows<
  T extends {
    id: string;
    round: number;
    runSeq: number | null;
    stepIndex: number;
    status: string;
    guardState: unknown;
  },
>(rows: readonly T[], targets: readonly T[], preserve: boolean): T[] {
  const selected = new Set(targets.map((r) => r.id));
  return rows.filter((row) => {
    if (preserve)
      return selected.has(row.id) && !(row.status === 'skipped' && row.guardState != null);
    return (
      selected.has(row.id) ||
      (row.guardState != null &&
        targets.some(
          (target) =>
            row.round === target.round &&
            (target.runSeq != null
              ? row.runSeq != null && row.runSeq >= target.runSeq
              : row.stepIndex >= target.stepIndex),
        ))
    );
  });
}
