/** Name WHO holds the CLI slots, not merely how many.
 *
 *  A bare "N jobs are using them all" reads as "your tasks are busy" and sends the user to look
 *  at their own work — which is exactly what happened when the holders were stale
 *  `cli-refresh-versions` jobs and every one of the user's tasks was paused. Agent runs and CLI
 *  upkeep are the two kinds, and only the first is something the user started. */
export function describeSlotHolders(q: {
  running: number;
  agents: number;
  service: number;
}): string {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  // Both counts 0 while running > 0 means a pre-split api; report the total unattributed rather
  // than claim a breakdown we were not sent.
  if (q.agents === 0 && q.service === 0) {
    return `${plural(q.running, 'job is', 'jobs are')} using them all`;
  }
  if (q.service === 0) return `${plural(q.agents, 'agent run is', 'agent runs are')} using them`;
  if (q.agents === 0) {
    return `${plural(q.service, 'CLI upkeep job is', 'CLI upkeep jobs are')} using them`;
  }
  return `${plural(q.agents, 'agent run', 'agent runs')} and ${plural(
    q.service,
    'CLI upkeep job',
    'CLI upkeep jobs',
  )} are using them`;
}
