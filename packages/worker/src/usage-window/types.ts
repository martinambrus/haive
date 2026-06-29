import type { CliProviderName, UsageWindow } from '@haive/shared';

export type { UsageWindow } from '@haive/shared';

/** The set of windows a single fetch yielded. A provider fills only the windows
 *  its vendor exposes (claude/codex: fiveHour+sevenDay; zai: fiveHour; gemini:
 *  daily). */
export interface UsageWindows {
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  daily?: UsageWindow;
}

/** Discriminated fetch result so the poller can distinguish a 429 (back off)
 *  from a hard failure (mark error), and never throws into the poll loop. */
export type UsageFetchOutcome =
  | { ok: true; windows: UsageWindows }
  | { ok: false; rateLimited: boolean; error: string };

export interface UsageFetchContext {
  providerName: CliProviderName;
  /** provider.cliVersion — feeds the claude `User-Agent: claude-code/<ver>`,
   *  which the endpoint REQUIRES (a blank UA is permanently 429'd). Null falls
   *  back to a constant. */
  cliVersion?: string | null;
  /** Base URL override (zai reads the provider's ANTHROPIC_BASE_URL host). */
  baseUrl?: string | null;
  /** ChatGPT account id from codex auth.json (tokens.account_id). */
  accountId?: string | null;
}

export type UsageFetcher = (token: string, ctx: UsageFetchContext) => Promise<UsageFetchOutcome>;

// --- defensive parse helpers (vendor JSON is untrusted + volatile) ---

export function rec(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
}

export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function clampPct(v: number): number {
  return Math.round(Math.min(100, Math.max(0, v)));
}

/** Normalize an ISO-8601 string OR a unix timestamp (seconds or millis) to an
 *  ISO string. Returns null for anything unparseable. */
export function isoOrNull(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    const ms = v > 1e12 ? v : v * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
