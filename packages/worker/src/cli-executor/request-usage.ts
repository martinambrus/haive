/** In-process evidence only; PR 2 never stores or prices it. Input stays provider-native:
 * exclusive for Claude, inclusive for Codex/Gemini. Only a future pricer splits inclusive input. */
export interface RequestUsage {
  requestId: string;
  turnId: string | null;
  model: string | null;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number | null;
  cacheCreation5mTokens: number | null;
  cacheCreation1hTokens: number | null;
}

export interface RequestUsageCapture {
  requests: RequestUsage[] | null;
  /** Ledger excess for an observed model, outside the request inventory. These are
   * aggregate buckets, not inferred requests; unknown output and cache-write TTL stay null. */
  unobservedSameModel?: Omit<RequestUsage, 'requestId' | 'turnId'>[];
  coverage: 'complete' | 'incomplete' | 'unknown';
  inputConvention: 'exclusive' | 'inclusive' | 'unknown';
  /** Exact only when the transcript proves it; Gemini reports this independently. */
  requestCount: number | null;
  modelCoverage: 'single' | 'mixed' | 'unknown';
  reasons: string[];
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
  parts: { id: string; usage?: RequestUsageCapture }[],
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
    (c.unobservedSameModel ?? []).map((usage) => ({ ...usage })),
  );
  const conventions = new Set(captures.map((c) => c.inputConvention));
  const inputConvention = conventions.size === 1 ? captures[0]!.inputConvention : 'unknown';
  const modelCoverage = captures.some((c) => c.modelCoverage === 'mixed')
    ? 'mixed'
    : requestModelCoverage(requests);
  const complete =
    captures.every((c) => c.coverage === 'complete') &&
    inputConvention !== 'unknown' &&
    modelCoverage === 'single';
  const count = captures.every((c) => c.requestCount !== null)
    ? captures.reduce((n, c) => n + c.requestCount!, 0)
    : null;
  return {
    requests: captures.some((c) => c.requests !== null) ? requests : null,
    ...(unobservedSameModel.length ? { unobservedSameModel } : {}),
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
  if (u.cache_creation !== undefined && !ttlKnown) return null;
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
