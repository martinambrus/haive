import { relative, resolve } from 'node:path';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema } from '@haive/database';
import { STEP_CLI_ROLES, type CliRoleDescriptor, type CliTokenUsage } from '@haive/shared';
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

export async function enrichStepsWithCliPreferences<T extends { stepId: string }>(
  db: ReturnType<typeof getDb>,
  userId: string,
  steps: T[],
): Promise<
  (T & {
    preferredCliProviderId: string | null;
    /** Present only for multi-CLI steps (STEP_CLI_ROLES); drives the per-role
     *  dropdowns and their currently-selected providers in the UI. */
    cliRoles?: readonly CliRoleDescriptor[];
    cliRoleProviders?: Record<string, string | null>;
  })[]
> {
  const stepIds = [...new Set(steps.map((s) => s.stepId))];
  const byStep = new Map<string, string>();
  const roleByStep = new Map<string, Map<string, string>>();
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
    for (const p of prefs) byStep.set(p.stepId, p.cliProviderId);

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
      }
    }
  }
  return steps.map((s) => {
    const roles = STEP_CLI_ROLES[s.stepId];
    const roleProviders = roleByStep.get(s.stepId) ?? new Map<string, string>();
    return {
      ...s,
      preferredCliProviderId: byStep.get(s.stepId) ?? null,
      ...(roles
        ? {
            cliRoles: roles,
            cliRoleProviders: Object.fromEntries(
              roles.map((r) => [r.id, roleProviders.get(r.id) ?? null]),
            ),
          }
        : {}),
    };
  });
}

export async function findActiveCliInvocation(
  db: ReturnType<typeof getDb>,
  taskId: string,
): Promise<{ id: string; taskStepId: string | null } | null> {
  const rows = await db
    .select({
      id: schema.cliInvocations.id,
      taskStepId: schema.cliInvocations.taskStepId,
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
): Promise<(T & { cliInvocationCount: number; tokenUsage: CliTokenUsage | null })[]> {
  if (steps.length === 0) return [];
  const tu = schema.cliInvocations.tokenUsage;
  const rows = await db
    .select({
      taskStepId: schema.cliInvocations.taskStepId,
      count: sql<number>`count(*)::int`,
      inputTokens: sql<number>`coalesce(sum((${tu} ->> 'inputTokens')::numeric), 0)::int`,
      outputTokens: sql<number>`coalesce(sum((${tu} ->> 'outputTokens')::numeric), 0)::int`,
      totalTokens: sql<number>`coalesce(sum((${tu} ->> 'totalTokens')::numeric), 0)::int`,
      cacheReadTokens: sql<number>`coalesce(sum((${tu} ->> 'cacheReadTokens')::numeric), 0)::int`,
      cacheCreationTokens: sql<number>`coalesce(sum((${tu} ->> 'cacheCreationTokens')::numeric), 0)::int`,
      costUsd: sql<number>`coalesce(sum((${tu} ->> 'costUsd')::numeric), 0)::double precision`,
    })
    .from(schema.cliInvocations)
    .where(
      and(eq(schema.cliInvocations.taskId, taskId), isNull(schema.cliInvocations.supersededAt)),
    )
    .groupBy(schema.cliInvocations.taskStepId);

  const byStep = new Map<string, { count: number; tokenUsage: CliTokenUsage | null }>();
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
    byStep.set(row.taskStepId, { count: row.count, tokenUsage });
  }
  return steps.map((s) => {
    const stat = byStep.get(s.id);
    return { ...s, cliInvocationCount: stat?.count ?? 0, tokenUsage: stat?.tokenUsage ?? null };
  });
}

export async function enrichStepsWithSkipFlag<T extends { id: string; status: string }>(
  db: ReturnType<typeof getDb>,
  taskId: string,
  steps: T[],
): Promise<(T & { manuallySkipped: boolean })[]> {
  const skippedIds = steps.filter((s) => s.status === 'skipped').map((s) => s.id);
  if (skippedIds.length === 0) return steps.map((s) => ({ ...s, manuallySkipped: false }));
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
  return steps.map((s) => ({ ...s, manuallySkipped: manualSet.has(s.id) }));
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
