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

/** The CLIs Haive can read a subscription-usage window from — exactly the providers that have
 *  a fetcher in the worker's USAGE_PROVIDERS.
 *
 *  It lives here rather than in the worker because the WEB needs the same fact and cannot
 *  import worker code. Without it the task-header chip cannot tell "this CLI publishes no usage
 *  endpoint" (ollama, grok, amp, antigravity — nothing to show and nothing wrong, so the chip
 *  stays blank) from "this CLI has one but this provider produced no reading" (not signed in,
 *  which is worth saying out loud). Those two look identical from the API: no snapshot row.
 *
 *  Both sides are pinned to it at COMPILE time — the worker's map is declared
 *  `satisfies Record<UsageWindowProviderName, ProviderUsageConfig>` and the web's metered map is
 *  a `Record<UsageWindowProviderName, true>` — so adding a fetcher without extending this list,
 *  or the reverse, breaks `tsc` in that package instead of leaving the chip quietly mislabelling
 *  the new CLI forever. */
export const USAGE_WINDOW_PROVIDERS = ['claude-code', 'codex', 'gemini', 'zai'] as const;

export type UsageWindowProviderName = (typeof USAGE_WINDOW_PROVIDERS)[number];
