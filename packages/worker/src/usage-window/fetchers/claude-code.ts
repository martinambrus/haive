import {
  clampPct,
  errMsg,
  httpErrorOutcome,
  isoOrNull,
  num,
  rec,
  type UsageFetcher,
  type UsageFetchOutcome,
  type UsageWindows,
} from '../types.js';

// VOLATILE — undocumented endpoint Claude Code itself calls to populate the
// statusline `rate_limits`. Pinned here; on any shape change the parser yields
// no windows and the chip hides (fail-loud, never silent-wrong).
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const ANTHROPIC_BETA = 'oauth-2025-04-20';
// The endpoint drops requests with a blank/foreign User-Agent into an
// aggressively rate-limited bucket (persistent 429). It must look like the CLI:
// `claude-code/<version>`. provider.cliVersion supplies the real version; this
// is only the fallback when it's unknown.
const FALLBACK_CLI_VERSION = '2.0.0';

/** Parse the `/api/oauth/usage` body. `utilization` is 0-100 CONSUMED. */
export function parseClaudeUsage(json: unknown): UsageWindows {
  const j = rec(json);
  const out: UsageWindows = {};
  const fh = rec(j?.['five_hour']);
  const fhu = num(fh?.['utilization']);
  if (fh && fhu !== undefined) {
    out.fiveHour = { usedPct: clampPct(fhu), resetsAt: isoOrNull(fh['resets_at']) };
  }
  const sd = rec(j?.['seven_day']);
  const sdu = num(sd?.['utilization']);
  if (sd && sdu !== undefined) {
    out.sevenDay = { usedPct: clampPct(sdu), resetsAt: isoOrNull(sd['resets_at']) };
  }
  return out;
}

export const fetchClaudeUsage: UsageFetcher = async (token, ctx): Promise<UsageFetchOutcome> => {
  try {
    const res = await fetch(CLAUDE_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': ANTHROPIC_BETA,
        'User-Agent': `claude-code/${ctx.cliVersion ?? FALLBACK_CLI_VERSION}`,
        'Content-Type': 'application/json',
      },
    });
    if (res.status === 429) return { ok: false, rateLimited: true, error: 'http 429' };
    if (!res.ok) return httpErrorOutcome(res.status);
    const windows = parseClaudeUsage(await res.json());
    if (!windows.fiveHour && !windows.sevenDay) {
      return { ok: false, rateLimited: false, error: 'unexpected response shape' };
    }
    return { ok: true, windows };
  } catch (err) {
    return { ok: false, rateLimited: false, error: errMsg(err) };
  }
};
