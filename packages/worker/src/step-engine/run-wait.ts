/** Live matches `cli_invocations_one_live_per_step_idx` (ended_at IS NULL AND superseded_at
 *  IS NULL): a Retry can supersede a run before it starts; nothing then picks it up. */
export function runIsLive(inv: { endedAt: Date | null; supersededAt: Date | null }): boolean {
  return inv.endedAt === null && inv.supersededAt === null;
}
