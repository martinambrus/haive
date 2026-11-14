import type { CliTokenUsage } from '@haive/shared';
import {
  record,
  requestModelCoverage,
  tokenCount,
  type RequestUsage,
  type RequestUsageCapture,
} from './request-usage.js';

const buckets = [
  'inputTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'outputTokens',
] as const;
type Buckets = Record<(typeof buckets)[number], number>;
const zero = (): Buckets => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
});

function readBuckets(raw: unknown): Buckets | null {
  const u = record(raw);
  if (!u) return null;
  const out = zero();
  for (const key of buckets) {
    const n = tokenCount(key === 'cacheWriteInputTokens' && u[key] === undefined ? 0 : u[key]);
    if (n === null) return null;
    out[key] = n;
  }
  if (out.cachedInputTokens + out.cacheWriteInputTokens > out.inputTokens) return null;
  if (
    u.totalTokens !== undefined &&
    tokenCount(u.totalTokens) !== out.inputTokens + out.outputTokens
  )
    return null;
  if (
    u.reasoningOutputTokens !== undefined &&
    (tokenCount(u.reasoningOutputTokens) === null ||
      Number(u.reasoningOutputTokens) > out.outputTokens)
  )
    return null;
  return out;
}

/** The measured 0.154.0 notifications (codex-app-server-session.test.ts) have no request id.
 * Multiple requests share one turn. Use the entire cumulative watermark, never the turn id,
 * and accept last only if every bucket equals the increase since the preceding watermark.
 * A skipped note can expose a request only as a gap, never as an invented prompt size. */
export function createCodexRequestUsageCollector() {
  const requests: RequestUsage[] = [];
  const reasons = new Set<string>();
  const seen = new Set<string>();
  let previous = zero();
  let watermark: Buckets | null = null;
  return {
    onUsage(
      raw: unknown,
      model: string | null,
      threadId: string | null,
      turnId: string | null,
      expectedTurnId: string | null,
    ): void {
      if (!threadId || !turnId || turnId !== expectedTurnId) reasons.add('request-identity');
      const u = record(raw);
      const total = readBuckets(u?.total);
      const last = readBuckets(u?.last);
      if (!total || !last) {
        reasons.add('invalid-usage-note');
        return;
      }
      const key = buckets.map((k) => total[k]).join(':');
      if (seen.has(key)) {
        reasons.add('duplicate-watermark');
        return;
      }
      seen.add(key);
      const reconciled = buckets.every((k) => total[k] - previous[k] === last[k]);
      if (!reconciled || buckets.every((k) => last[k] === 0)) {
        reasons.add('watermark-delta');
      } else {
        requests.push({
          requestId: `${threadId}:total:${key}`,
          turnId,
          model,
          inputTokens: last.inputTokens,
          cacheReadTokens: last.cachedInputTokens,
          cacheCreationTokens: last.cacheWriteInputTokens,
          outputTokens: last.outputTokens,
          cacheCreation5mTokens: last.cacheWriteInputTokens === 0 ? 0 : null,
          cacheCreation1hTokens: last.cacheWriteInputTokens === 0 ? 0 : null,
        });
      }
      previous = total;
      watermark = total;
    },
    get(
      completed: boolean,
      malformed: number,
      finalUsage: CliTokenUsage | null,
    ): RequestUsageCapture {
      const issues = new Set(reasons);
      if (!completed) issues.add('missing-completion');
      if (malformed > 0) issues.add('malformed-stream');
      if (!requests.length) issues.add('missing-requests');
      const sum = (key: keyof RequestUsage) => requests.reduce((n, r) => n + Number(r[key]), 0);
      if (
        !watermark ||
        !finalUsage ||
        sum('inputTokens') !== finalUsage.inputTokens ||
        sum('cacheReadTokens') !== (finalUsage.cacheReadTokens ?? 0) ||
        sum('outputTokens') !== finalUsage.outputTokens ||
        sum('inputTokens') !== watermark.inputTokens ||
        sum('cacheReadTokens') !== watermark.cachedInputTokens ||
        sum('cacheCreationTokens') !== watermark.cacheWriteInputTokens ||
        sum('outputTokens') !== watermark.outputTokens
      )
        issues.add('final-usage-mismatch');
      if (requests.some((r) => r.cacheCreationTokens > 0)) issues.add('unknown-cache-ttl');
      const modelCoverage = requestModelCoverage(requests);
      if (modelCoverage !== 'single') issues.add('model-coverage');
      const complete = issues.size === 0;
      return {
        requests: requests.map((r) => ({ ...r })),
        coverage: complete ? 'complete' : 'incomplete',
        inputConvention: 'inclusive',
        requestCount: complete ? requests.length : null,
        modelCoverage,
        reasons: [...issues],
      };
    },
  };
}
