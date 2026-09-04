import { relative, resolve } from 'node:path';
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  CLI_DISPATCH_STEP_IDS,
  CLI_DISPATCH_STEPS,
  COST_METERED_PROVIDERS,
  resolveCostBasis,
  MODEL_HEALTH_STEP_IDS,
  SKIPPABLE_STEP_IDS,
  STEP_CLI_ROLES,
  STEP_MINING_SEATS,
  type AuthMode,
  type CliProviderName,
  type CliRoleDescriptor,
  type CliTokenUsage,
} from '@haive/shared';
import { getDb } from '../../db.js';
import { HttpError } from '../../context.js';

export const MAX_FILE_CONTENT_BYTES = 512 * 1024;
export const TEXT_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.json',
  '.yml',
  '.yaml',
  '.toml',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.php',
  '.sh',
  '.html',
  '.css',
  '.scss',
  '.sql',
  '.xml',
  '.env',
  '.lock',
  '.ini',
  '.conf',
  '.gitignore',
  '.dockerignore',
  '.editorconfig',
]);

export const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  '.ico',
  '.avif',
]);

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
};

/** Best-effort MIME for the raw-bytes endpoint. Images get a precise type so
 *  the browser previews them; everything else is octet-stream (forces a
 *  download rather than rendering untrusted bytes inline). */
export function mimeForExtension(ext: string): string {
  return IMAGE_MIME_TYPES[ext] ?? 'application/octet-stream';
}

/** The explicit per-step CLI preference rows, keyed by step. Loaded once for a set of steps
 *  and shared by the two readers of the same rules: the step enricher below (one task, every
 *  step) and the listing's provider resolution (many tasks, one current step each), which
 *  would otherwise need an enricher call — and its queries — per row of a 3s-polled page. */
interface StepCliPrefRows {
  byStep: Map<string, string>;
  byStepEffort: Map<string, string | null>;
  roleByStep: Map<string, Map<string, string>>;
  roleEffortByStep: Map<string, Map<string, string | null>>;
}

function emptyStepCliPrefRows(): StepCliPrefRows {
  return {
    byStep: new Map(),
    byStepEffort: new Map(),
    roleByStep: new Map(),
    roleEffortByStep: new Map(),
  };
}

async function loadStepCliPrefRows(
  db: ReturnType<typeof getDb>,
  userId: string,
  stepIds: string[],
): Promise<StepCliPrefRows> {
  const out = emptyStepCliPrefRows();
  if (stepIds.length === 0) return out;
  const prefs = await db
    .select()
    .from(schema.userStepCliPreferences)
    .where(
      and(
        eq(schema.userStepCliPreferences.userId, userId),
        inArray(schema.userStepCliPreferences.stepId, stepIds),
        // Only explicit per-step overrides surface in the UI; legacy
        // auto-recorded rows (explicit=false) fall back to the task default.
        eq(schema.userStepCliPreferences.explicit, true),
      ),
    );
  for (const p of prefs) {
    out.byStep.set(p.stepId, p.cliProviderId);
    out.byStepEffort.set(p.stepId, p.effortLevel);
  }

  // Per-role prefs, only for steps that declare CLI roles or fan-out seats. Both kinds
  // live in the same (user, step, role) table, so one query serves both.
  const roleStepIds = stepIds.filter((sid) => STEP_CLI_ROLES[sid] ?? STEP_MINING_SEATS[sid]);
  if (roleStepIds.length > 0) {
    const rolePrefs = await db
      .select()
      .from(schema.userStepCliRolePreferences)
      .where(
        and(
          eq(schema.userStepCliRolePreferences.userId, userId),
          inArray(schema.userStepCliRolePreferences.stepId, roleStepIds),
          eq(schema.userStepCliRolePreferences.explicit, true),
        ),
      );
    for (const p of rolePrefs) {
      const m = out.roleByStep.get(p.stepId) ?? new Map<string, string>();
      m.set(p.role, p.cliProviderId);
      out.roleByStep.set(p.stepId, m);
      const me = out.roleEffortByStep.get(p.stepId) ?? new Map<string, string | null>();
      me.set(p.role, p.effortLevel);
      out.roleEffortByStep.set(p.stepId, me);
    }
  }
  return out;
}

/** `task_step_cli_touched` as taskId -> stepId -> roles. Loaded only for tasks that set
 *  ignore_saved_step_clis: under that flag a saved pref is honored only where the user
 *  explicitly (re)set it WITHIN this task, and everything else falls back to the task
 *  provider. */
async function loadTouchedRoles(
  db: ReturnType<typeof getDb>,
  taskIds: string[],
): Promise<Map<string, Map<string, Set<string>>>> {
  const out = new Map<string, Map<string, Set<string>>>();
  if (taskIds.length === 0) return out;
  const touched = await db
    .select()
    .from(schema.taskStepCliTouched)
    .where(inArray(schema.taskStepCliTouched.taskId, taskIds));
  for (const t of touched) {
    const byStep = out.get(t.taskId) ?? new Map<string, Set<string>>();
    const set = byStep.get(t.stepId) ?? new Set<string>();
    set.add(t.role);
    byStep.set(t.stepId, set);
    out.set(t.taskId, byStep);
  }
  return out;
}

export async function enrichStepsWithCliPreferences<T extends { stepId: string }>(
  db: ReturnType<typeof getDb>,
  userId: string,
  steps: T[],
  taskId: string,
  ignoreSaved = false,
): Promise<
  (T & {
    preferredCliProviderId: string | null;
    /** Per-step effort override (null = use the provider's configured effort);
     *  drives the per-step effort dropdown's selected value. */
    preferredEffortLevel: string | null;
    /** Present only for multi-CLI steps (STEP_CLI_ROLES); drives the per-role
     *  dropdowns and their currently-selected providers in the UI. */
    cliRoles?: readonly CliRoleDescriptor[];
    cliRoleProviders?: Record<string, string | null>;
    cliRoleEfforts?: Record<string, string | null>;
    /** Present only for fan-out steps (STEP_MINING_SEATS); drives the per-seat
     *  dropdowns. Deliberately a SEPARATE field from cliRoles: that one's presence and
     *  length carry loop semantics (loopPassesPerRound, isResumableStep), which a
     *  parallel fan-out must not inherit. */
    miningSeats?: readonly CliRoleDescriptor[];
    miningSeatProviders?: Record<string, string | null>;
    miningSeatEfforts?: Record<string, string | null>;
  })[]
> {
  const stepIds = [...new Set(steps.map((s) => s.stepId))];
  const { byStep, byStepEffort, roleByStep, roleEffortByStep } = await loadStepCliPrefRows(
    db,
    userId,
    stepIds,
  );
  // When the task opted out of saved per-step prefs (ignore_saved_step_clis), gate each
  // surfaced pref by its (step, role) marker; untouched steps fall back to the task provider.
  const touchedByStep =
    ignoreSaved && stepIds.length > 0
      ? ((await loadTouchedRoles(db, [taskId])).get(taskId) ?? new Map<string, Set<string>>())
      : new Map<string, Set<string>>();
  return steps.map((s) => {
    const roles = STEP_CLI_ROLES[s.stepId];
    const seats = STEP_MINING_SEATS[s.stepId];
    const roleProviders = roleByStep.get(s.stepId) ?? new Map<string, string>();
    const roleEfforts = roleEffortByStep.get(s.stepId) ?? new Map<string, string | null>();
    const touchedRoles = touchedByStep.get(s.stepId);
    // Under ignoreSaved a saved pref surfaces only where a marker exists for that
    // exact role; gating the 'default' read by its own marker stops a flagged
    // multi-role step from leaking a pre-existing default pref via fallthrough.
    const honor = (role: string, value: string | null): string | null =>
      !ignoreSaved || touchedRoles?.has(role) ? value : null;
    return {
      ...s,
      preferredCliProviderId: honor('default', byStep.get(s.stepId) ?? null),
      preferredEffortLevel: honor('default', byStepEffort.get(s.stepId) ?? null),
      ...(roles
        ? {
            cliRoles: roles,
            cliRoleProviders: Object.fromEntries(
              roles.map((r) => [r.id, honor(r.id, roleProviders.get(r.id) ?? null)]),
            ),
            cliRoleEfforts: Object.fromEntries(
              roles.map((r) => [r.id, honor(r.id, roleEfforts.get(r.id) ?? null)]),
            ),
          }
        : {}),
      ...(seats
        ? {
            miningSeats: seats,
            miningSeatProviders: Object.fromEntries(
              seats.map((r) => [r.id, honor(r.id, roleProviders.get(r.id) ?? null)]),
            ),
            miningSeatEfforts: Object.fromEntries(
              seats.map((r) => [r.id, honor(r.id, roleEfforts.get(r.id) ?? null)]),
            ),
          }
        : {}),
    };
  });
}

/** Every CLI provider each task's CURRENT step will actually spend, keyed by task id.
 *
 *  `tasks.cli_provider_id` is the fallback of LAST RESORT, not the answer: an explicit
 *  per-step preference — and, on a fan-out/multi-role step, a per-seat one — overrides it,
 *  exactly as the worker's `resolvePreferredCli` resolves it at dispatch. The listing's usage
 *  strip is scoped to the rows on screen and had only the task column to key on, so it named
 *  an allowance the tasks were not spending: MEASURED on the dev install, two tasks whose task
 *  provider was an ollama fixture had run 233 codex and 14 claude-code invocations and zero
 *  ollama ones, and the strip therefore drew nothing at all while both subscriptions had live
 *  meters.
 *
 *  Same fall-through, `enabled` filter and dedup as web's `stepCliProviderIds`, which does
 *  this on the task DETAIL page from the already-enriched step objects. This is the batched
 *  server-side twin for listing rows, which carry no steps: three queries for a whole page.
 *
 *  A task with no current step (or whose step has no pref) yields just its own provider, i.e.
 *  what the listing already showed. The result is never empty-by-accident: an empty array
 *  means the task names no usable provider at all. */
export async function resolveCurrentStepCliProviderIds(
  db: ReturnType<typeof getDb>,
  userId: string,
  tasks: readonly {
    id: string;
    currentStepId: string | null;
    cliProviderId: string | null;
    ignoreSavedStepClis: boolean;
  }[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (tasks.length === 0) return out;
  const stepIds = [...new Set(tasks.map((t) => t.currentStepId).filter((s): s is string => !!s))];
  // A pref pointing at a deleted or disabled provider is ignored, exactly as the worker
  // ignores it — the step runs on the fallback, so the fallback is what the strip must meter.
  const enabledRows = await db
    .select({ id: schema.cliProviders.id })
    .from(schema.cliProviders)
    .where(and(eq(schema.cliProviders.userId, userId), eq(schema.cliProviders.enabled, true)));
  const enabled = new Set(enabledRows.map((p) => p.id));
  const prefs = await loadStepCliPrefRows(db, userId, stepIds);
  const touched = await loadTouchedRoles(
    db,
    tasks.filter((t) => t.ignoreSavedStepClis).map((t) => t.id),
  );

  for (const task of tasks) {
    const stepId = task.currentStepId;
    const touchedRoles = stepId ? touched.get(task.id)?.get(stepId) : undefined;
    const honor = (role: string, value: string | null): string | null =>
      !task.ignoreSavedStepClis || touchedRoles?.has(role) ? value : null;
    const usable = (id: string | null): string | null => (id && enabled.has(id) ? id : null);
    const roleProviders =
      (stepId ? prefs.roleByStep.get(stepId) : undefined) ?? new Map<string, string>();
    const stepDefault =
      usable(stepId ? honor('default', prefs.byStep.get(stepId) ?? null) : null) ??
      task.cliProviderId ??
      null;

    const ids: string[] = [];
    const push = (id: string | null) => {
      if (id && !ids.includes(id)) ids.push(id);
    };
    push(stepDefault);
    // The step default is kept even when every seat is set: it is the fallthrough for a seat
    // the user never touched, and it runs a fan-out step's summary pass.
    for (const seat of (stepId ? STEP_MINING_SEATS[stepId] : undefined) ?? []) {
      push(usable(honor(seat.id, roleProviders.get(seat.id) ?? null)) ?? stepDefault);
    }
    for (const role of (stepId ? STEP_CLI_ROLES[stepId] : undefined) ?? []) {
      push(usable(honor(role.id, roleProviders.get(role.id) ?? null)) ?? stepDefault);
    }
    out.set(task.id, ids);
  }
  return out;
}

export async function findActiveCliInvocation(
  db: ReturnType<typeof getDb>,
  taskId: string,
): Promise<{ id: string; taskStepId: string | null; steerable: boolean } | null> {
  const rows = await db
    .select({
      id: schema.cliInvocations.id,
      taskStepId: schema.cliInvocations.taskStepId,
      steerable: schema.cliInvocations.steerable,
    })
    .from(schema.cliInvocations)
    .where(
      and(
        eq(schema.cliInvocations.taskId, taskId),
        isNull(schema.cliInvocations.endedAt),
        isNull(schema.cliInvocations.supersededAt),
      ),
    )
    .orderBy(desc(schema.cliInvocations.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** `task_steps.id` of every step in `taskIds` that is WHOLLY parked on the agent gate: it holds
 *  an invocation enqueued but not started (`started_at IS NULL`, not ended, not superseded) and
 *  none of its invocations is actually running — a job sitting in the cli-exec queue because
 *  MAX_PARALLEL_AGENTS is saturated or the per-task cap deferred it. Feeds deriveSlotWait's
 *  agent-slot branch.
 *
 *  The "none running" half is what makes a FAN-OUT step honest. A mining/DAG step dispatches N
 *  invocations at once and cli-exec runs `concurrency` of them, so N > concurrency leaves
 *  siblings enqueued for the whole step — on the queued-row test alone every such step reads as
 *  parked while its agents stream output, which drops the task out of the "Running" listing and
 *  badges it "waiting: agent slot". A step with one live agent is working, not queued.
 *
 *  Two queries per page rather than a correlated NOT EXISTS: same round-trip cost in practice
 *  and the set arithmetic stays readable. Empty set when called with no ids. */
export async function findQueuedInvocationStepIds(
  db: ReturnType<typeof getDb>,
  taskIds: string[],
): Promise<Set<string>> {
  if (taskIds.length === 0) return new Set();
  const stepIdsWhere = (startedAt: ReturnType<typeof isNull>) =>
    db
      .selectDistinct({ taskStepId: schema.cliInvocations.taskStepId })
      .from(schema.cliInvocations)
      .where(
        and(
          inArray(schema.cliInvocations.taskId, taskIds),
          startedAt,
          isNull(schema.cliInvocations.endedAt),
          isNull(schema.cliInvocations.supersededAt),
        ),
      );
  const [queued, running] = await Promise.all([
    stepIdsWhere(isNull(schema.cliInvocations.startedAt)),
    stepIdsWhere(isNotNull(schema.cliInvocations.startedAt)),
  ]);
  const busy = new Set(running.map((r) => r.taskStepId));
  return new Set(
    queued.map((r) => r.taskStepId).filter((id): id is string => id !== null && !busy.has(id)),
  );
}

/** SQL predicate for the `waiting_slot` listing filter: the task's CURRENT step is parked
 *  waiting for capacity. Mirrors deriveSlotWait rule-for-rule as fed by
 *  findQueuedInvocationStepIds (runtime park = pending + a live wait marker; agent park =
 *  waiting_cli OR running, plus an unstarted invocation and NOTHING running — see that helper
 *  for why a fan-out step needs the second half). `running` belongs here because the mining /
 *  DAG fan-out barrier reports `waiting_cli` upward without writing it to the step row, so a
 *  step blocked on N queued agents keeps `running` and a status-only test listed it as
 *  working. Kept in lockstep with AGENT_PARK_STATUSES in @haive/shared's deriveSlotWait —
 *  when these two disagree the badge and the filter contradict each other. Scoped to
 *  current_step_id/current_round for the same reason the helper is — a stale marker on an
 *  older round must not make a working task look queued. Caller adds the
 *  `tasks.status = 'running'` term, so this stays a pure "is the current step parked" test and
 *  the count query and the page query can share it. */
export function currentStepParkedSql() {
  return sql`EXISTS (
    SELECT 1 FROM ${schema.taskSteps} ts
    WHERE ts.task_id = ${schema.tasks.id}
      AND ts.step_id = ${schema.tasks.currentStepId}
      AND ts.round = ${schema.tasks.currentRound}
      AND (
        (ts.status = 'pending' AND ts.waiting_started_at IS NOT NULL)
        OR (ts.status IN ('waiting_cli', 'running') AND EXISTS (
          SELECT 1 FROM ${schema.cliInvocations} ci
          WHERE ci.task_step_id = ts.id
            AND ci.started_at IS NULL
            AND ci.ended_at IS NULL
            AND ci.superseded_at IS NULL)
          AND NOT EXISTS (
          SELECT 1 FROM ${schema.cliInvocations} ci
          WHERE ci.task_step_id = ts.id
            AND ci.started_at IS NOT NULL
            AND ci.ended_at IS NULL
            AND ci.superseded_at IS NULL))
      ))`;
}

/** The one place that decides which dollars are REAL, for every rollup.
 *
 *  Two eras, and the row itself says which one it belongs to:
 *
 *  - `cli_invocations.cost` present — the cost pass ran. It already decided
 *    `billable` at write time, where the provider, its auth mode, the answering model
 *    and the price source were all in hand, so the rollup just honors that flag. This
 *    is what lets zai/muse/openrouter contribute REAL money (computed from their own
 *    per-model rates) while their CLI-reported total, which the claude binary prices
 *    against Anthropic's table, stays out of it.
 *
 *  - `cost` NULL — a row written before the column existed, or one whose cost pass
 *    failed. Falls back to exactly the previous rule: metered provider on api_key
 *    auth only. Keeping this branch is what preserves the real spend already recorded
 *    (grok's api_key invocations) instead of zeroing history.
 *
 *  A CASE on the PRESENCE of the snapshot, never a `coalesce` on its value: a snapshot
 *  that deliberately prices a row at zero (a subscription plan, an unpriced model)
 *  would otherwise fall through and resurrect the legacy number for that row. */
function realCostUsdSql() {
  const cost = schema.cliInvocations.cost;
  const tu = schema.cliInvocations.tokenUsage;
  return sql<number>`coalesce(sum(
    case
      when ${cost} is not null then
        (case when ${cost} ->> 'billable' = 'true'
              then coalesce((${cost} ->> 'costUsd')::numeric, 0)
              else 0 end)
      when ${schema.cliProviders.name}::text in ${COST_METERED_PROVIDERS}
           and ${schema.cliProviders.authMode} = 'api_key' then
        coalesce((${tu} ->> 'costUsd')::numeric, 0)
      else 0
    end
  ), 0)::double precision`;
}

/** The mirror of realCostUsdSql: what the invocations that are NOT billed per token
 *  WOULD have cost at list API rates. Never summed into real spend and never shown in
 *  the same colour — it is the counterfactual that says what the subscriptions save,
 *  which is exactly the number a flat plan hides.
 *
 *  Same two eras as the real rule, each restricted to the half that one throws away:
 *
 *  - snapshot present — `billable = false`, minus `source = 'none'`. A `none` row's
 *    costUsd is 0 by construction (unpriced model, partial computation), and a 0 here
 *    would read as "this run was free" rather than "we could not price it".
 *
 *  - `cost` NULL (legacy) — a metered provider on SUBSCRIPTION auth, the exact
 *    complement of the legacy real rule's api_key filter. Metered ONLY, because just a
 *    CLI that prices its own backend reports a usable number: the claude binary applies
 *    Anthropic's table to the zai/muse/openrouter/ollama wrappers too, and that total is
 *    fiction (5,968 USD of it against local ollama tokens on this install alone). codex
 *    and gemini report no cost at all and contribute 0, which is the honest answer.
 *
 *  Priced at whatever rate applied when the run happened, which is the right reading of
 *  "what we would have paid" rather than "what those tokens would cost today". */
function notionalCostUsdSql() {
  const cost = schema.cliInvocations.cost;
  const tu = schema.cliInvocations.tokenUsage;
  return sql<number>`coalesce(sum(
    case
      when ${cost} is not null then
        (case when ${cost} ->> 'billable' = 'false' and ${cost} ->> 'source' <> 'none'
              then coalesce((${cost} ->> 'costUsd')::numeric, 0)
              else 0 end)
      when ${schema.cliProviders.name}::text in ${COST_METERED_PROVIDERS}
           and ${schema.cliProviders.authMode} = 'subscription' then
        coalesce((${tu} ->> 'costUsd')::numeric, 0)
      else 0
    end
  ), 0)::double precision`;
}

/** Annotate each step with the count of non-superseded CLI invocations attached
 *  to it AND the summed token usage across those invocations. The count drives
 *  the inline-terminal toggle (hidden on steps that never spawned a CLI); the
 *  token sum is surfaced per step and aggregated into the task total client-side.
 *  Uses the same `supersededAt IS NULL` filter as the per-step invocation panel,
 *  so a step's token total reconciles with the invocations shown there. Single
 *  GROUP BY keeps it O(1) round-trips regardless of step count.
 *
 *  Counters stay on `task_step_id` ("did this step run a CLI"); the token/cost sums also
 *  fold in the step's summary pass via `summary_for_step_id` ("what did this step cost"). */
export async function enrichStepsWithCliStats<T extends { id: string }>(
  db: ReturnType<typeof getDb>,
  taskId: string,
  steps: T[],
): Promise<
  (T & { cliInvocationCount: number; attemptCount: number; tokenUsage: CliTokenUsage | null })[]
> {
  if (steps.length === 0) return [];
  const tu = schema.cliInvocations.tokenUsage;
  // Counting the summary row would give a finished step a terminal toggle it has no
  // invocation for, and read as an auto-retry — so the counters below stay on task_step_id.
  const attributedStepId = sql<
    string | null
  >`coalesce(${schema.cliInvocations.taskStepId}, ${schema.cliInvocations.summaryForStepId})`;
  const ownInvocation = sql`${schema.cliInvocations.taskStepId} is not null`;
  const rows = await db
    .select({
      stepId: attributedStepId,
      count: sql<number>`count(*) filter (where ${ownInvocation})::int`,
      // LLM run attempts: exclude the per-step fan-outs (agent_mining review agents
      // and dag_parallel DAG coders/reviewers) -- they run N concurrent per step by
      // design and aren't retries. >1 on a non-loop step => an auto-retry happened.
      attemptCount: sql<number>`count(*) filter (where ${ownInvocation} and ${schema.cliInvocations.mode} not in ('agent_mining', 'dag_parallel'))::int`,
      inputTokens: sql<number>`coalesce(sum((${tu} ->> 'inputTokens')::numeric), 0)::int`,
      outputTokens: sql<number>`coalesce(sum((${tu} ->> 'outputTokens')::numeric), 0)::int`,
      totalTokens: sql<number>`coalesce(sum((${tu} ->> 'totalTokens')::numeric), 0)::int`,
      cacheReadTokens: sql<number>`coalesce(sum((${tu} ->> 'cacheReadTokens')::numeric), 0)::int`,
      cacheCreationTokens: sql<number>`coalesce(sum((${tu} ->> 'cacheCreationTokens')::numeric), 0)::int`,
      // Real dollars, decided by the shared rule (snapshot when the cost pass ran,
      // legacy metered + api_key filter otherwise).
      costUsd: realCostUsdSql(),
    })
    .from(schema.cliInvocations)
    .leftJoin(schema.cliProviders, eq(schema.cliProviders.id, schema.cliInvocations.cliProviderId))
    .where(
      and(eq(schema.cliInvocations.taskId, taskId), isNull(schema.cliInvocations.supersededAt)),
    )
    .groupBy(attributedStepId);

  const byStep = new Map<
    string,
    { count: number; attemptCount: number; tokenUsage: CliTokenUsage | null }
  >();
  for (const row of rows) {
    if (!row.stepId) continue;
    const inputTokens = Number(row.inputTokens) || 0;
    const outputTokens = Number(row.outputTokens) || 0;
    const totalTokens = Number(row.totalTokens) || 0;
    const cacheReadTokens = Number(row.cacheReadTokens) || 0;
    const cacheCreationTokens = Number(row.cacheCreationTokens) || 0;
    const costUsd = Number(row.costUsd) || 0;
    const hasTokens = totalTokens > 0 || inputTokens > 0 || outputTokens > 0 || costUsd > 0;
    const tokenUsage: CliTokenUsage | null = hasTokens
      ? {
          inputTokens,
          outputTokens,
          totalTokens,
          ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
          ...(cacheCreationTokens > 0 ? { cacheCreationTokens } : {}),
          ...(costUsd > 0 ? { costUsd } : {}),
        }
      : null;
    byStep.set(row.stepId, {
      count: row.count,
      attemptCount: Number(row.attemptCount) || 0,
      tokenUsage,
    });
  }
  return steps.map((s) => {
    const stat = byStep.get(s.id);
    return {
      ...s,
      cliInvocationCount: stat?.count ?? 0,
      attemptCount: stat?.attemptCount ?? 0,
      tokenUsage: stat?.tokenUsage ?? null,
    };
  });
}

/** Sum each task's CLI token usage for the listing (GET /tasks). One GROUP BY
 *  over the whole page keeps it a single round-trip regardless of task count.
 *  Uses the same `supersededAt IS NULL` filter as the per-step stats, plus the same
 *  attribution rule, so a task's list total equals the sum of its per-step token
 *  badges on the detail page (which folds step totals and skips unattributed rows).
 *  Tasks with no token-bearing invocation are simply absent from the map.
 *
 *  The rule is `task_step_id IS NOT NULL OR summary_for_step_id IS NOT NULL` rather than no
 *  filter: a summary row predating that column carries neither, so it stays out of BOTH
 *  sides and the two totals keep matching on old tasks without a backfill. */
export async function sumTaskTokens(
  db: ReturnType<typeof getDb>,
  taskIds: string[],
): Promise<Map<string, CliTokenUsage>> {
  const out = new Map<string, CliTokenUsage>();
  if (taskIds.length === 0) return out;
  const tu = schema.cliInvocations.tokenUsage;
  const rows = await db
    .select({
      taskId: schema.cliInvocations.taskId,
      inputTokens: sql<number>`coalesce(sum((${tu} ->> 'inputTokens')::numeric), 0)::int`,
      outputTokens: sql<number>`coalesce(sum((${tu} ->> 'outputTokens')::numeric), 0)::int`,
      totalTokens: sql<number>`coalesce(sum((${tu} ->> 'totalTokens')::numeric), 0)::int`,
      cacheReadTokens: sql<number>`coalesce(sum((${tu} ->> 'cacheReadTokens')::numeric), 0)::int`,
      cacheCreationTokens: sql<number>`coalesce(sum((${tu} ->> 'cacheCreationTokens')::numeric), 0)::int`,
      // Real dollars, decided by the shared rule (snapshot when the cost pass ran,
      // legacy metered + api_key filter otherwise).
      costUsd: realCostUsdSql(),
    })
    .from(schema.cliInvocations)
    .leftJoin(schema.cliProviders, eq(schema.cliProviders.id, schema.cliInvocations.cliProviderId))
    .where(
      and(
        inArray(schema.cliInvocations.taskId, taskIds),
        isNull(schema.cliInvocations.supersededAt),
        or(
          isNotNull(schema.cliInvocations.taskStepId),
          isNotNull(schema.cliInvocations.summaryForStepId),
        ),
      ),
    )
    .groupBy(schema.cliInvocations.taskId);
  for (const row of rows) {
    const inputTokens = Number(row.inputTokens) || 0;
    const outputTokens = Number(row.outputTokens) || 0;
    const totalTokens = Number(row.totalTokens) || 0;
    const cacheReadTokens = Number(row.cacheReadTokens) || 0;
    const cacheCreationTokens = Number(row.cacheCreationTokens) || 0;
    const costUsd = Number(row.costUsd) || 0;
    const hasTokens = totalTokens > 0 || inputTokens > 0 || outputTokens > 0 || costUsd > 0;
    if (!hasTokens) continue;
    out.set(row.taskId, {
      inputTokens,
      outputTokens,
      totalTokens,
      ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
      ...(cacheCreationTokens > 0 ? { cacheCreationTokens } : {}),
      ...(costUsd > 0 ? { costUsd } : {}),
    });
  }
  return out;
}

export interface TaskProviderUsage {
  /** CliProviderName of the invocations. */
  provider: string;
  /** CliProviderMetadata.costBasis — 'metered' | 'subscription' | 'local' | 'estimate'. */
  costBasis: string;
  invocations: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Real dollars, by the shared rule in realCostUsdSql. */
  costUsd: number;
  /** What this provider's non-billed-per-token invocations WOULD have cost at list API
   *  rates (see notionalCostUsdSql). Informational only: never added to costUsd, and 0
   *  when nothing in the group could be priced. */
  notionalCostUsd: number;
  /** Where those dollars came from, so the UI can label the number instead of leaving
   *  the reader to guess whether a CLI reported it or Haive priced it. `mixed` when
   *  one provider's invocations in this task used more than one source — normal for a
   *  task that ran before and after a price row appeared. */
  costSource: 'reported' | 'computed' | 'manual' | 'none' | 'mixed' | 'legacy';
  /** Invocations this provider ran that carry tokens but no usable price. The UI shows
   *  this rather than silently understating the total. */
  unpricedInvocations: number;
}

export interface CostDisplay {
  /** The configured display currency. Always what the UI should format in. */
  currency: string;
  /** USD per one unit of `currency`. Divide a USD cost by this. 1 for USD. */
  usdPerUnit: number;
  /** The rate's own date, so the UI can say what it converted at. */
  rateDate: string | null;
  /** True when no rate existed on or before the task's date and the EARLIEST known
   *  rate was used instead. Unavoidable for tasks that predate FX collection, and it
   *  must be shown rather than hidden — an approximate conversion presented as exact
   *  is the same class of error as a guessed price. */
  approximate: boolean;
}

/** Resolve the FX rate a task's costs should be displayed at.
 *
 *  Dated on the TASK, not on each invocation: the point of dating is reproducibility —
 *  re-rendering a finished task next month must yield the same figure — and a task's
 *  completion date is fixed while the per-invocation refinement would move a total by
 *  well under the rounding the UI shows. One lookup per task response rather than a
 *  join across every row.
 *
 *  Lookup is "the most recent rate on or before that date", which is also the correct
 *  reading of a feed that skips weekends and holidays. Falls back to the earliest rate
 *  on record (flagged approximate) for a task older than FX collection, and finally to
 *  USD 1:1 when no rate exists at all — so a missing feed degrades to showing USD
 *  rather than to showing nothing. */
export async function resolveCostDisplay(
  db: ReturnType<typeof getDb>,
  currency: string,
  on: Date | null,
): Promise<CostDisplay> {
  if (currency === 'USD') {
    return { currency: 'USD', usdPerUnit: 1, rateDate: null, approximate: false };
  }
  const onDate = (on ?? new Date()).toISOString().slice(0, 10);
  const [onOrBefore] = await db
    .select()
    .from(schema.fxRates)
    .where(and(eq(schema.fxRates.currency, currency), sql`${schema.fxRates.rateDate} <= ${onDate}`))
    .orderBy(desc(schema.fxRates.rateDate))
    .limit(1);
  if (onOrBefore) {
    return {
      currency,
      usdPerUnit: onOrBefore.usdPerUnit,
      rateDate: onOrBefore.rateDate,
      approximate: false,
    };
  }
  const [earliest] = await db
    .select()
    .from(schema.fxRates)
    .where(eq(schema.fxRates.currency, currency))
    .orderBy(schema.fxRates.rateDate)
    .limit(1);
  if (earliest) {
    return {
      currency,
      usdPerUnit: earliest.usdPerUnit,
      rateDate: earliest.rateDate,
      approximate: true,
    };
  }
  return { currency: 'USD', usdPerUnit: 1, rateDate: null, approximate: false };
}

/** Collapse the distinct per-invocation cost sources in one group into one label.
 *  An empty set means every row predates the cost pass ('legacy'); more than one
 *  distinct source means the group genuinely mixes them. */
function summarizeCostSources(sources: unknown): TaskProviderUsage['costSource'] {
  const list = Array.isArray(sources)
    ? sources.filter((s): s is string => typeof s === 'string')
    : [];
  if (list.length === 0) return 'legacy';
  if (list.length > 1) return 'mixed';
  const only = list[0];
  return only === 'reported' || only === 'computed' || only === 'manual' || only === 'none'
    ? only
    : 'legacy';
}

/** Per-provider token/cost split for a task's detail page. Tokens sum across ALL
 *  providers (always real); costUsd is whatever the shared rule counts as real, which
 *  since the pricing feature includes computed dollars for the claude-binary wrappers
 *  whose own reported total is Anthropic fiction. Ordered by token volume (the primary
 *  metric). Same superseded/attribution filter as the other aggregations, so a task's summary
 *  passes appear as their own provider row with their own cost. */
export async function sumTaskProviderBreakdown(
  db: ReturnType<typeof getDb>,
  taskId: string,
): Promise<TaskProviderUsage[]> {
  const tu = schema.cliInvocations.tokenUsage;
  const rows = await db
    .select({
      provider: schema.cliProviders.name,
      authMode: schema.cliProviders.authMode,
      invocations: sql<number>`count(*)::int`,
      inputTokens: sql<number>`coalesce(sum((${tu} ->> 'inputTokens')::numeric), 0)::int`,
      outputTokens: sql<number>`coalesce(sum((${tu} ->> 'outputTokens')::numeric), 0)::int`,
      cacheReadTokens: sql<number>`coalesce(sum((${tu} ->> 'cacheReadTokens')::numeric), 0)::int`,
      cacheCreationTokens: sql<number>`coalesce(sum((${tu} ->> 'cacheCreationTokens')::numeric), 0)::int`,
      costUsd: realCostUsdSql(),
      // The subscription counterfactual, kept beside the real number rather than folded
      // into it — the UI shows it greyed and clearly labelled as not-spent.
      notionalCostUsd: notionalCostUsdSql(),
      // Distinct non-null sources present in this group, so the caller can label the
      // number ('mixed' when a provider's invocations disagree). Legacy rows report no
      // source at all and fall out as an empty array.
      costSources: sql<
        string[]
      >`coalesce(array_agg(distinct ${schema.cliInvocations.cost} ->> 'source') filter (where ${schema.cliInvocations.cost} is not null), '{}')`,
      unpricedInvocations: sql<number>`count(*) filter (where ${schema.cliInvocations.cost} ->> 'source' = 'none')::int`,
    })
    .from(schema.cliInvocations)
    .leftJoin(schema.cliProviders, eq(schema.cliProviders.id, schema.cliInvocations.cliProviderId))
    .where(
      and(
        eq(schema.cliInvocations.taskId, taskId),
        isNull(schema.cliInvocations.supersededAt),
        or(
          isNotNull(schema.cliInvocations.taskStepId),
          isNotNull(schema.cliInvocations.summaryForStepId),
        ),
      ),
    )
    .groupBy(schema.cliProviders.name, schema.cliProviders.authMode);

  const out: TaskProviderUsage[] = [];
  for (const row of rows) {
    if (!row.provider) continue; // provider row deleted (cli_provider_id set null) — skip
    const name = row.provider as CliProviderName;
    const authMode = (row.authMode ?? 'subscription') as AuthMode;
    const basis = resolveCostBasis(name, authMode);
    const inputTokens = Number(row.inputTokens) || 0;
    const outputTokens = Number(row.outputTokens) || 0;
    const invocations = Number(row.invocations) || 0;
    if (inputTokens === 0 && outputTokens === 0 && invocations === 0) continue;
    out.push({
      provider: name,
      costBasis: basis,
      invocations,
      inputTokens,
      outputTokens,
      cacheReadTokens: Number(row.cacheReadTokens) || 0,
      cacheCreationTokens: Number(row.cacheCreationTokens) || 0,
      // No basis gate here any more: realCostUsdSql already applied the billable
      // decision per row, and re-gating on the CURRENT provider config would zero a
      // legitimately-computed cost whenever a provider's auth mode changed later.
      costUsd: Number(row.costUsd) || 0,
      notionalCostUsd: Number(row.notionalCostUsd) || 0,
      costSource: summarizeCostSources(row.costSources),
      unpricedInvocations: Number(row.unpricedInvocations) || 0,
    });
  }
  return out.sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
}

/** Reverse-lookup the role of each waiting_cli step's LIVE cli invocation (from its
 *  agentTitle, the role label) so the UI can react to the active pass — e.g. the
 *  browser panel hides during 08a's `fixer` pass. cli_invocations has no role
 *  column, so map the label back through STEP_CLI_ROLES. null when not waiting on a
 *  role-bearing CLI. */
export async function enrichStepsWithActiveRole<
  T extends { id: string; stepId: string; status: string },
>(
  db: ReturnType<typeof getDb>,
  taskId: string,
  steps: T[],
): Promise<(T & { activeRole: string | null })[]> {
  const liveIds = steps
    .filter((s) => s.status === 'waiting_cli' && STEP_CLI_ROLES[s.stepId])
    .map((s) => s.id);
  if (liveIds.length === 0) return steps.map((s) => ({ ...s, activeRole: null }));
  const rows = await db
    .select({
      taskStepId: schema.cliInvocations.taskStepId,
      agentTitle: schema.cliInvocations.agentTitle,
    })
    .from(schema.cliInvocations)
    .where(
      and(
        eq(schema.cliInvocations.taskId, taskId),
        inArray(schema.cliInvocations.taskStepId, liveIds),
        isNull(schema.cliInvocations.endedAt),
        isNull(schema.cliInvocations.supersededAt),
      ),
    );
  const titleByStep = new Map<string, string | null>();
  for (const r of rows) if (r.taskStepId) titleByStep.set(r.taskStepId, r.agentTitle);
  return steps.map((s) => {
    const title = titleByStep.get(s.id) ?? null;
    const role =
      title != null ? (STEP_CLI_ROLES[s.stepId]?.find((r) => r.label === title)?.id ?? null) : null;
    return { ...s, activeRole: role };
  });
}

/** Whether the user Skip action is permitted on a step. Beyond the static
 *  SKIPPABLE_STEP_IDS (steps whose StepDefinition opts in via allowSkip), a
 *  run_app task may skip 01-worktree-setup to run from the project root instead
 *  of an isolated branch/worktree. The skip handler enforces the same rule. */
export function isStepSkippable(stepId: string, workflowType?: string | null): boolean {
  if (SKIPPABLE_STEP_IDS.includes(stepId)) return true;
  return workflowType === 'run_app' && stepId === '01-worktree-setup';
}

export async function enrichStepsWithSkipFlag<
  T extends { id: string; status: string; stepId: string },
>(
  db: ReturnType<typeof getDb>,
  taskId: string,
  steps: T[],
): Promise<(T & { manuallySkipped: boolean; canSkip: boolean })[]> {
  // canSkip: the step opts into the user-facing Skip action (the skip handler
  // enforces the same rule). Task-type-aware so run_app can skip the worktree.
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { type: true },
  });
  const workflowType = task?.type ?? null;
  const withFlags = (s: T, manuallySkipped: boolean) => ({
    ...s,
    manuallySkipped,
    canSkip: isStepSkippable(s.stepId, workflowType),
  });
  const skippedIds = steps.filter((s) => s.status === 'skipped').map((s) => s.id);
  if (skippedIds.length === 0) return steps.map((s) => withFlags(s, false));
  const events = await db
    .select({ taskStepId: schema.taskEvents.taskStepId })
    .from(schema.taskEvents)
    .where(
      and(
        eq(schema.taskEvents.taskId, taskId),
        eq(schema.taskEvents.eventType, 'step.skip'),
        inArray(schema.taskEvents.taskStepId, skippedIds),
      ),
    );
  const manualSet = new Set(events.map((e) => e.taskStepId).filter((v): v is string => !!v));
  return steps.map((s) => withFlags(s, manualSet.has(s.id)));
}

/** Annotate each step with how its CONCURRENT agent terminals ended, so the web can offer
 *  "re-run only the ones that failed" on a fan-out step (08c's peer reviewer, security reviewer
 *  and extra lenses).
 *
 *  Counted from `task_step_agent_minings.status`, the structural column, never from
 *  `error_message` — a message outlives the state it describes, and an agent that failed once
 *  and succeeded on a re-roll keeps its error text on the row.
 *
 *  `inFlight` counts the terminals that have NOT ended yet, and is what makes `failed > 0`
 *  safe to act on: a dead terminal alongside live siblings is a fan-out still in progress,
 *  not a settled one with something to re-run. Without it the web sees `failed > 0` the
 *  instant the FIRST terminal dies and offers a resume that kills every sibling sandbox,
 *  while its "N of M" reads the settled subset as if it were the whole fan-out.
 *
 *  All zero for a step with no fan-out, so callers need no null check and a sequential loop
 *  step simply reports nothing to re-run. */
export async function enrichStepsWithAgentCounts<T extends { id: string }>(
  db: ReturnType<typeof getDb>,
  taskId: string,
  steps: T[],
): Promise<(T & { agentCounts: { done: number; failed: number; inFlight: number } })[]> {
  if (steps.length === 0) return [];
  const rows = await db
    .select({
      taskStepId: schema.taskStepAgentMinings.taskStepId,
      done: sql<number>`count(*) filter (where ${schema.taskStepAgentMinings.status} = 'done')::int`,
      failed: sql<number>`count(*) filter (where ${schema.taskStepAgentMinings.status} = 'failed')::int`,
      inFlight: sql<number>`count(*) filter (where ${schema.taskStepAgentMinings.status} in ('pending', 'running'))::int`,
    })
    .from(schema.taskStepAgentMinings)
    .innerJoin(schema.taskSteps, eq(schema.taskSteps.id, schema.taskStepAgentMinings.taskStepId))
    .where(eq(schema.taskSteps.taskId, taskId))
    .groupBy(schema.taskStepAgentMinings.taskStepId);
  const byStep = new Map(rows.map((r) => [r.taskStepId, r]));
  return steps.map((s) => {
    const row = byStep.get(s.id);
    return {
      ...s,
      agentCounts: {
        done: Number(row?.done ?? 0),
        failed: Number(row?.failed ?? 0),
        inFlight: Number(row?.inFlight ?? 0),
      },
    };
  });
}

export const CLI_DISPATCH_STEP_ID_SET = new Set<string>(CLI_DISPATCH_STEP_IDS);

/** Annotate each step with whether it ever dispatches a CLI (llm | agentMining |
 *  dagExecute), from the CLI_DISPATCH_STEP_IDS mirror. Drives whether the web
 *  renders the per-step CLI picker — deterministic steps never consume a per-step
 *  provider, so the picker is hidden (and a "runs without an AI CLI" note shown)
 *  for them. Pure/static: the source of truth is the worker step registry, kept
 *  in sync by a worker boot assertion. */
export function enrichStepsWithCliUsage<T extends { stepId: string }>(
  steps: T[],
): (T & { usesCli: boolean })[] {
  return steps.map((s) => ({ ...s, usesCli: CLI_DISPATCH_STEP_ID_SET.has(s.stepId) }));
}

const MODEL_HEALTH_STEP_ID_SET = new Set<string>(MODEL_HEALTH_STEP_IDS);

/** The task's CLI steps that have NO `task_steps` row yet, with their saved provider /
 *  effort / role / seat preferences attached — the "CLIs" tab's whole content.
 *
 *  Rows are created lazily (when a step runs or parks), so a step the run has not reached
 *  has no card and therefore no picker. A step that never pauses before dispatching (its
 *  form sets `autoSubmit`, or it has none and the task is on auto-continue) consequently
 *  had NO window at all in which to choose its CLI — 08a-browser-verify's Tester/Fixer
 *  being the reported case. Preferences are keyed (user, step, role) and read by the
 *  worker's resolvePreferredCli at DISPATCH time, so one written here lands on this task.
 *
 *  Deliberately routed through enrichStepsWithCliPreferences rather than re-deriving:
 *  that function needs only `stepId`, and already resolves roles, fan-out seats and the
 *  ignore_saved_step_clis gating. Two copies of that resolution would drift.
 *
 *  Filtered by workflowType, which OVER-lists rather than under-lists: a workflow task's
 *  execution_path can drop steps (orchestrator/execution-paths.ts is worker-side and not
 *  mirrored here), and a stored preference for a step that never runs is inert. The
 *  model-health canary is excluded — a CLI change there is a task-level decision that
 *  rewrites tasks.cli_provider_id (propagateModelHealthCliToTaskDefault), not a per-step
 *  preference, and it runs first in every pipeline anyway. */
export async function buildUpcomingCliSteps(
  db: ReturnType<typeof getDb>,
  userId: string,
  taskId: string,
  taskType: string,
  existingStepIds: Iterable<string>,
  ignoreSaved = false,
) {
  const started = new Set<string>(existingStepIds);
  const upcoming = CLI_DISPATCH_STEPS.filter(
    (s) => s.workflowType === taskType && !MODEL_HEALTH_STEP_ID_SET.has(s.id) && !started.has(s.id),
  ).map((s) => ({ stepId: s.id, title: s.title }));
  if (upcoming.length === 0) return [];
  return enrichStepsWithCliPreferences(db, userId, upcoming, taskId, ignoreSaved);
}

export async function resolveWorkspaceRoot(
  db: ReturnType<typeof getDb>,
  taskId: string,
  userId: string,
): Promise<{ task: typeof schema.tasks.$inferSelect; root: string }> {
  const task = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, taskId), eq(schema.tasks.userId, userId)),
  });
  if (!task) throw new HttpError(404, 'Task not found');

  let root: string | null = null;
  if (task.worktreePath) {
    root = task.worktreePath;
  } else if (task.repositoryId) {
    const repo = await db.query.repositories.findFirst({
      where: eq(schema.repositories.id, task.repositoryId),
      columns: { storagePath: true, localPath: true },
    });
    root = repo?.storagePath ?? repo?.localPath ?? null;
  }
  if (!root) {
    throw new HttpError(409, 'Task has no resolvable workspace path');
  }
  return { task, root: resolve(root) };
}

export function validateWorkspacePath(root: string, requested: string | undefined): string {
  const target = requested ? resolve(requested) : root;
  const rel = relative(root, target);
  if (rel.startsWith('..') || rel === '..' || rel.includes('\0')) {
    throw new HttpError(403, 'Path is outside the task workspace');
  }
  return target;
}

export async function appendTaskEvent(
  db: ReturnType<typeof getDb>,
  taskId: string,
  taskStepId: string | null,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.insert(schema.taskEvents).values({
    taskId,
    taskStepId,
    eventType,
    payload,
  });
}

/** The model-health canary validates THE task's model, so swapping the CLI on a
 *  canary step (typically because the canary rejected the original model) is a
 *  task-level decision, not a per-step one: rewrite tasks.cli_provider_id so every
 *  later step that falls back to the task default — every step under
 *  ignore_saved_step_clis, and any untouched step otherwise — dispatches the new
 *  model instead of the rejected one. The worker re-reads tasks.cli_provider_id on
 *  each advance (resolveTaskContext), so the next step picks it up.
 *
 *  No-op (returns false) unless this is a canary step AND a concrete provider was
 *  picked: clearing the per-step pref back to the task default carries no new
 *  provider to propagate. Returns true when it rewrote the default. */
export async function propagateModelHealthCliToTaskDefault(
  db: ReturnType<typeof getDb>,
  params: {
    taskId: string;
    taskStepId: string;
    stepId: string;
    cliProviderId: string | null;
    by: string;
  },
): Promise<boolean> {
  const { taskId, taskStepId, stepId, cliProviderId, by } = params;
  if (!cliProviderId || !MODEL_HEALTH_STEP_IDS.includes(stepId)) return false;
  await db
    .update(schema.tasks)
    .set({ cliProviderId, updatedAt: new Date() })
    .where(eq(schema.tasks.id, taskId));
  await appendTaskEvent(db, taskId, taskStepId, 'task.cli_provider_changed', {
    cliProviderId,
    via: stepId,
    by,
  });
  return true;
}
