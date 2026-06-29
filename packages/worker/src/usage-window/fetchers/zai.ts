import {
  clampPct,
  errMsg,
  num,
  rec,
  type UsageFetcher,
  type UsageFetchOutcome,
  type UsageWindows,
} from '../types.js';

// VOLATILE — endpoints the official zai-coding-plugins `glm-plan-usage` script
// calls. Z.AI exposes ONLY a 5-hour token window (no weekly anywhere). Auth is
// the raw token with NO "Bearer " prefix.
const ZAI_DEFAULT_BASE = 'https://api.z.ai';
const ZAI_USAGE_PATH = '/api/monitor/usage/quota/limit';

/** Parse `/api/monitor/usage/quota/limit`: an array whose `TOKENS_LIMIT` item's
 *  `percentage` is the 5-hour used-%. (A sibling `TIME_LIMIT` is a separate cap,
 *  not a weekly window.) */
export function parseZaiUsage(json: unknown): UsageWindows {
  const j = rec(json);
  const arr: unknown[] = Array.isArray(json)
    ? json
    : Array.isArray(j?.['data'])
      ? (j!['data'] as unknown[])
      : [];
  for (const item of arr) {
    const r = rec(item);
    if (r && r['type'] === 'TOKENS_LIMIT') {
      const p = num(r['percentage']);
      if (p !== undefined) return { fiveHour: { usedPct: clampPct(p), resetsAt: null } };
    }
  }
  return {};
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
    if (!res.ok) return { ok: false, rateLimited: false, error: `http ${res.status}` };
    const windows = parseZaiUsage(await res.json());
    if (!windows.fiveHour)
      return { ok: false, rateLimited: false, error: 'unexpected response shape' };
    return { ok: true, windows };
  } catch (err) {
    return { ok: false, rateLimited: false, error: errMsg(err) };
  }
};
