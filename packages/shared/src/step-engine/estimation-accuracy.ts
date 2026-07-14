// Per-repo estimation-accuracy aggregation for the estimates dashboard (task-time
// estimation v2.4). Pure: the API supplies each completed task's stored RAW AI estimate and
// its MEASURED actual effort (computeTaskTiming), and these functions derive the per-task
// error and the repo-level calibration summary (MAPE, median bias, over/under counts). The
// target metric is EFFORT (agent work + user-active), matching 00b-estimate and the
// completion verdict card — never raw wall-clock.

export interface EstimationDatum {
  taskId: string;
  title: string;
  /** ISO completion timestamp, or null. */
  completedAt: string | null;
  /** The RAW AI estimate stored on the task (ai_estimated_time_hours) — the calibration
   *  signal, never user-edited. */
  aiEstimatedHours: number;
  /** The human-confirmed estimate (estimated_time_hours), for reference on the row. */
  confirmedHours: number | null;
  /** MEASURED actual effort in hours = (work + user-active) / 3.6e6. */
  actualHours: number;
}

export interface EstimationAccuracyRow extends EstimationDatum {
  /** Signed % error of the AI estimate vs actual: (actual - ai) / actual * 100. Positive
   *  means the AI UNDER-estimated (the task took longer than predicted). */
  signedErrorPct: number;
  /** |signedErrorPct|. */
  absErrorPct: number;
}

export interface EstimationAccuracySummary {
  taskCount: number;
  /** Mean Absolute Percentage Error of the AI estimate vs actual effort. 0 when no rows. */
  mapePct: number;
  /** Median actual/ai ratio across the repo: > 1 means the estimator ran UNDER (tasks took
   *  longer than predicted), < 1 over. null when there are no usable pairs. */
  medianBiasFactor: number | null;
  /** Tasks the AI under-estimated (actual > ai) and over-estimated (actual < ai). */
  underestimateCount: number;
  overestimateCount: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  // Guarded non-empty above, so mid and mid-1 are valid; assertions satisfy
  // noUncheckedIndexedAccess without masking a real out-of-bounds.
  const hi = s[mid]!;
  return s.length % 2 === 0 ? (s[mid - 1]! + hi) / 2 : hi;
}

/** Build the per-task accuracy rows + the repo-level summary. Only data with a positive AI
 *  estimate AND a positive measured actual contributes (a zero on either side has no
 *  meaningful percentage error). Rows are returned in input order; the caller sorts. */
export function buildEstimationAccuracy(data: EstimationDatum[]): {
  rows: EstimationAccuracyRow[];
  summary: EstimationAccuracySummary;
} {
  const rows: EstimationAccuracyRow[] = [];
  const absErrors: number[] = [];
  const ratios: number[] = [];
  let under = 0;
  let over = 0;
  for (const d of data) {
    if (!(d.aiEstimatedHours > 0) || !(d.actualHours > 0)) continue;
    const signedErrorPct = round2(((d.actualHours - d.aiEstimatedHours) / d.actualHours) * 100);
    rows.push({ ...d, signedErrorPct, absErrorPct: Math.abs(signedErrorPct) });
    absErrors.push(Math.abs(signedErrorPct));
    ratios.push(d.actualHours / d.aiEstimatedHours);
    if (d.actualHours > d.aiEstimatedHours) under += 1;
    else if (d.actualHours < d.aiEstimatedHours) over += 1;
  }
  const mapePct = absErrors.length
    ? round2(absErrors.reduce((a, b) => a + b, 0) / absErrors.length)
    : 0;
  const medianRatio = median(ratios);
  return {
    rows,
    summary: {
      taskCount: rows.length,
      mapePct,
      medianBiasFactor: medianRatio == null ? null : round2(medianRatio),
      underestimateCount: under,
      overestimateCount: over,
    },
  };
}
