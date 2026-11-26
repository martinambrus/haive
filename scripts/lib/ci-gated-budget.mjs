// Historical slow-runner model: 1423 seconds for 143 rows on 2026-11-12.
// All rows have the same modelled cost, so round-robin balances modelled time.
export const GATED_BUDGET = {
  outsideGatedSeconds: 120,
  secondsPerRow: 10,
  slowRunnerFactor: 1.5,
  marginSeconds: 600,
  rowHeadroom: 13, // ceil(the former list-wide 25 rows / 2 shards)
  shards: 2, // ceil(176 rows * 10 seconds / a 900-second target)
  targetShardSeconds: 900,
};

export const suggestedShards = (rows, budget = GATED_BUDGET) =>
  Math.max(1, Math.ceil((rows * budget.secondsPerRow) / budget.targetShardSeconds));

// The least whole-minute limits that hold `rows` GATED rows. The gated step holds
// slowRunnerFactor times the time its rows are modelled to take. The job holds a green run plus
// marginSeconds, and the setup plus the whole gated step limit. A list so short that the margin
// alone is over twice a green run has no limits that fit.
export function minimumLimits(
  rows,
  { outsideGatedSeconds, secondsPerRow, slowRunnerFactor, marginSeconds },
) {
  const gatedSeconds = rows * secondsPerRow;
  const stepMinutes = Math.ceil((slowRunnerFactor * gatedSeconds) / 60);
  const jobSeconds = Math.max(
    outsideGatedSeconds + gatedSeconds + marginSeconds,
    outsideGatedSeconds + stepMinutes * 60,
  );
  return { stepMinutes, jobMinutes: Math.ceil(jobSeconds / 60) };
}
