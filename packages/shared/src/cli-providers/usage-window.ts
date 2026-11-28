/** Existing UI freshness bound: about 2.5 five-minute poll intervals. Also bounds
 *  new allowance-watch evidence; a previously captured reset stays authoritative. */
export const USAGE_SNAPSHOT_STALE_AFTER_MS = 13 * 60 * 1000;

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
 * shape didn't match (the chip hides that provider), 'needs_reconnect' when
 * the provider's usage credential was rejected and only a re-auth can fix it
 * (the chip prompts a reconnect instead of hiding), and 'pending' when the user
 * has ALREADY re-authed and the poller has not caught up — derived by the API,
 * never stored, so it disappears on its own the moment a fresh reading lands.
 */
export interface UsageWindowSnapshot {
  providerId: string;
  providerName: string;
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  daily?: UsageWindow;
  fetchedAt: string;
  stale: boolean;
  status: 'ok' | 'error' | 'needs_reconnect' | 'pending';
}

/** Fetcher names, exhaustively matched by the worker's usage endpoint registry. */
export const USAGE_WINDOW_PROVIDERS = ['claude-code', 'codex', 'gemini', 'zai'] as const;

export type UsageWindowProviderName = (typeof USAGE_WINDOW_PROVIDERS)[number];

/** Whether this row can be polled for a usage window. Claude's separate usage OAuth
 * requires subscription auth, even when an API-key row retains a legacy grant/snapshot.
 * Other fetchers keep their existing auth-mode eligibility. Credential presence and
 * provider enablement are separate checks: this describes capability, not liveness.
 * Browser-safe subpath shared by polling, outage recovery and display callers. */
export function hasUsageWindow(
  name: string | null | undefined,
  authMode: string | null | undefined,
): boolean {
  return (
    USAGE_WINDOW_PROVIDERS.some((provider) => provider === name) &&
    (name !== 'claude-code' || authMode === 'subscription')
  );
}
