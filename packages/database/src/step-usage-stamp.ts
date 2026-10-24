/** Every terminal step write starts with no usage stamp for that attempt. The normal
 *  completion path may then attach its measurements, fenced on that completion's endedAt.
 *  Failures, skips, stops and completions without measurements keep all six fields null. */
export const CLEAR_STEP_USAGE_STAMP = {
  contextLeftPercent: null,
  contextTokens: null,
  contextWindowSize: null,
  usageFiveHourPct: null,
  usageSevenDayPct: null,
  usageDailyPct: null,
};
