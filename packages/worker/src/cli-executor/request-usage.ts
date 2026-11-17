/** In-process evidence only; collection never stores or prices it. Input stays provider-native:
 * exclusive for Claude, inclusive for Codex/Gemini. Only the pricer splits inclusive input. */
import type {
  PricedTokens,
  RequestUsage,
  RequestUsageCapture,
  UnobservedSameModelUsage,
} from '@haive/shared';
export type { RequestUsage, RequestUsageCapture, UnobservedSameModelUsage } from '@haive/shared';

export type UnobservedSameModelPricingBlocker =
  'unknown-cache-ttl' | 'unknown-output-usage' | 'unknown-output-request-size';

/** Diagnostics for aggregate usage outside the request inventory. The tier pricer
 * validates its own evidence: unknown TTL/output prevent finite bounds, while known
 * output without a request size may be bounded over all reachable rates. This helper
 * does not select rates or establish request coverage. */
export function unobservedSameModelPricingBlockers(
  excess: UnobservedSameModelUsage,
): UnobservedSameModelPricingBlocker[] {
  const blockers: UnobservedSameModelPricingBlocker[] = [];
  if (
    excess.cacheCreationTokens > 0 &&
    (excess.cacheCreation5mTokens === null || excess.cacheCreation1hTokens === null)
  )
    blockers.push('unknown-cache-ttl');
  if (excess.outputTokens === null) blockers.push('unknown-output-usage');
  else if (excess.outputTokens > 0) blockers.push('unknown-output-request-size');
  return blockers;
}

export function unknownRequestUsage(reason = 'no-request-channel'): RequestUsageCapture {
  return {
    requests: null,
    coverage: 'unknown',
    inputConvention: 'unknown',
    requestCount: null,
    modelCoverage: 'unknown',
    reasons: [reason],
  };
}

/** Process-local sub-step evidence. Namespace identities because each CLI process can reuse ids.
 * Any missing channel, convention or model prevents a complete aggregate. */
export function aggregateRequestUsage(
  parts: { id: string; usage?: RequestUsageCapture; tokenUsage?: PricedTokens | null }[],
): RequestUsageCapture {
  if (!parts.length) return unknownRequestUsage('no-substeps');
  const captures = parts.map((p) => p.usage ?? unknownRequestUsage());
  const requests = parts.flatMap((p, i) =>
    (p.usage?.requests ?? []).map((r) => ({
      ...r,
      requestId: JSON.stringify([i, p.id, r.requestId]),
    })),
  );
  const unobservedSameModel = captures.flatMap((c) =>
    (c.coverage === 'complete' ? (c.unobservedSameModel ?? []) : []).map((usage) => ({ ...usage })),
  );
  const conventions = new Set(captures.map((c) => c.inputConvention));
  const inputConvention = conventions.size === 1 ? captures[0]!.inputConvention : 'unknown';
  const models = new Set(
    captures.flatMap(
      (c) => c.wholeRun?.usage.model ?? c.aggregateModel ?? c.requests?.map((r) => r.model) ?? [],
    ),
  );
  const modelCoverage =
    captures.some((c) => c.modelCoverage === 'mixed') || models.size > 1
      ? 'mixed'
      : models.size === 1 &&
          !models.has(null) &&
          captures.every((c) => c.modelCoverage === 'single')
        ? 'single'
        : requestModelCoverage(requests);
  const complete =
    captures.every((c) => c.coverage === 'complete') &&
    inputConvention !== 'unknown' &&
    modelCoverage === 'single';
  const count = captures.every((c) => c.requestCount !== null)
    ? captures.reduce((n, c) => n + c.requestCount!, 0)
    : null;
  return {
    parts: parts.map((p, i) => ({
      id: p.id,
      tokenUsage: p.tokenUsage ?? null,
      usage: captures[i]!,
    })),
    requests: captures.some((c) => c.requests !== null) ? requests : null,
    ...(complete && unobservedSameModel.length ? { unobservedSameModel } : {}),
    coverage: complete ? 'complete' : requests.length ? 'incomplete' : 'unknown',
    inputConvention,
    requestCount: count !== null && Number.isSafeInteger(count) ? count : null,
    modelCoverage,
    reasons: complete
      ? []
      : [...new Set(['substep-coverage', ...captures.flatMap((c) => c.reasons)])],
  };
}

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function requestModelCoverage(
  requests: RequestUsage[],
): RequestUsageCapture['modelCoverage'] {
  if (!requests.length || requests.some((r) => r.model === null)) return 'unknown';
  return new Set(requests.map((r) => r.model)).size === 1 ? 'single' : 'mixed';
}

/** Strict view alongside the permissive legacy token collector: bad evidence cannot prove
 * coverage, but must not change token totals. Absent optional cache buckets mean zero. */
export function claudeRequestUsage(
  raw: unknown,
  requestId: string,
  model: string | null,
): RequestUsage | null {
  const u = record(raw);
  if (!u) return null;
  const inputTokens = tokenCount(u.input_tokens);
  const outputTokens = tokenCount(u.output_tokens);
  if (u.output_tokens !== undefined && outputTokens === null) return null;
  const cacheReadTokens = tokenCount(
    u.cache_read_input_tokens === undefined ? 0 : u.cache_read_input_tokens,
  );
  const cacheCreationTokens = tokenCount(
    u.cache_creation_input_tokens === undefined ? 0 : u.cache_creation_input_tokens,
  );
  if (inputTokens === null || cacheReadTokens === null || cacheCreationTokens === null) return null;
  const ttl = record(u.cache_creation);
  const five = ttl ? tokenCount(ttl.ephemeral_5m_input_tokens) : null;
  const hour = ttl ? tokenCount(ttl.ephemeral_1h_input_tokens) : null;
  const ttlKnown = five !== null && hour !== null && five + hour === cacheCreationTokens;
  // Some wrappers default-fill both TTL counters with zero beside positive writes.
  // Keep the authoritative write total and mark that split unknown.
  const defaultFilled = cacheCreationTokens > 0 && five === 0 && hour === 0;
  if (u.cache_creation !== undefined && !ttlKnown && !defaultFilled) return null;
  return {
    requestId,
    turnId: null,
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheCreation5mTokens: cacheCreationTokens === 0 ? 0 : ttlKnown ? five : null,
    cacheCreation1hTokens: cacheCreationTokens === 0 ? 0 : ttlKnown ? hour : null,
  };
}
