import type { HostApi } from '@haive/web-kit/host';
import type { CostDisplay } from '@haive/web-kit/format-cost';

export interface Repository {
  id: string;
  name: string;
}

export interface UiPrefs {
  /** IANA zone the statistics day buckets are cut on. Absent = follow the browser. Per USER
   *  rather than per browser: which calendar a person reads their week in is about the person.
   *  The blob is schemaless on the server, so this needed no migration. */
  statsTimeZone?: string;
}

export function getUiPrefs(api: HostApi): Promise<UiPrefs> {
  return api
    .get<{ settingsJson: string }>('/user-settings/ui-prefs')
    .then((res) => JSON.parse(res.settingsJson) as UiPrefs)
    .catch(() => ({}));
}

/** Write only the keys given, merged server-side into the stored blob. */
export function patchUiPrefs(api: HostApi, partial: UiPrefs): Promise<void> {
  return api
    .patch('/user-settings/ui-prefs', { settingsJson: JSON.stringify(partial) })
    .then(() => undefined);
}

/** One completed task's AI-estimate-vs-actual-effort accuracy (estimation dashboard). */
export interface EstimationAccuracyRow {
  taskId: string;
  title: string;
  completedAt: string | null;
  /** RAW AI estimate (decimal hours). */
  aiEstimatedHours: number;
  /** Human-confirmed estimate (decimal hours), for reference. */
  confirmedHours: number | null;
  /** MEASURED actual effort (work + user-active, decimal hours). */
  actualHours: number;
  /** Signed % error of the AI estimate vs actual ((actual-ai)/actual*100); positive means
   *  the AI under-estimated (task took longer than predicted). */
  signedErrorPct: number;
  absErrorPct: number;
}

export interface EstimationAccuracySummary {
  taskCount: number;
  /** Mean Absolute Percentage Error of the AI estimate vs actual effort. */
  mapePct: number;
  /** Median actual/ai ratio: > 1 => the estimator ran under across the repo. */
  medianBiasFactor: number | null;
  underestimateCount: number;
  overestimateCount: number;
}

// --- Statistics -----------------------------------------------------------
// Local mirrors of the /stats response shapes. Web keeps its own copies of API response
// types rather than importing the @haive/shared barrel (which drags ioredis/dns into the
// bundle) — the same convention as OpenRouterModelEntry above. Keep in sync with
// modules/statistics/src/routes.ts.

/** Period-over-period comparison. `changeRatio` is null when there is no baseline to divide
 *  by — growth from zero has no ratio, and `direction` carries the meaning there. */
export interface StatsDelta {
  current: number;
  previous: number;
  changeRatio: number | null;
  direction: 'up' | 'down' | 'flat';
}

/** A ratio that carries its own sample count. `sufficient` false means the UI must show the
 *  shortfall rather than the percentage — on a young install most of these are noise. */
export interface SampledRatio {
  ratio: number | null;
  n: number;
  sufficient: boolean;
}

export type StatsTaskClass = 'work' | 'plan' | 'setup' | 'run' | 'other';

export interface StatsTaskClassCount {
  taskClass: StatsTaskClass;
  started: number;
  completed: number;
  abandoned: number;
}

/** Mirrors TaskProviderUsage in the api's tasks/_helpers.ts. */
/** Per-provider tokens, normalised the way the window total is — codex and gemini report input
 *  inclusive of the cached prefix, so a raw column cannot be compared across providers. */
export interface StatsNormalizedTokens {
  freshInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  cacheHitRatio: number | null;
  /** cacheCreation / (cacheCreation + cacheRead) — the share of cached traffic that was
   *  re-written rather than reused. NOT visible in cacheHitRatio, which leaves cache creation
   *  out of its denominator entirely. null when nothing was cached either way. */
  cacheWriteShare: number | null;
}

export interface StatsProviderUsage {
  provider: string;
  costBasis: string;
  invocations: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** The four raw columns above, normalised. Attached by /m/statistics/summary only — the task page's
   *  own copy of this shape does not carry it. */
  tokens: StatsNormalizedTokens;
  costUsd: number;
  notionalCostUsd: number;
  costSource: string;
  unpricedInvocations: number;
}

export interface StatsSummary {
  range: {
    from: string;
    to: string;
    timeZone: string;
    previousFrom: string;
    previousTo: string;
  };
  scope: {
    allUsers: boolean;
    repositoryId: string | null;
    cliProviderId: string | null;
    taskClass: StatsTaskClass | null;
  };
  costDisplay: CostDisplay;
  spend: {
    realUsd: number;
    /** The subscription counterfactual: what these runs WOULD have cost at list API rates.
     *  Never money spent, and never rendered in the same colour as realUsd. */
    notionalUsd: number;
    invocations: number;
    unpricedInvocations: number;
    abandonedRealUsd: number;
    abandonedNotionalUsd: number;
    byProvider: StatsProviderUsage[];
    realDelta: StatsDelta;
    notionalDelta: StatsDelta;
  };
  /** The window total, from the same `sumNormalizedTokens` that builds every per-provider row
   *  below — one named type rather than a second inline copy, which had already drifted. */
  tokens: StatsNormalizedTokens;
  time: {
    /** Σ invocation durations — compute consumed. Not a duration; never render it beside one. */
    agentMs: number;
    /** Union of the invocation intervals: clock during which at least one agent ran. */
    busyMs: number;
    calendarMs: number;
    islands: number;
    concurrency: number | null;
    dutyCycle: number | null;
    abandonedAgentMs: number;
    workMs: number;
    idleMs: number;
    userActiveMs: number;
    effortMs: number;
    agentDelta: StatsDelta;
    effortDelta: StatsDelta;
  };
  tasks: {
    started: number;
    startedAbandoned: number;
    completed: number;
    abandonedRatio: SampledRatio;
    byClass: StatsTaskClassCount[];
    startedDelta: StatsDelta;
    completedDelta: StatsDelta;
    withHumanEstimate: number;
    withAiEstimate: number;
  };
}

export interface StatsTimelineDay {
  /** Local calendar day, YYYY-MM-DD, in the requested zone. */
  bucket: string;
  realUsd: number;
  notionalUsd: number;
  invocations: number;
  agentMs: number;
  busyMs: number;
  tasksStarted: number;
  tasksCompleted: number;
  freshInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  throughput: StatsThroughput;
}

/** Output tokens per second, both ways: over model time (`api`, claude family and gemini) and over
 *  wall clock (`wall`, tool runs and sandbox included). A side with no runs has a null rate. */
export interface StatsThroughput {
  wall: { tps: number | null; n: number; sufficient: boolean };
  api: { tps: number | null; medianTps: number | null; n: number; sufficient: boolean };
}

export interface StatsTimeline {
  range: { from: string; to: string; timeZone: string };
  totals: {
    realUsd: number;
    notionalUsd: number;
    invocations: number;
    agentMs: number;
    busyMs: number;
    islands: number;
    concurrency: number | null;
    dutyCycle: number | null;
  };
  days: StatsTimelineDay[];
}

export interface StatsQueryParams {
  from?: string;
  to?: string;
  tz?: string;
  repositoryId?: string;
  cliProviderId?: string;
  taskClass?: StatsTaskClass;
  allUsers?: boolean;
}

function statsQueryString(params: StatsQueryParams): string {
  const qs = new URLSearchParams();
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.tz) qs.set('tz', params.tz);
  if (params.repositoryId) qs.set('repositoryId', params.repositoryId);
  if (params.cliProviderId) qs.set('cliProviderId', params.cliProviderId);
  if (params.taskClass) qs.set('taskClass', params.taskClass);
  if (params.allUsers) qs.set('allUsers', '1');
  const s = qs.toString();
  return s ? `?${s}` : '';
}

export async function getStatsSummary(
  api: HostApi,
  params: StatsQueryParams = {},
): Promise<StatsSummary> {
  return api.get<StatsSummary>(`/m/statistics/summary${statsQueryString(params)}`);
}

export async function getStatsTimeline(
  api: HostApi,
  params: StatsQueryParams = {},
): Promise<StatsTimeline> {
  return api.get<StatsTimeline>(`/m/statistics/timeline${statsQueryString(params)}`);
}

export interface StatsReliability {
  range: { from: string; to: string; timeZone: string };
  invocations: {
    total: number;
    /** Re-rolled work that was thrown away. Counted WITHOUT the attribution filter the other
     *  endpoints apply — superseded rows are the waste being measured. */
    superseded: number;
    killed: number;
    nonZeroExit: number;
    nearTimeout: number;
    withTimeout: number;
    identityDiffers: number;
    identityKnown: number;
    supersededRatio: SampledRatio;
    killedRatio: SampledRatio;
    nearTimeoutRatio: SampledRatio;
  };
  fatalClasses: Array<{ provider: string; fatalClass: string; count: number }>;
  steps: {
    total: number;
    failed: number;
    degraded: number;
    maxRound: number;
    failedRatio: SampledRatio;
    degradedRatio: SampledRatio;
    topFailing: Array<{ stepId: string; count: number }>;
  };
  events: Record<string, number>;
}

export interface StatsQuality {
  range: { from: string; to: string; timeZone: string };
  totals: {
    findings: number;
    blocking: number;
    recurring: number;
    tasksWithFindings: number;
    recurringRatio: SampledRatio;
  };
  bySeverity: Array<{ key: string; count: number }>;
  byDisposition: Array<{ key: string; count: number }>;
  byDimension: Array<{ key: string; count: number }>;
  byReviewer: Array<{
    reviewerId: string;
    count: number;
    blocking: number;
    /** How much of what this reviewer raised the refutation pass disproved. */
    refutedRatio: SampledRatio;
  }>;
  /** Why an `open` finding is not evidence a defect still stands. Rendered verbatim. */
  caveat: string;
}

export interface StatsEstimates {
  range: { from: string; to: string; timeZone: string };
  rows: EstimationAccuracyRow[];
  summary: EstimationAccuracySummary;
}

export async function getStatsReliability(
  api: HostApi,
  params: StatsQueryParams = {},
): Promise<StatsReliability> {
  return api.get<StatsReliability>(`/m/statistics/reliability${statsQueryString(params)}`);
}

export async function getStatsQuality(
  api: HostApi,
  params: StatsQueryParams = {},
): Promise<StatsQuality> {
  return api.get<StatsQuality>(`/m/statistics/quality${statsQueryString(params)}`);
}

export async function getStatsEstimates(
  api: HostApi,
  params: StatsQueryParams = {},
): Promise<StatsEstimates> {
  return api.get<StatsEstimates>(`/m/statistics/estimates${statsQueryString(params)}`);
}

/** One task's share of the window's agent time.
 *
 *  `agentMs` sums across rows to `StatsSummary.time.agentMs` exactly. `busyMs` does NOT and is
 *  not meant to — two tasks running the same minute each own that minute, while the window owns
 *  it once. */
export interface StatsTaskTimeRow {
  taskId: string;
  /** Null only if the task was deleted between the two server queries. */
  title: string | null;
  taskClass: StatsTaskClass | null;
  status: string | null;
  repositoryId: string | null;
  repositoryName: string | null;
  invocations: number;
  agentMs: number;
  busyMs: number;
  calendarMs: number;
  islands: number;
  concurrency: number | null;
  dutyCycle: number | null;
}

export interface StatsTaskTime {
  range: { from: string; to: string; timeZone: string };
  /** Ranked by `agentMs` desc, then capped. */
  rows: StatsTaskTimeRow[];
  /** Distinct tasks before the cap. */
  taskCount: number;
  truncated: boolean;
}

export async function getStatsTaskTime(
  api: HostApi,
  params: StatsQueryParams = {},
): Promise<StatsTaskTime> {
  return api.get<StatsTaskTime>(`/m/statistics/tasks${statsQueryString(params)}`);
}

export interface StatsPlanRepository {
  repositoryId: string;
  name: string;
  total: number;
  taskable: number;
  byStatus: Record<string, number>;
  /** Done nodes whose completion moment is actually recorded. */
  doneDated: number;
}

export interface StatsPlan {
  range: { from: string; to: string; timeZone: string };
  totals: {
    nodes: number;
    taskable: number;
    byStatus: Record<string, number>;
    /** done + not_applicable — a node written off is not outstanding work. */
    settled: number;
    remaining: number;
    /** Over the WHOLE plan, not the window: how much of the project already exists. */
    progressRatio: SampledRatio;
  };
  velocity: {
    /** Nodes that TRANSITIONED into done inside the window. A node created already done
     *  (from_repo mining describing existing code) is progress, not velocity. */
    completedInWindow: number;
    perWeek: number;
    /** Null rather than Infinity when nothing completed — "never" is arithmetic, not a
     *  forecast. */
    projectedWeeksRemaining: number | null;
    days: Array<{ bucket: string; completed: number }>;
  };
  coverage: { doneTotal: number; doneDated: number; doneUndated: number };
  repositories: StatsPlanRepository[];
}

export async function getStatsPlan(
  api: HostApi,
  params: StatsQueryParams = {},
): Promise<StatsPlan> {
  return api.get<StatsPlan>(`/m/statistics/plan${statsQueryString(params)}`);
}

/** One step id's share of the window. `agentMs` is summed and never unioned — the busy-span
 *  union is per task and does not decompose by step. */
export interface StatsStepRow {
  stepId: string;
  invocations: number;
  agentMs: number;
  realUsd: number;
  notionalUsd: number;
  unpricedInvocations: number;
  taskCount: number;
  /** This step's four token buckets, normalised per provider before being added. Read
   *  `cacheWriteShare` to see whether the step reuses its cached prefix or re-writes it. */
  tokens: StatsNormalizedTokens;
  /** `tokens.cacheWriteShare` with the invocation count to judge it by, so a 100% share off
   *  two runs renders as `n=2` rather than as a finding. */
  cacheWriteShareSampled: SampledRatio;
}

/** Which model ANSWERED, per the CLI's own output. `served` is null for the invocations that
 *  reported no model at all — codex and amp never do, by design — so it is rendered as "not
 *  recorded" and never folded into a model or into a zero. */
export interface StatsModelRow {
  served: string | null;
  invocations: number;
  agentMs: number;
  differs: number;
}

export interface StatsThroughputRow extends StatsThroughput {
  provider: string | null;
  served: string | null;
  invocations: number;
}

export interface StatsSteps {
  range: { from: string; to: string; timeZone: string };
  costDisplay: CostDisplay;
  rows: StatsStepRow[];
  stepCount: number;
  truncated: boolean;
  models: StatsModelRow[];
  throughput: StatsThroughputRow[];
}

export async function getStatsSteps(
  api: HostApi,
  params: StatsQueryParams = {},
): Promise<StatsSteps> {
  return api.get<StatsSteps>(`/m/statistics/steps${statsQueryString(params)}`);
}

/** One capped, ranked list: the rows shown, how many there were, and whether the cap cut any. */
export interface StatsCapped<T> {
  rows: T[];
  count: number;
  truncated: boolean;
}

/** How many of the window's runs the usage lists can speak for. `unrecorded` rows ended with no
 *  record at all, `inFlight` ones have not ended yet, and `unobservable` ones ran on a CLI whose
 *  output carries no tool events (amp, gemini, the sequential sub-agent script); only `observable`
 *  runs — `partial` ones being floors — enter any "not used" reading. */
export interface StatsToolUsageCoverage {
  total: number;
  recorded: number;
  observable: number;
  partial: number;
  unobservable: number;
  unrecorded: number;
  inFlight: number;
  withLoaded: number;
  byProvider: Array<{
    provider: string | null;
    total: number;
    recorded: number;
    observable: number;
    partial: number;
    unobservable: number;
    unrecorded: number;
    inFlight: number;
    withLoaded: number;
  }>;
  /** When the first assigned persona was recorded, whole history; null = never yet, which the
   *  page must say rather than render an empty list as "unused". */
  assignedRecordedSince: string | null;
}

export interface StatsToolUsage {
  range: { from: string; to: string; timeZone: string };
  scope: {
    repositoryId: string | null;
    cliProviderId: string | null;
    taskClass: StatsTaskClass | null;
    allUsers: boolean;
  };
  coverage: StatsToolUsageCoverage;
  personas: {
    assigned: StatsCapped<{ id: string; runs: number; tasks: number; share: SampledRatio }>;
    read: StatsCapped<{
      id: string;
      reads: number;
      runs: number;
      tasks: number;
      share: SampledRatio;
    }>;
  };
  skills: {
    invoked: StatsCapped<{
      id: string;
      calls: number;
      runs: number;
      tasks: number;
      share: SampledRatio;
    }>;
    read: StatsCapped<{
      id: string;
      reads: number;
      runs: number;
      tasks: number;
      share: SampledRatio;
    }>;
  };
  mcp: {
    /** Offered ∪ called per server; `haive` marks the ones Haive wires itself. */
    servers: StatsCapped<{
      server: string;
      haive: boolean;
      offeredRuns: number;
      calledRuns: number;
      calls: number;
      tasks: number;
    }>;
    tools: StatsCapped<{
      server: string;
      tool: string;
      calls: number;
      runs: number;
      tasks: number;
      share: SampledRatio;
    }>;
  };
  subagents: StatsCapped<{ type: string; calls: number; runs: number; tasks: number }>;
  nativeTools: StatsCapped<{ tool: string; calls: number; runs: number }>;
  /** Null without a repository facet. */
  unused: StatsUnusedReport | null;
}

/** `haive`: on disk and Haive's (an artifact row or a template vouches for it), never a purge
 *  candidate. `unmanaged`: on disk and nobody's — the candidates. `cli-builtin`: listed by the
 *  CLI but not a file in the repository — a built-in, or a file removed since the run. */
export type StatsUnusedToolingClass = 'haive' | 'unmanaged' | 'cli-builtin';

export interface StatsUnusedRow {
  kind: 'agent' | 'skill' | 'mcp';
  id: string;
  class: StatsUnusedToolingClass;
  /** Repository-relative definition paths; empty for an MCP server or a CLI built-in. */
  paths: string[];
  /** Last use in the caller's WHOLE history; null = never since install. */
  lastSeenAt: string | null;
}

export type StatsUnusedReport =
  | {
      available: false;
      reason: 'no-repository' | 'no-path' | 'unreadable' | 'scan-unavailable';
    }
  | {
      available: true;
      repositoryId: string;
      scannedAt: string;
      dirsScanned: string[];
      inventoryTruncated: boolean;
      skippedLinks: number;
      installedCount: number;
      window: { observableRuns: number };
      history: { observableRuns: number; observableSince: string | null };
      /** Empty when the window has no observable run — nothing can then be called unused. */
      rows: StatsUnusedRow[];
    };

export async function getStatsToolUsage(
  api: HostApi,
  params: StatsQueryParams = {},
): Promise<StatsToolUsage> {
  return api.get<StatsToolUsage>(`/m/statistics/tool-usage${statsQueryString(params)}`);
}
