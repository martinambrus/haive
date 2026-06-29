import {
  clampPct,
  errMsg,
  isoOrNull,
  num,
  rec,
  type UsageFetcher,
  type UsageFetchOutcome,
  type UsageWindows,
} from '../types.js';

// VOLATILE — the private `v1internal` endpoint the Gemini CLI's own /stats uses.
// Gemini exposes a DAILY (rolling 24h) window, NOT 5h/weekly, and reports
// `remainingFraction` (0-1 LEFT), which we invert to used-%.
const GEMINI_USAGE_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota';

/** Parse the `retrieveUserQuota` body: pick the REQUESTS bucket (else the first
 *  bucket carrying a remainingFraction) and invert its fraction to a daily used-%. */
export function parseGeminiUsage(json: unknown): UsageWindows {
  const j = rec(json);
  const raw = Array.isArray(j?.['buckets']) ? (j!['buckets'] as unknown[]) : [];
  const buckets = raw
    .map(rec)
    .filter((b): b is Record<string, unknown> => !!b && num(b['remainingFraction']) !== undefined);
  const bucket = buckets.find((b) => b['tokenType'] === 'REQUESTS') ?? buckets[0];
  if (bucket) {
    const frac = num(bucket['remainingFraction']);
    if (frac !== undefined) {
      return {
        daily: { usedPct: clampPct((1 - frac) * 100), resetsAt: isoOrNull(bucket['resetTime']) },
      };
    }
  }
  return {};
}

export const fetchGeminiUsage: UsageFetcher = async (token): Promise<UsageFetchOutcome> => {
  try {
    const res = await fetch(GEMINI_USAGE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (res.status === 429) return { ok: false, rateLimited: true, error: 'http 429' };
    if (!res.ok) return { ok: false, rateLimited: false, error: `http ${res.status}` };
    const windows = parseGeminiUsage(await res.json());
    if (!windows.daily)
      return { ok: false, rateLimited: false, error: 'unexpected response shape' };
    return { ok: true, windows };
  } catch (err) {
    return { ok: false, rateLimited: false, error: errMsg(err) };
  }
};
