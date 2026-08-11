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

/** Discriminated fetch result so the poller can distinguish a 429 (transient, back
 *  off) from an auth denial (`authExpired`: the token is rejected and only a re-auth
 *  fixes it, so stop re-polling) from other hard failures, and never throws into the
 *  poll loop. */
export type UsageFetchOutcome =
  | { ok: true; windows: UsageWindows }
  | { ok: false; rateLimited: boolean; authExpired?: boolean; error: string };

/** Error outcome for a non-ok HTTP status. 401/403 mean the credential is rejected —
 *  a revoked/expired/insufficient-scope token that won't recover on its own — so flag
 *  `authExpired` and let the poller stop hitting the same deny every tick. 429 is a
 *  transient rate-limit and is handled by each fetcher BEFORE this, so it never lands
 *  here. Shared by every fetcher so the auth-deny policy stays in one place. */
export function httpErrorOutcome(status: number): Extract<UsageFetchOutcome, { ok: false }> {
  return {
    ok: false,
    rateLimited: false,
    authExpired: status === 401 || status === 403,
    error: `http ${status}`,
  };
}

export type AuthStrikeAction = 'hold' | 'escalate';

/** Increment an auth-denial strike count and decide whether to escalate. Pure so the
 *  consecutive-denial threshold is unit-tested without a DB/fetch (mirrors httpErrorOutcome).
 *  A single 401/403 is often transient (Cloudflare/Google WAF, or a just-expired cached
 *  token the CLI will refresh itself) — only escalate once `threshold` land in a row. */
export function nextAuthStrike(
  prev: number,
  threshold: number,
): { strikes: number; action: AuthStrikeAction } {
  const strikes = prev + 1;
  return { strikes, action: strikes >= threshold ? 'escalate' : 'hold' };
}

/** Whether a persistent auth denial deserves the actionable `needs_reconnect` status or the
 *  quiet `error` that just hides the meter.
 *
 *  `reconnectable` providers (claude usage-OAuth, zai) always nag: their token only ever dies
 *  in ways a user action fixes. The `volumeJson` CLIs (codex, gemini) are the interesting
 *  case — the flag was set false because their cached access token lapses benignly whenever
 *  the CLI sits idle, and the CLI refreshes it itself on its next run, so nagging there cries
 *  wolf. That reasoning only covers a token that had actually EXPIRED. A vendor rejecting a
 *  token whose own `exp` is still in the future is a server-side revocation (observed: codex
 *  401 `token_expired` on a token with a day left on it, after the ChatGPT session was
 *  revoked), and nothing but a re-login brings that back.
 *
 *  Keyed on the JWT `exp` claim rather than the vendor's error `code`: the code is
 *  human-facing copy that can be reworded at any time, `exp` is structural. A token with no
 *  readable `exp` keeps the old quiet behaviour, so gemini is untouched.
 *
 *  Blind spot, accepted: a token revoked and THEN left idle past its own expiry reads as a
 *  benign lapse and stays quiet — which is exactly what it did before this existed. */
export function authDenialSeverity(opts: {
  reconnectable: boolean;
  token: string;
  now: number;
}): 'reconnect' | 'silent' {
  if (opts.reconnectable) return 'reconnect';
  const exp = jwtExpMs(opts.token);
  return exp !== null && exp > opts.now ? 'reconnect' : 'silent';
}

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

/** `exp` of a JWT access token in epoch ms, or null for anything that is not a JWT carrying
 *  a finite numeric `exp` — an opaque bearer (gemini hands out `ya29.*`), a truncated file,
 *  garbage. Only the payload is decoded and nothing is verified: the signature is the
 *  vendor's business, and this reads the token's own claim about itself rather than trusting
 *  it with anything. Feeds authDenialSeverity. */
export function jwtExpMs(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const exp = num(rec(payload)?.['exp']);
    return exp === undefined ? null : exp * 1000;
  } catch {
    return null;
  }
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// A 5-hour window always resets within 5h; anything resetting further out is a longer
// (weekly) window. 6h leaves an hour of slack for clock skew / vendor rounding.
const FIVE_HOUR_MAX_HORIZON_MS = 6 * 60 * 60 * 1000;

/** Classify a window by its OWN reset horizon rather than by the slot or label the vendor
 *  filed it under: a reset more than ~6h out cannot be a 5-hour window. No readable reset
 *  -> assume the 5-hour slot.
 *
 *  Shared by the codex and zai parsers because both receive windows whose period the
 *  payload never states — codex returns a lone window in the `primary` slot that is really
 *  the weekly limit on Plus, and zai tags its windows only with an undocumented
 *  `unit`/`number` integer pair. The reset instant is the stable fact in both. */
export function isWeeklyHorizon(resetsAt: string | null, now: number): boolean {
  if (!resetsAt) return false;
  const t = new Date(resetsAt).getTime();
  return Number.isFinite(t) && t - now > FIVE_HOUR_MAX_HORIZON_MS;
}
