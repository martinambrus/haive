/**
 * One subscription-usage window, normalized from a vendor's (undocumented)
 * usage endpoint. `usedPct` is 0-100 CONSUMED — every fetcher normalizes to
 * this, inverting vendors that report a "remaining" fraction/percent.
 * `resetsAt` is an ISO-8601 timestamp (null when the vendor omits it).
 */
export interface UsageWindow {
  usedPct: number;
  resetsAt: string | null;
}

/**
 * Per-provider usage snapshot. A provider surfaces whichever windows its vendor
 * exposes: claude-code/codex -> fiveHour + sevenDay; zai -> fiveHour;
 * gemini -> daily. Windows the vendor doesn't expose are left undefined.
 * `stale` is set by the API when the row is older than a couple of poll
 * intervals; `status` is 'error' when the last fetch failed or the response
 * shape didn't match (the chip hides that provider), and 'needs_reconnect' when
 * the provider's usage OAuth token was rejected and only a re-auth can fix it
 * (the chip prompts a reconnect instead of hiding).
 */
export interface UsageWindowSnapshot {
  providerId: string;
  providerName: string;
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  daily?: UsageWindow;
  fetchedAt: string;
  stale: boolean;
  status: 'ok' | 'error' | 'needs_reconnect';
}
