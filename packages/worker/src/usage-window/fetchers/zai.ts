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
  type UsageWindows,
} from '../types.js';

// VOLATILE — endpoints the official zai-coding-plugins `glm-plan-usage` script
// calls. Auth is the raw token with NO "Bearer " prefix.
const ZAI_DEFAULT_BASE = 'https://api.z.ai';
const ZAI_USAGE_PATH = '/api/monitor/usage/quota/limit';

/** The limits array, from whichever envelope this deployment returns.
 *
 *  Three shapes are accepted because z.ai has already moved it once: the array was
 *  returned bare, then under `data`, and now under `data.limits` — the last move silently
 *  emptied the parse and the meter read `unexpected response shape` while HTTP stayed 200.
 *  Unknown envelope yields `[]`, which the caller reports rather than drawing a zero. */
function limitsOf(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  const j = rec(json);
  if (Array.isArray(j?.['data'])) return j['data'] as unknown[];
  const limits = rec(j?.['data'])?.['limits'];
  return Array.isArray(limits) ? limits : [];
}

/** Parse `/api/monitor/usage/quota/limit`: every `TOKENS_LIMIT` item carries a
 *  `percentage` used-%. (A sibling `TIME_LIMIT` is a separate cap on non-token tools,
 *  not a usage window — excluded.)
 *
 *  z.ai now returns TWO token windows, not the single 5-hour one this parser was written
 *  against. Which is which is stated only by an undocumented `unit`/`number` integer pair
 *  (`unit:3,number:5` alongside `unit:6,number:1`), so the period is read from each item's
 *  own `nextResetTime` via isWeeklyHorizon instead — the same rule the codex parser uses.
 *  An item with no reset is the 5-hour window (z.ai omits the reset until the window
 *  opens). First item wins a slot, so a repeated period cannot flip the reading. */
export function parseZaiUsage(json: unknown, now: number = Date.now()): UsageWindows {
  const out: UsageWindows = {};
  for (const item of limitsOf(json)) {
    const r = rec(item);
    if (!r || r['type'] !== 'TOKENS_LIMIT') continue;
    const p = num(r['percentage']);
    if (p === undefined) continue;
    const resetsAt = isoOrNull(r['nextResetTime']);
    const slot = isWeeklyHorizon(resetsAt, now) ? 'sevenDay' : 'fiveHour';
    out[slot] ??= { usedPct: clampPct(p), resetsAt };
  }
  return out;
}

function originOf(url: string | null | undefined): string {
  if (url) {
    try {
      return new URL(url).origin;
    } catch {
      // fall through to default
    }
  }
  return ZAI_DEFAULT_BASE;
}

export const fetchZaiUsage: UsageFetcher = async (token, ctx): Promise<UsageFetchOutcome> => {
  try {
    const base = originOf(ctx.baseUrl);
    const res = await fetch(`${base}${ZAI_USAGE_PATH}`, {
      method: 'GET',
      // Raw token, NO "Bearer " prefix (confirmed in the vendor plugin).
      headers: { Authorization: token, Accept: 'application/json' },
    });
    if (res.status === 429) return { ok: false, rateLimited: true, error: 'http 429' };
    if (!res.ok) return httpErrorOutcome(res.status);
    const windows = parseZaiUsage(await res.json());
    // Either window alone is a usable reading — a plan may expose only the weekly one.
    if (!windows.fiveHour && !windows.sevenDay)
      return { ok: false, rateLimited: false, error: 'unexpected response shape' };
    return { ok: true, windows };
  } catch (err) {
    return { ok: false, rateLimited: false, error: errMsg(err) };
  }
};
