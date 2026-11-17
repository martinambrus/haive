/** Process-local request evidence. Input uses the provider-native convention. */
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

export type UnobservedSameModelUsage = Omit<RequestUsage, 'requestId' | 'turnId'>;

export interface RequestUsageCapture {
  requests: RequestUsage[] | null;
  /** Only on complete captures: ledger excess for an observed model, outside the request inventory. These are
   * aggregate buckets, not inferred requests; unknown output and cache-write TTL stay null. */
  unobservedSameModel?: UnobservedSameModelUsage[];
  coverage: 'complete' | 'incomplete' | 'unknown';
  inputConvention: 'exclusive' | 'inclusive' | 'unknown';
  /** Exact only when the transcript proves it; Gemini reports this independently. */
  requestCount: number | null;
  modelCoverage: 'single' | 'mixed' | 'unknown';
  reasons: string[];
  /** Structural whole-run evidence, independent of request prompt reconciliation.
   * A single intact completion covers these buckets; requestCount stays null unless
   * the observed usage reconciles in every bucket or all observed usage is zero
   * (the wrapper placeholder convention). A present ledger must match the run total. */
  wholeRun?: {
    usage: UnobservedSameModelUsage;
    requestCount: number | null;
  };
  /** Reconciled aggregate-only channel (Gemini). */
  aggregateModel?: string;
}
