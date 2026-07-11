import { relative, resolve } from 'node:path';
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  CLI_DISPATCH_STEP_IDS,
  COST_METERED_PROVIDERS,
  resolveCostBasis,
  MODEL_HEALTH_STEP_IDS,
  SKIPPABLE_STEP_IDS,
  STEP_CLI_ROLES,
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
  })[]
> {
  const stepIds = [...new Set(steps.map((s) => s.stepId))];
  const byStep = new Map<string, string>();
  const byStepEffort = new Map<string, string | null>();
  const roleByStep = new Map<string, Map<string, string>>();
  const roleEffortByStep = new Map<string, Map<string, string | null>>();
  // When the task opted out of saved per-step prefs (ignore_saved_step_clis),
  // only prefs the user explicitly (re)set WITHIN this task are honored — tracked
  // by task_step_cli_touched. Load that touched set once and gate each surfaced
  // pref by its (step, role); untouched steps fall back to the task provider.
  const touchedByStep = new Map<string, Set<string>>();
  if (ignoreSaved && stepIds.length > 0) {
    const touched = await db
      .select()
      .from(schema.taskStepCliTouched)
      .where(eq(schema.taskStepCliTouched.taskId, taskId));
    for (const t of touched) {
      const set = touchedByStep.get(t.stepId) ?? new Set<string>();
      set.add(t.role);
      touchedByStep.set(t.stepId, set);
    }
  }
  if (stepIds.length > 0) {
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
      byStep.set(p.stepId, p.cliProviderId);
      byStepEffort.set(p.stepId, p.effortLevel);
    }

    // Per-role prefs, only for steps that declare CLI roles.
    const roleStepIds = stepIds.filter((sid) => STEP_CLI_ROLES[sid]);
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
        const m = roleByStep.get(p.stepId) ?? new Map<string, string>();
        m.set(p.role, p.cliProviderId);
        roleByStep.set(p.stepId, m);
        const me = roleEffortByStep.get(p.stepId) ?? new Map<string, string | null>();
        me.set(p.role, p.effortLevel);
        roleEffortByStep.set(p.stepId, me);
      }
    }
  }
  return steps.map((s) => {
    const roles = STEP_CLI_ROLES[s.stepId];
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
    };
  });
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

/** Annotate each step with the count of non-superseded CLI invocations attached
 *  to it AND the summed token usage across those invocations. The count drives
 *  the inline-terminal toggle (hidden on steps that never spawned a CLI); the
 *  token sum is surfaced per step and aggregated into the task total client-side.
 *  Uses the same `supersededAt IS NULL` filter as the per-step invocation panel,
 *  so a step's token total reconciles with the invocations shown there. Single
 *  GROUP BY keeps it O(1) round-trips regardless of step count. */
export async function enrichStepsWithCliStats<T extends { id: string }>(
  db: ReturnType<typeof getDb>,
  taskId: string,
  steps: T[],
): Promise<
  (T & { cliInvocationCount: number; attemptCount: number; tokenUsage: CliTokenUsage | null })[]
> {
  if (steps.length === 0) return [];
  const tu = schema.cliInvocations.tokenUsage;
  const rows = await db
    .select({
      taskStepId: schema.cliInvocations.taskStepId,
      count: sql<number>`count(*)::int`,
      // LLM run attempts: exclude agent_mining (parallel sub-agents inflate the
      // count and aren't retries). >1 on a non-loop step => an auto-retry happened.
      attemptCount: sql<number>`count(*) filter (where ${schema.cliInvocations.mode} <> 'agent_mining')::int`,
      inputTokens: sql<number>`coalesce(sum((${tu} ->> 'inputTokens')::numeric), 0)::int`,
      outputTokens: sql<number>`coalesce(sum((${tu} ->> 'outputTokens')::numeric), 0)::int`,
      totalTokens: sql<number>`coalesce(sum((${tu} ->> 'totalTokens')::numeric), 0)::int`,
      cacheReadTokens: sql<number>`coalesce(sum((${tu} ->> 'cacheReadTokens')::numeric), 0)::int`,
      cacheCreationTokens: sql<number>`coalesce(sum((${tu} ->> 'cacheCreationTokens')::numeric), 0)::int`,
      // Real dollars only from METERED providers on api_key auth. A metered CLI on
      // a subscription plan (claude-code/codex login) reports notional costUsd too,
      // as do local (ollama) / subscription (amp) / mispriced (zai) — see costBasis.
      costUsd: sql<number>`coalesce(sum((${tu} ->> 'costUsd')::numeric) filter (where ${schema.cliProviders.name}::text in ${COST_METERED_PROVIDERS} and ${schema.cliProviders.authMode} = 'api_key'), 0)::double precision`,
    })
    .from(schema.cliInvocations)
    .leftJoin(schema.cliProviders, eq(schema.cliProviders.id, schema.cliInvocations.cliProviderId))
    .where(
      and(eq(schema.cliInvocations.taskId, taskId), isNull(schema.cliInvocations.supersededAt)),
    )
    .groupBy(schema.cliInvocations.taskStepId);

  const byStep = new Map<
    string,
    { count: number; attemptCount: number; tokenUsage: CliTokenUsage | null }
  >();
  for (const row of rows) {
    if (!row.taskStepId) continue;
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
    byStep.set(row.taskStepId, {
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
 *  Uses the same `supersededAt IS NULL` filter as the per-step stats, plus a
 *  non-null step, so a task's list total equals the sum of its per-step token
 *  badges on the detail page (which folds step totals and skips null-step rows).
 *  Tasks with no token-bearing invocation are simply absent from the map. */
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
      // Real dollars only from METERED providers on api_key auth. A metered CLI on
      // a subscription plan (claude-code/codex login) reports notional costUsd too,
      // as do local (ollama) / subscription (amp) / mispriced (zai) — see costBasis.
      costUsd: sql<number>`coalesce(sum((${tu} ->> 'costUsd')::numeric) filter (where ${schema.cliProviders.name}::text in ${COST_METERED_PROVIDERS} and ${schema.cliProviders.authMode} = 'api_key'), 0)::double precision`,
    })
    .from(schema.cliInvocations)
    .leftJoin(schema.cliProviders, eq(schema.cliProviders.id, schema.cliInvocations.cliProviderId))
    .where(
      and(
        inArray(schema.cliInvocations.taskId, taskIds),
        isNull(schema.cliInvocations.supersededAt),
        isNotNull(schema.cliInvocations.taskStepId),
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
  /** Real dollars — metered CLIs on api_key auth only (0 otherwise). */
  costUsd: number;
}

/** Per-provider token/cost split for a task's detail page. Tokens sum across ALL
 *  providers (always real); costUsd is real only for metered CLIs on api_key auth so
 *  local/subscription/mispriced $ never inflate the headline. Ordered by token volume
 *  (the primary metric). Same superseded/non-null-step filter as the other aggregations. */
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
      costUsd: sql<number>`coalesce(sum((${tu} ->> 'costUsd')::numeric), 0)::double precision`,
    })
    .from(schema.cliInvocations)
    .leftJoin(schema.cliProviders, eq(schema.cliProviders.id, schema.cliInvocations.cliProviderId))
    .where(
      and(
        eq(schema.cliInvocations.taskId, taskId),
        isNull(schema.cliInvocations.supersededAt),
        isNotNull(schema.cliInvocations.taskStepId),
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
      costUsd: basis === 'metered' ? Number(row.costUsd) || 0 : 0,
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

const CLI_DISPATCH_STEP_ID_SET = new Set<string>(CLI_DISPATCH_STEP_IDS);

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
