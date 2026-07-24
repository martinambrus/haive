import { Hono } from 'hono';
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  buildEstimationAccuracy,
  computeFoldContribution,
  computeTaskTiming,
  createTaskRequestSchema,
  expandTaskStatusFilter,
  logger,
  PROVIDER_SENSITIVE_STEP_IDS,
  renameTaskRequestSchema,
  setCliProviderRequestSchema,
  STEER_IN_CHANNEL_PREFIX,
  taskActionRequestSchema,
  TASK_JOB_NAMES,
  type TaskJobPayload,
} from '@haive/shared';
import { getDb } from '../../db.js';
import { getRedis } from '../../redis.js';
import { requireAuth } from '../../middleware/auth.js';
import { HttpError, type AppEnv } from '../../context.js';
import { killTaskSandboxes } from '../../lib/sandbox-kill.js';
import { cancelTaskRow, enqueueCancelJob } from '../../lib/cancel-task.js';
import { getTaskQueue } from '../../queues.js';
import {
  appendTaskEvent,
  enrichStepsWithActiveRole,
  enrichStepsWithCliStats,
  enrichStepsWithCliPreferences,
  enrichStepsWithCliUsage,
  enrichStepsWithSkipFlag,
  findActiveCliInvocation,
  sumTaskTokens,
  sumTaskProviderBreakdown,
} from './_helpers.js';
import { fileRoutes } from './files.js';
import { stepRoutes } from './steps.js';
import { browserAccessRoutes } from './browser-access.js';
import { attachmentRoutes } from './attachments.js';

export const taskRoutes = new Hono<AppEnv>();

taskRoutes.use('*', requireAuth);

taskRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const db = getDb();

  // Server-side pagination + filtering so large projects ship only one slice to
  // the client (the web listing scrolls more pages in on demand). Mirrors the
  // global-kb /entries pattern: page/pageSize + count(*) + a filter facet.
  const repositoryId = c.req.query('repositoryId')?.trim() || undefined;
  const statusToken = c.req.query('status')?.trim();
  const q = c.req.query('q')?.trim();
  const page = Math.max(1, Math.floor(Number(c.req.query('page') ?? '1')) || 1);
  const pageSize = Math.min(
    100,
    Math.max(1, Math.floor(Number(c.req.query('pageSize') ?? '20')) || 20),
  );

  const conds = [eq(schema.tasks.userId, userId)];
  if (repositoryId) conds.push(eq(schema.tasks.repositoryId, repositoryId));
  const statuses = expandTaskStatusFilter(statusToken);
  if (statuses) {
    conds.push(
      inArray(schema.tasks.status, statuses as (typeof schema.tasks.$inferSelect)['status'][]),
    );
  }
  if (q) conds.push(sql`${schema.tasks.title} ilike ${`%${q}%`}`);
  const where = and(...conds);

  const totalRows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.tasks)
    .where(where);
  const total = totalRows[0]?.n ?? 0;

  const rows = await db.query.tasks.findMany({
    where,
    orderBy: [desc(schema.tasks.createdAt)],
    with: { repository: { columns: { id: true, name: true } } },
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  // Distinct repos that own at least one of the user's tasks, for the listing's
  // repository dropdown. Computed independent of the active filters/page so the
  // options stay stable as the user filters (the loaded page alone no longer
  // contains every repo once the list is paginated).
  const repositories = await db
    .selectDistinct({ id: schema.repositories.id, name: schema.repositories.name })
    .from(schema.tasks)
    .innerJoin(schema.repositories, eq(schema.tasks.repositoryId, schema.repositories.id))
    .where(eq(schema.tasks.userId, userId))
    .orderBy(asc(schema.repositories.name));

  // Per-task time breakdown for the listing (wall/work/idle/user). The task rows
  // carry no steps, so pull every step of THIS PAGE's tasks in one query and fold
  // them with the same computeTaskTiming the detail page uses. Snapshot at `now`;
  // the listing's 3s poll keeps running tasks current.
  const now = Date.now();
  const taskIds = rows.map((r) => r.id);
  const stepRows = taskIds.length
    ? await db
        .select({
          taskId: schema.taskSteps.taskId,
          startedAt: schema.taskSteps.startedAt,
          endedAt: schema.taskSteps.endedAt,
          idleMs: schema.taskSteps.idleMs,
          userActiveMs: schema.taskSteps.userActiveMs,
          waitingStartedAt: schema.taskSteps.waitingStartedAt,
          status: schema.taskSteps.status,
          carriedWorkMs: schema.taskSteps.carriedWorkMs,
          carriedIdleMs: schema.taskSteps.carriedIdleMs,
          carriedUserActiveMs: schema.taskSteps.carriedUserActiveMs,
        })
        .from(schema.taskSteps)
        .where(inArray(schema.taskSteps.taskId, taskIds))
    : [];
  const stepsByTask = new Map<string, (typeof stepRows)[number][]>();
  for (const s of stepRows) {
    const list = stepsByTask.get(s.taskId);
    if (list) list.push(s);
    else stepsByTask.set(s.taskId, [s]);
  }
  // Per-task CLI token totals for the listing, summed across the page's tasks in
  // one query. Like timing, it's a snapshot at `now`; the listing's 3s poll keeps
  // running tasks current as the worker flushes live usage snapshots.
  const tokensByTask = await sumTaskTokens(db, taskIds);
  // Names of the providers this page's tasks are waiting on, so the "provider is back"
  // notification can say WHICH CLI recovered instead of a generic line. A side-query rather
  // than a drizzle relation: `tasks` already relates to `cli_providers` via cliProviderId, and
  // a second relation between the same pair needs relationName on both sides.
  const watchedProviderIds = [
    ...new Set(rows.map((t) => t.awaitingAllowanceProviderId).filter((id): id is string => !!id)),
  ];
  const providerNameById = new Map(
    watchedProviderIds.length
      ? (
          await db
            .select({ id: schema.cliProviders.id, name: schema.cliProviders.name })
            .from(schema.cliProviders)
            .where(inArray(schema.cliProviders.id, watchedProviderIds))
        ).map((p) => [p.id, p.name])
      : [],
  );
  const tasks = rows.map((t) => {
    const steps = stepsByTask.get(t.id) ?? [];
    const startMs = t.startedAt ? t.startedAt.getTime() : null;
    // The task's EFFECTIVE now, not the wall clock: a step left open when the task reached a
    // terminal state (legacy rows predating c8542c0) otherwise bills start->now as work
    // forever and grows every time the list is polled — one such row read 670h against a 1.78h
    // wall. The web detail page already caps this way (tasks/[id]/page.tsx endMs, and
    // StepDuration's `endedAt ?? taskCompletedAt`); this endpoint was the divergence.
    const endMs = t.completedAt ? t.completedAt.getTime() : now;
    const { workMs, idleMs, userActiveMs } = computeTaskTiming(steps, endMs);
    const wallMs = startMs === null ? 0 : Math.max(0, endMs - startMs);
    // At most one step is in waiting_form at a time, so the single non-null
    // waitingStartedAt tags THIS wait occurrence — a fresh value each time the
    // task (re)enters a gate. Lets the notifier re-fire on a restart that returns
    // to the same step, without re-firing on unrelated task edits.
    const waitStart = steps.find((s) => s.waitingStartedAt)?.waitingStartedAt ?? null;
    return {
      ...t,
      timing: { wallMs, workMs, idleMs, userActiveMs },
      tokenUsage: tokensByTask.get(t.id) ?? null,
      currentWaitStartedAt: waitStart ? waitStart.toISOString() : null,
      allowanceReplenishedAt: t.allowanceReplenishedAt
        ? t.allowanceReplenishedAt.toISOString()
        : null,
      allowanceAutoResumedAt: t.allowanceAutoResumedAt
        ? t.allowanceAutoResumedAt.toISOString()
        : null,
      allowanceProviderName: t.awaitingAllowanceProviderId
        ? (providerNameById.get(t.awaitingAllowanceProviderId) ?? null)
        : null,
      allowanceWatchReason: t.awaitingProviderReason ?? null,
    };
  });
  return c.json({ tasks, total, page, pageSize, repositories });
});

taskRoutes.post('/', async (c) => {
  const userId = c.get('userId');
  const body = createTaskRequestSchema.parse(await c.req.json());
  const db = getDb();

  if (body.repositoryId) {
    const repo = await db.query.repositories.findFirst({
      where: and(
        eq(schema.repositories.id, body.repositoryId),
        eq(schema.repositories.userId, userId),
      ),
      columns: { id: true },
    });
    if (!repo) throw new HttpError(404, 'Repository not found');
  }

  if (body.type === 'onboarding_upgrade') {
    if (!body.repositoryId) {
      throw new HttpError(400, 'onboarding_upgrade tasks require a repositoryId');
    }
    const priorOnboarding = await db.query.tasks.findFirst({
      where: and(
        eq(schema.tasks.repositoryId, body.repositoryId),
        eq(schema.tasks.userId, userId),
        eq(schema.tasks.type, 'onboarding'),
        eq(schema.tasks.status, 'completed'),
      ),
      columns: { id: true },
    });
    const priorArtifact = await db.query.onboardingArtifacts.findFirst({
      where: and(
        eq(schema.onboardingArtifacts.repositoryId, body.repositoryId),
        isNull(schema.onboardingArtifacts.supersededAt),
      ),
      columns: { id: true },
    });
    if (!priorOnboarding && !priorArtifact) {
      throw new HttpError(409, 'No completed onboarding found for this repository; cannot upgrade');
    }
  }

  if (body.cliProviderId) {
    const provider = await db.query.cliProviders.findFirst({
      where: and(
        eq(schema.cliProviders.id, body.cliProviderId),
        eq(schema.cliProviders.userId, userId),
      ),
      columns: { id: true },
    });
    if (!provider) throw new HttpError(404, 'CLI provider not found');
  }

  if (body.dbUploadId) {
    const dump = await db.query.dbUploads.findFirst({
      where: and(eq(schema.dbUploads.id, body.dbUploadId), eq(schema.dbUploads.userId, userId)),
      columns: { id: true, status: true },
    });
    if (!dump) throw new HttpError(404, 'DB dump upload not found');
    if (dump.status !== 'complete') {
      throw new HttpError(409, `DB dump upload is ${dump.status}, not complete`);
    }
  }

  // Parent-task link (bug fixes only, one level). The chosen parent must be a
  // completed workflow task the user owns in the SAME repo. Flatten: if the pick
  // is itself a linked bug fix, link to ITS parent so the tree never exceeds one
  // level (see the tasks.parent_task_id schema note).
  let parentTaskId: string | null = null;
  if (body.parentTaskId) {
    if (body.type !== 'workflow' || !body.isBugFix) {
      throw new HttpError(400, 'parentTaskId is only allowed on bug-fix tasks');
    }
    if (!body.repositoryId) {
      throw new HttpError(400, 'parentTaskId requires a repositoryId');
    }
    const parent = await db.query.tasks.findFirst({
      where: and(
        eq(schema.tasks.id, body.parentTaskId),
        eq(schema.tasks.userId, userId),
        eq(schema.tasks.repositoryId, body.repositoryId),
        eq(schema.tasks.type, 'workflow'),
        eq(schema.tasks.status, 'completed'),
      ),
      columns: { id: true, parentTaskId: true },
    });
    if (!parent) {
      throw new HttpError(
        404,
        'Parent task not found (must be a completed task in this repository)',
      );
    }
    parentTaskId = parent.parentTaskId ?? parent.id;
  }

  const metadata: Record<string, unknown> = {};
  if (body.isBugFix) metadata.category = 'bugfix';
  if (body.feature) metadata.feature = body.feature;
  if (body.affectedClients?.length) metadata.affectedClients = body.affectedClients;

  const inserted = await db
    .insert(schema.tasks)
    .values({
      userId,
      type: body.type,
      title: body.title,
      description: body.description ?? null,
      repositoryId: body.repositoryId ?? null,
      parentTaskId,
      cliProviderId: body.cliProviderId ?? null,
      dbUploadId: body.dbUploadId ?? null,
      simplifyCode: body.simplifyCode ?? false,
      adversarialQaLevel:
        body.adversarialQaLevel && body.adversarialQaLevel !== 'none'
          ? body.adversarialQaLevel
          : null,
      broadAudit: body.broadAudit ?? true,
      memoryLimitMb: body.resourceLimits?.memoryLimitMb ?? null,
      cpuLimitMilli: body.resourceLimits?.cpuLimitMilli ?? null,
      stepLoopLimits: body.stepLoopLimits ?? {},
      autoContinue: body.autoContinue ?? true,
      ignoreSavedStepClis: body.ignoreSavedStepClis ?? false,
      metadata: Object.keys(metadata).length > 0 ? metadata : null,
      estimatedTimeHours: body.estimatedTimeHours ?? null,
      status: 'created',
    })
    .returning();

  const task = inserted[0];
  if (!task) throw new HttpError(500, 'Failed to create task');

  await appendTaskEvent(db, task.id, null, 'task.created', { userId });

  const queue = getTaskQueue();
  const payload: TaskJobPayload = { taskId: task.id, userId };
  await queue.add(TASK_JOB_NAMES.START, payload, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 100,
  });

  return c.json({ task }, 201);
});

// Feature/area autocomplete: distinct `metadata.feature` values previously used
// on THIS repo, substring-matched (ilike) on the typed query. Scoped to the
// requesting user so it never leaks another owner's feature tags — repos are
// single-owner and the new-task form only lists the caller's repos, so this is
// also the only set that can actually "pair" in per-repo knowledge discovery.
// Min 2 chars (mirrors the client) so a 1-char query can't scan every task.
// Most-used first, then alphabetical. Registered before `/:id` so the literal
// path isn't captured as a task id.
taskRoutes.get('/feature-suggestions', async (c) => {
  const userId = c.get('userId');
  const repositoryId = c.req.query('repositoryId')?.trim();
  const q = c.req.query('q')?.trim();
  if (!repositoryId || !q || q.length < 2) return c.json({ suggestions: [] });
  const db = getDb();
  // NULL/missing feature → `NULL ilike ...` is NULL → row dropped; '' can't
  // contain a >=2-char substring → dropped. So the ilike alone excludes blanks.
  const featureExpr = sql<string>`${schema.tasks.metadata} ->> 'feature'`;
  const rows = await db
    .select({ feature: featureExpr })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.userId, userId),
        eq(schema.tasks.repositoryId, repositoryId),
        sql`${featureExpr} ilike ${`%${q}%`}`,
      ),
    )
    .groupBy(featureExpr)
    .orderBy(desc(sql`count(*)`), asc(featureExpr))
    .limit(10);
  return c.json({ suggestions: rows.map((r) => r.feature) });
});

// Preselect the New Task form's CLI dropdown from this repo's history: the
// cli_provider_id of the most-recent task on THIS repo that picked one. That
// column is effectively the step-0 CLI (resolvePreferredCli falls back to
// tasks.cli_provider_id), i.e. "the CLI used on this repo last". User-scoped
// like its siblings. Static path — must stay ABOVE '/:id' so it is not
// captured as a task id.
taskRoutes.get('/last-cli', async (c) => {
  const userId = c.get('userId');
  const repositoryId = c.req.query('repositoryId')?.trim();
  if (!repositoryId) return c.json({ cliProviderId: null });
  const db = getDb();
  const row = await db.query.tasks.findFirst({
    where: and(
      eq(schema.tasks.userId, userId),
      eq(schema.tasks.repositoryId, repositoryId),
      isNotNull(schema.tasks.cliProviderId),
    ),
    orderBy: [desc(schema.tasks.createdAt)],
    columns: { cliProviderId: true },
  });
  return c.json({ cliProviderId: row?.cliProviderId ?? null });
});

// Per-repo estimation-accuracy dashboard (task-time estimation v2.4). Completed workflow
// tasks that carry a RAW AI estimate are paired with their MEASURED actual effort
// (computeTaskTiming), and the shared aggregator derives per-task error + the repo-level
// MAPE / median bias / over-under split. Empty until tasks complete through 00b-estimate.
// Static path — must stay ABOVE '/:id' so it is not captured as an id.
taskRoutes.get('/estimation-accuracy', async (c) => {
  const userId = c.get('userId');
  const repositoryId = c.req.query('repositoryId')?.trim();
  if (!repositoryId) throw new HttpError(400, 'repositoryId is required');
  const db = getDb();

  const rows = await db.query.tasks.findMany({
    where: and(
      eq(schema.tasks.userId, userId),
      eq(schema.tasks.repositoryId, repositoryId),
      eq(schema.tasks.type, 'workflow'),
      eq(schema.tasks.status, 'completed'),
      isNotNull(schema.tasks.aiEstimatedTimeHours),
    ),
    orderBy: [desc(schema.tasks.completedAt)],
    columns: {
      id: true,
      title: true,
      completedAt: true,
      aiEstimatedTimeHours: true,
      estimatedTimeHours: true,
    },
  });

  const taskIds = rows.map((r) => r.id);
  const stepRows = taskIds.length
    ? await db
        .select({
          taskId: schema.taskSteps.taskId,
          startedAt: schema.taskSteps.startedAt,
          endedAt: schema.taskSteps.endedAt,
          idleMs: schema.taskSteps.idleMs,
          userActiveMs: schema.taskSteps.userActiveMs,
          waitingStartedAt: schema.taskSteps.waitingStartedAt,
          status: schema.taskSteps.status,
          carriedWorkMs: schema.taskSteps.carriedWorkMs,
          carriedIdleMs: schema.taskSteps.carriedIdleMs,
          carriedUserActiveMs: schema.taskSteps.carriedUserActiveMs,
        })
        .from(schema.taskSteps)
        .where(inArray(schema.taskSteps.taskId, taskIds))
    : [];
  const stepsByTask = new Map<string, (typeof stepRows)[number][]>();
  for (const s of stepRows) {
    const list = stepsByTask.get(s.taskId);
    if (list) list.push(s);
    else stepsByTask.set(s.taskId, [s]);
  }

  const now = Date.now();
  const data = rows.map((t) => {
    // Cap at the task's completion instant — same reason as the listing above. This feeds the
    // estimation-accuracy report, so an uncapped open step inflates "actual" hours and biases
    // the effort learner against its own past estimates.
    const endMs = t.completedAt ? t.completedAt.getTime() : now;
    const { workMs, userActiveMs } = computeTaskTiming(stepsByTask.get(t.id) ?? [], endMs);
    return {
      taskId: t.id,
      title: t.title,
      completedAt: t.completedAt ? t.completedAt.toISOString() : null,
      aiEstimatedHours: t.aiEstimatedTimeHours ?? 0,
      confirmedHours: t.estimatedTimeHours ?? null,
      actualHours: Math.round(((workMs + userActiveMs) / 3_600_000) * 100) / 100,
    };
  });
  return c.json(buildEstimationAccuracy(data));
});

taskRoutes.get('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  const task = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, id), eq(schema.tasks.userId, userId)),
    with: { repository: { columns: { id: true, name: true } } },
  });
  if (!task) throw new HttpError(404, 'Task not found');
  const stepRows = await db
    .select()
    .from(schema.taskSteps)
    .where(eq(schema.taskSteps.taskId, id))
    // Run-list order: sort by run_seq (the step's position in buildRunList, stamped by
    // the worker), monotonic with true run order even for steps reused across task types
    // (the env_replicate prelude in a workflow, run_app's choose-view/env steps) or
    // inserted mid-pipeline on a resumed task — cases where createdAt (created out of run
    // order) and stepIndex alone (global offset, not run-monotonic for reused steps) both
    // misorder. round is primary so a fix loop's round-N rows (same step, higher round)
    // stay grouped after round 0. Legacy rows with null run_seq fall back to createdAt
    // (Postgres sorts NULLs last on ASC); stepIndex is the final tiebreak.
    .orderBy(
      asc(schema.taskSteps.round),
      asc(schema.taskSteps.runSeq),
      asc(schema.taskSteps.createdAt),
      asc(schema.taskSteps.stepIndex),
    );
  const enriched = await enrichStepsWithCliPreferences(
    db,
    userId,
    stepRows,
    id,
    task.ignoreSavedStepClis,
  );
  const withSkip = await enrichStepsWithSkipFlag(db, id, enriched);
  const withStats = await enrichStepsWithCliStats(db, id, withSkip);
  const withActiveRole = await enrichStepsWithActiveRole(db, id, withStats);
  const steps = enrichStepsWithCliUsage(withActiveRole);
  const active = await findActiveCliInvocation(db, id);
  const providerBreakdown = await sumTaskProviderBreakdown(db, id);
  // Parent + linked bug fixes (one level; see tasks.parent_task_id). Both scoped
  // to the owner. parentTask is null unless this task is itself a linked bug fix.
  const parentTask = task.parentTaskId
    ? ((await db.query.tasks.findFirst({
        where: and(eq(schema.tasks.id, task.parentTaskId), eq(schema.tasks.userId, userId)),
        columns: { id: true, title: true, status: true },
      })) ?? null)
    : null;
  const childTasks = await db.query.tasks.findMany({
    where: and(eq(schema.tasks.parentTaskId, id), eq(schema.tasks.userId, userId)),
    columns: { id: true, title: true, status: true, createdAt: true },
    orderBy: [desc(schema.tasks.createdAt)],
  });
  const taskWithActive = {
    ...task,
    activeCliInvocationId: active?.id ?? null,
    activeCliStepId: active?.taskStepId ?? null,
  };
  return c.json({ task: taskWithActive, steps, providerBreakdown, parentTask, childTasks });
});

taskRoutes.patch('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const body = renameTaskRequestSchema.parse(await c.req.json());
  const db = getDb();

  const task = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, id), eq(schema.tasks.userId, userId)),
    columns: { id: true, status: true, currentStepId: true },
  });
  if (!task) throw new HttpError(404, 'Task not found');

  const patch: Partial<typeof schema.tasks.$inferInsert> = {};
  if (body.title !== undefined) patch.title = body.title;
  if (body.autoContinue !== undefined) patch.autoContinue = body.autoContinue;

  const updated = await db
    .update(schema.tasks)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.tasks.id, id))
    .returning();

  if (body.title !== undefined) {
    await appendTaskEvent(db, id, null, 'task.renamed', { title: body.title, by: userId });
  }
  if (body.autoContinue !== undefined) {
    await appendTaskEvent(db, id, null, 'task.auto_continue_changed', {
      autoContinue: body.autoContinue,
      by: userId,
    });
    // Flipping auto-continue ON while the task waits on a form gives the
    // runner a chance to auto-pass it (pre-answered or zero-field steps);
    // a step that still needs input just re-enters waiting_form.
    if (body.autoContinue === true && task.status === 'waiting_user' && task.currentStepId) {
      await getTaskQueue().add(
        TASK_JOB_NAMES.ADVANCE_STEP,
        { taskId: id, userId, stepId: task.currentStepId } as TaskJobPayload,
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      );
    }
  }

  return c.json({ task: updated[0] });
});

/** Force-stop a task's current activity so it leaves the running state. Marks
 *  every still-live cli-exec invocation superseded+ended (exit 137) AND fails
 *  whatever step is stuck in running/waiting_cli — including a frozen
 *  DETERMINISTIC step with no invocation at all (e.g. one orphaned by a worker
 *  restart), which has nothing in cli_invocations to cancel and would otherwise
 *  be un-stoppable. Supersede + step writes are committed BEFORE the cli
 *  sandboxes are killed, so the dying cli-exec job's `resumeStepIfLinked` is a
 *  no-op (it skips the advance for a superseded invocation — see resolvers.ts)
 *  and can't clobber the caller's terminal state. With `failTask`, also drops
 *  the task to `failed` (restartable) — used by Stop / cancel-active-cli. The
 *  task `cancel` action passes `failTask:false` and sets `cancelled` itself
 *  afterwards; without the supersede-first step its `cancelled` gets clobbered
 *  back to `failed` by the dying job, forcing the user to click Cancel twice. */
async function stopActiveCliInvocations(
  db: ReturnType<typeof getDb>,
  taskId: string,
  opts: { failTask: boolean },
): Promise<{ killed: number; cancelled: number; stopped: number }> {
  const now = new Date();
  // Supersede every still-live invocation first (committed before the kill) so
  // the dying cli-exec job's resume is a no-op and can't clobber the caller's
  // terminal state.
  const active = await db
    .select({ id: schema.cliInvocations.id })
    .from(schema.cliInvocations)
    .where(
      and(
        eq(schema.cliInvocations.taskId, taskId),
        isNull(schema.cliInvocations.endedAt),
        isNull(schema.cliInvocations.supersededAt),
      ),
    );
  for (const inv of active) {
    await db
      .update(schema.cliInvocations)
      .set({
        exitCode: 137,
        errorMessage: 'CLI cancelled by user',
        endedAt: now,
        supersededAt: now,
      })
      .where(eq(schema.cliInvocations.id, inv.id));
  }
  // Fail whatever step is stuck in running/waiting_cli. This covers BOTH a CLI
  // step (whose invocation we just superseded) AND a frozen deterministic step
  // with no live invocation — otherwise un-stoppable because there is nothing
  // in cli_invocations to cancel. Steps run one-at-a-time per task, so this only
  // ever hits the single active step.
  const stopped = await db
    .update(schema.taskSteps)
    .set({
      status: 'failed',
      errorMessage: 'Stopped by user',
      endedAt: now,
      statusMessage: null,
      // Fold an outstanding park into idle_ms before closing the row — see the same fold in
      // cancelTaskRow (api/lib/cancel-task.ts) for why stamping ended_at alone silently turns
      // a recorded park back into work, and why the int4 clamp is load-bearing.
      // Caveat accepted: a step re-entered from waiting_cli keeps that status through its
      // apply phase (step-runner.ts only flips pending -> running), so stopping mid-apply
      // books that sliver as idle. Apply windows are sub-minute here (777 such rows total
      // 0.04h) against multi-hour parks, so the trade is strongly net-correct.
      idleMs: sql`${schema.taskSteps.idleMs} + least(2147483647 - ${schema.taskSteps.idleMs},
        greatest(0, floor(extract(epoch from (now() - ${schema.taskSteps.waitingStartedAt})) * 1000)))::int`,
      waitingStartedAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.taskSteps.taskId, taskId),
        inArray(schema.taskSteps.status, ['running', 'waiting_cli']),
      ),
    )
    .returning({ id: schema.taskSteps.id });
  if (opts.failTask && (active.length > 0 || stopped.length > 0)) {
    // Drop the task to `failed` (restartable) from any non-terminal state — incl.
    // `waiting_user`, which a half-finished step transition can leave behind.
    await db
      .update(schema.tasks)
      .set({ status: 'failed', errorMessage: 'Stopped by user', updatedAt: now })
      .where(
        and(
          eq(schema.tasks.id, taskId),
          inArray(schema.tasks.status, ['running', 'queued', 'waiting_user']),
        ),
      );
  }
  // Force-remove the cli sandboxes AFTER the supersede writes commit, so the
  // dying job's resume sees the superseded row and skips its advance. Narrowed
  // to `haive-cli-*` (sandbox-kill.ts) so the DDEV/app runtime survives.
  const killed = await killTaskSandboxes(taskId);
  return { killed, cancelled: active.length, stopped: stopped.length };
}

taskRoutes.post('/:id/action', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const body = taskActionRequestSchema.parse(await c.req.json());
  const db = getDb();

  const task = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, id), eq(schema.tasks.userId, userId)),
  });
  if (!task) throw new HttpError(404, 'Task not found');

  switch (body.action) {
    case 'cancel':
      if (task.status === 'completed' || task.status === 'cancelled') {
        return c.json({ ok: true, status: task.status });
      }
      // Stop any still-running CLI first (supersede its invocation) so the dying
      // cli-exec job's resume is a no-op and can't clobber `cancelled` back to
      // `failed` — otherwise Cancel needs two clicks. Then cancel + enqueue the
      // full teardown job (tears down the DDEV/app runtime too).
      await stopActiveCliInvocations(db, id, { failTask: false });
      await cancelTaskRow(db, id, { by: userId });
      await enqueueCancelJob(id, userId);
      return c.json({ ok: true, status: 'cancelled' });
    case 'retry':
      if (task.status !== 'failed') {
        throw new HttpError(409, `Cannot retry task in status ${task.status}`);
      }
      await db
        .update(schema.tasks)
        .set({
          status: 'queued',
          errorMessage: null,
          // full task restart → fresh auto-resume budget
          allowanceAutoResumeCount: 0,
          updatedAt: new Date(),
        })
        .where(eq(schema.tasks.id, id));
      await appendTaskEvent(db, id, null, 'task.retried', { by: userId });
      await getTaskQueue().add(TASK_JOB_NAMES.START, { taskId: id, userId } as TaskJobPayload, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      });
      return c.json({ ok: true, status: 'queued' });
    default:
      throw new HttpError(400, 'Unknown action');
  }
});

taskRoutes.post('/:id/cancel-active-cli', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  const task = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, id), eq(schema.tasks.userId, userId)),
    columns: { id: true },
  });
  if (!task) throw new HttpError(404, 'Task not found');

  // Stop the running CLI (supersede its invocation, fail the step + task) and
  // force-remove only the cli sandboxes — the DDEV/app runtime is left running.
  const { killed, cancelled, stopped } = await stopActiveCliInvocations(db, id, { failTask: true });
  logger.info({ taskId: id, killed, cancelled, stopped }, 'cancel-active-cli');
  return c.json({ ok: true, killed, cancelled, stopped });
});

/** Max steer message length. Bounds the NDJSON line written to the CLI's stdin
 *  and the task_events payload. */
const STEER_TEXT_MAX = 8192;

/** Mid-run steering: deliver a user nudge to the active steerable CLI invocation
 *  (published to its steer channel; the worker writes it to the CLI's stdin as
 *  an NDJSON user-message, applied at the next tool-call boundary) AND persist it
 *  as a `steering.nudge` task_event so KB mining learns from the course-correction. */
taskRoutes.post('/:id/steer-active-cli', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as {
    text?: unknown;
    invocationId?: unknown;
    steerId?: unknown;
  };
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  // Client-generated id, echoed back on the consumed frame so the viewer ticks
  // the exact list row (correlates by id, not text — so duplicate-text steers
  // tick the right rows).
  const steerId = typeof body.steerId === 'string' ? body.steerId : '';
  if (!text) throw new HttpError(400, 'steer text required');
  if (text.length > STEER_TEXT_MAX) {
    throw new HttpError(400, `steer text too long (max ${STEER_TEXT_MAX} chars)`);
  }
  const db = getDb();
  const task = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, id), eq(schema.tasks.userId, userId)),
    columns: { id: true },
  });
  if (!task) throw new HttpError(404, 'Task not found');

  // Target the specific invocation the viewer is showing — a multi-agent step has
  // many live invocations, so "the active one" is ambiguous. Fall back to the
  // most-recent active invocation when the caller doesn't pass an id.
  const invocationId = typeof body.invocationId === 'string' ? body.invocationId : null;
  let active: { id: string; taskStepId: string | null; steerable: boolean } | null;
  if (invocationId) {
    const inv = await db.query.cliInvocations.findFirst({
      where: and(eq(schema.cliInvocations.id, invocationId), eq(schema.cliInvocations.taskId, id)),
      columns: { id: true, taskStepId: true, steerable: true, endedAt: true },
    });
    if (!inv) throw new HttpError(404, 'CLI invocation not found');
    if (inv.endedAt) throw new HttpError(409, 'This CLI run already finished');
    active = { id: inv.id, taskStepId: inv.taskStepId, steerable: inv.steerable };
  } else {
    active = await findActiveCliInvocation(db, id);
  }
  if (!active) throw new HttpError(409, 'No active CLI invocation to steer');
  if (!active.steerable) throw new HttpError(409, 'This CLI run is not steerable');

  // Round correlates the steer to the fix/revision round in the mining digest.
  let round = 0;
  if (active.taskStepId) {
    const step = await db.query.taskSteps.findFirst({
      where: eq(schema.taskSteps.id, active.taskStepId),
      columns: { round: true },
    });
    round = step?.round ?? 0;
  }

  // Deliver to the worker forwarder (it writes the NDJSON user-message to stdin).
  // The channel payload is JSON {id,text}; the forwarder writes only the text and
  // uses the id to report consumption back to the viewer.
  await getRedis().publish(
    `${STEER_IN_CHANNEL_PREFIX}${active.id}`,
    JSON.stringify({ id: steerId, text }),
  );
  // Persist as a mineable friction signal (the learning step grounds in these).
  await appendTaskEvent(db, id, active.taskStepId, 'steering.nudge', {
    text,
    targetStepId: active.taskStepId,
    round,
    source: 'ui',
  });
  logger.info({ taskId: id, invocationId: active.id }, 'steer-active-cli');
  return c.json({ ok: true, invocationId: active.id });
});

/** Static replay endpoint for an ended CLI invocation. Live invocations should
 *  use the WS stream at /cli-stream/:invocationId — this returns the persisted
 *  rawOutput once endedAt is set. Returns the raw column even for active rows
 *  so the caller can render whatever has flushed to the DB so far without
 *  having to upgrade to WS. */
taskRoutes.get('/:id/cli-invocations/:invocationId/output', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const invocationId = c.req.param('invocationId');
  const db = getDb();
  const task = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, id), eq(schema.tasks.userId, userId)),
    columns: { id: true },
  });
  if (!task) throw new HttpError(404, 'Task not found');
  const inv = await db.query.cliInvocations.findFirst({
    where: and(eq(schema.cliInvocations.id, invocationId), eq(schema.cliInvocations.taskId, id)),
    columns: {
      id: true,
      rawOutput: true,
      streamLog: true,
      exitCode: true,
      errorMessage: true,
      endedAt: true,
      durationMs: true,
    },
  });
  if (!inv) throw new HttpError(404, 'CLI invocation not found');
  // Prefer the full live-stream transcript when present; fall back to the
  // parsed result text on rows written before stream_log existed so the
  // historical replay still shows something meaningful.
  return c.json({
    id: inv.id,
    // Raw tab: the full live-stream transcript (header + NDJSON + stderr); fall
    // back to the parsed result on legacy rows written before stream_log existed.
    streamLog: inv.streamLog ?? inv.rawOutput ?? '',
    // Clean tab: the model's parsed prose (assistant text / agent_message).
    cleanOutput: inv.rawOutput ?? '',
    exitCode: inv.exitCode,
    errorMessage: inv.errorMessage,
    durationMs: inv.durationMs,
    isActive: inv.endedAt === null,
  });
});

taskRoutes.patch('/:id/cli-provider', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const body = setCliProviderRequestSchema.parse(await c.req.json());
  const db = getDb();

  const task = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, id), eq(schema.tasks.userId, userId)),
  });
  if (!task) throw new HttpError(404, 'Task not found');
  if (task.status === 'completed' || task.status === 'cancelled') {
    throw new HttpError(409, `Cannot change provider for ${task.status} task`);
  }

  if (body.cliProviderId) {
    const provider = await db.query.cliProviders.findFirst({
      where: and(
        eq(schema.cliProviders.id, body.cliProviderId),
        eq(schema.cliProviders.userId, userId),
      ),
    });
    if (!provider) throw new HttpError(404, 'CLI provider not found');
    if (!provider.enabled) {
      throw new HttpError(409, 'CLI provider is disabled');
    }
  }

  await db
    .update(schema.tasks)
    .set({
      cliProviderId: body.cliProviderId,
      updatedAt: new Date(),
    })
    .where(eq(schema.tasks.id, id));

  await appendTaskEvent(db, id, null, 'task.cli_provider_changed', {
    cliProviderId: body.cliProviderId,
    by: userId,
  });

  // Invalidate cached detect output on provider-sensitive steps so the next
  // advance re-detects against the new CLI's metadata (skills dir, agents
  // dir, etc.). Terminal (done/failed/skipped/cancelled) steps are left
  // alone — rewriting history would be confusing. form_values is preserved
  // so the user's prior submission flows into the regenerated schema.
  // Select the steps to invalidate first, so each finishing run's timing can be folded
  // into carried_* before zeroing (mirrors the retry / worker reset — a plain reset
  // discards the prior run and undercounts effort). foldSit counts a failed step's
  // fail->retry wait as idle. Per-row update because each contributes differently; this
  // path also zeroes user_active_ms (the old blanket update omitted it, leaving a stale
  // value that the fold now carries over correctly).
  const invalidated = await db
    .select()
    .from(schema.taskSteps)
    .where(
      and(
        eq(schema.taskSteps.taskId, id),
        inArray(schema.taskSteps.stepId, [...PROVIDER_SENSITIVE_STEP_IDS]),
        inArray(schema.taskSteps.status, ['pending', 'running', 'waiting_form', 'waiting_cli']),
      ),
    );
  const invalidateNow = new Date();
  for (const r of invalidated) {
    // computeFoldContribution, not computeStepContribution: the filter above includes `running`,
    // so a step orphaned by a worker restart (started_at set, ended_at null) would otherwise
    // carry its whole dead start->now span into carried_work_ms. It applies foldSit for a
    // failed step internally, so behaviour is unchanged for every closed row. This is the same
    // fix 79d5bac made at the other three fold sites (_step-reset.ts, steps.ts retry and
    // per-step switch-cli); this task-level provider switch was missed.
    const contrib = computeFoldContribution(r, invalidateNow.getTime());
    await db
      .update(schema.taskSteps)
      .set({
        status: 'pending',
        detectOutput: null,
        formSchema: null,
        statusMessage: null,
        startedAt: null,
        endedAt: null,
        errorMessage: null,
        idleMs: 0,
        waitingStartedAt: null,
        userActiveMs: 0,
        carriedWorkMs: r.carriedWorkMs + contrib.workMs,
        carriedIdleMs: r.carriedIdleMs + contrib.idleMs,
        carriedUserActiveMs: r.carriedUserActiveMs + contrib.userActiveMs,
        updatedAt: invalidateNow,
      })
      .where(eq(schema.taskSteps.id, r.id));
  }

  if (invalidated.length > 0) {
    await appendTaskEvent(db, id, null, 'task.provider_sensitive_steps_invalidated', {
      stepIds: invalidated.map((r) => r.stepId),
      cliProviderId: body.cliProviderId,
    });
  }

  return c.json({
    ok: true,
    cliProviderId: body.cliProviderId,
    invalidatedSteps: invalidated.map((r) => r.stepId),
  });
});

taskRoutes.get('/:id/events', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  const task = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, id), eq(schema.tasks.userId, userId)),
    columns: { id: true },
  });
  if (!task) throw new HttpError(404, 'Task not found');
  const events = await db
    .select()
    .from(schema.taskEvents)
    .where(eq(schema.taskEvents.taskId, id))
    .orderBy(asc(schema.taskEvents.createdAt));
  return c.json({ events });
});

// Step submit/action/skip + per-step CLI routes. Mounted at '/' so the
// sub-router registers the same full `/:id/steps/...` paths as before.
taskRoutes.route('/', stepRoutes);

// Workspace browse/read/download routes. Mounted at '/' so the sub-router
// registers the same full `/:id/files...` paths as before.
taskRoutes.route('/', fileRoutes);

// Direct browser-access routes (/:id/access-urls, /:id/ddev-ca): open the task's
// running app in your own browser as a fast alternative to the VNC pixel stream.
taskRoutes.route('/', browserAccessRoutes);

// Task file attachments (/:id/attachments...): user-uploaded reference files the
// AI CLI agent reads from the task workspace.
taskRoutes.route('/', attachmentRoutes);
