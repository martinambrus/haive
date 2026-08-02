import {
  clampPct,
  errMsg,
  httpErrorOutcome,
  isWeeklyHorizon,
  isoOrNull,
  num,
  rec,
  type UsageFetcher,
  type UsageFetchOutcome,
  type UsageWindow,
  type UsageWindows,
} from '../types.js';

// VOLATILE — undocumented endpoint the Codex TUI itself polls. The raw-HTTP body
// shape is moderate-confidence (primary_window/secondary_window with percent_left);
// the codex `app-server` JSON-RPC `account/rateLimits/read` is the definitive
// fallback (used_percent) but needs spawning the binary. The parser below tolerates
// BOTH shapes so it survives whichever this endpoint returns; on neither it yields
// no windows and the chip hides.
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

function pickWindow(w: unknown): UsageWindow | undefined {
  const r = rec(w);
  if (!r) return undefined;
  // Protocol shape: used_percent (0-100 CONSUMED).
  const used = num(r['used_percent']);
  if (used !== undefined) {
    return { usedPct: clampPct(used), resetsAt: isoOrNull(r['resets_at'] ?? r['reset_at']) };
  }
  // Raw-HTTP shape: percent_left (REMAINING) — invert.
  const left = num(r['percent_left']);
  if (left !== undefined) {
    return { usedPct: clampPct(100 - left), resetsAt: isoOrNull(r['reset_at'] ?? r['resets_at']) };
  }
  return undefined;
}

export function parseCodexUsage(json: unknown, now: number = Date.now()): UsageWindows {
  const j = rec(json);
  // Windows may be nested under `rate_limit` or sit at the top level.
  const root = rec(j?.['rate_limit']) ?? j;
  const primary = pickWindow(root?.['primary'] ?? root?.['primary_window']);
  const secondary = pickWindow(root?.['secondary'] ?? root?.['secondary_window']);

  const out: UsageWindows = {};
  if (primary && secondary) {
    // Both present (Pro): the slots are authoritative — primary is the 5h window,
    // secondary the weekly one.
    out.fiveHour = primary;
    out.sevenDay = secondary;
  } else {
    // One present (Plus returns a single window, and it lands in `primary` even
    // though it is the WEEKLY limit). Trusting the slot mislabels it "5h"; key on
    // the reset horizon so it maps to the window it actually is.
    const only = primary ?? secondary;
    if (only) {
      if (isWeeklyHorizon(only.resetsAt, now)) out.sevenDay = only;
      else out.fiveHour = only;
    }
  }
  return out;
}

export const fetchCodexUsage: UsageFetcher = async (token, ctx): Promise<UsageFetchOutcome> => {
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
    if (ctx.accountId) headers['chatgpt-account-id'] = ctx.accountId;
    const res = await fetch(CODEX_USAGE_URL, { method: 'GET', headers });
    if (res.status === 429) return { ok: false, rateLimited: true, error: 'http 429' };
    if (!res.ok) return httpErrorOutcome(res.status);
    const windows = parseCodexUsage(await res.json());
    if (!windows.fiveHour && !windows.sevenDay) {
      return { ok: false, rateLimited: false, error: 'unexpected response shape' };
    }
    return { ok: true, windows };
  } catch (err) {
    return { ok: false, rateLimited: false, error: errMsg(err) };
  }
};
