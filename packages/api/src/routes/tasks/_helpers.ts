import { relative, resolve } from 'node:path';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema } from '@haive/database';
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
): Promise<(T & { preferredCliProviderId: string | null })[]> {
  const stepIds = [...new Set(steps.map((s) => s.stepId))];
  if (stepIds.length === 0) return steps.map((s) => ({ ...s, preferredCliProviderId: null }));
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
  const byStep = new Map(prefs.map((p) => [p.stepId, p.cliProviderId]));
  return steps.map((s) => ({ ...s, preferredCliProviderId: byStep.get(s.stepId) ?? null }));
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

/** Annotate each step with the count of non-superseded CLI invocations
 *  attached to it. The web UI uses this to suppress the inline terminal
 *  toggle on steps that have never spawned a CLI (deterministic-only steps,
 *  pending steps), so the chevron only appears where it has something to
 *  reveal. Single GROUP BY keeps it O(1) round-trips regardless of step
 *  count. */
export async function enrichStepsWithCliInvocationCount<T extends { id: string }>(
  db: ReturnType<typeof getDb>,
  taskId: string,
  steps: T[],
): Promise<(T & { cliInvocationCount: number })[]> {
  if (steps.length === 0) return [];
  const rows = await db
    .select({
      taskStepId: schema.cliInvocations.taskStepId,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.cliInvocations)
    .where(
      and(eq(schema.cliInvocations.taskId, taskId), isNull(schema.cliInvocations.supersededAt)),
    )
    .groupBy(schema.cliInvocations.taskStepId);
  const byStep = new Map<string, number>();
  for (const row of rows) {
    if (row.taskStepId) byStep.set(row.taskStepId, row.count);
  }
  return steps.map((s) => ({ ...s, cliInvocationCount: byStep.get(s.id) ?? 0 }));
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
