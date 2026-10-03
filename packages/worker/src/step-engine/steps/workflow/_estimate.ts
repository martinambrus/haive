import { and, desc, eq, inArray, like, ne, or, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { computeTaskTiming, type TaskTimingStep } from '@haive/shared/timing';

// Shared building blocks for the task-effort estimator, used by BOTH the pre-flight
// estimate step (00b-estimate) and the post-planning refinement folded into
// 06b-sprint-planning. The target metric is EFFORT (agent work + user-active), matching
// computeTaskTiming and the completion verdict card. Kept framework-free (a db handle +
// pure functions) so either caller can reuse it without a circular step import.

/** Ceiling on how many prior tasks to gather as anchors. */
export const MAX_ANCHORS = 30;
/** Bound task-id IN clauses well below PostgreSQL's bind-parameter ceiling. */
const TASK_LOOKUP_BATCH_SIZE = 500;
/** Per-anchor description budget when an anchor is rendered into a prompt / panel. */
export const ANCHOR_DESC_CAP = 240;
/** Require several measured runs before replacing the broader-history baseline. */
export const MIN_PATH_ANCHORS = 3;

/** Multiplier applied to the median anchor effort per triage path in the heuristic
 *  fallback: a quick bugfix is lighter than the median task, the full workflow heavier. */
export const PATH_SCALE: Record<string, number> = {
  quick_bugfix: 0.5,
  plan_tasklist: 1.0,
  full_workflow: 1.5,
};
/** Cold-start baseline (decimal hours) when the repo has NO usable prior-task anchors —
 *  a sane per-path default until real actuals accrue. */
export const FALLBACK_HOURS: Record<string, number> = {
  quick_bugfix: 0.5,
  plan_tasklist: 2,
  full_workflow: 6,
};
/** Same (>0, 1000] envelope the shared task schema enforces on estimated_time_hours. */
export const MIN_HOURS = 0.05;
export const MAX_HOURS = 1000;

export interface EstimateAnchor {
  title: string;
  description: string;
  executionPath: string | null;
  /** Fix-loop rounds the task needed (0 = clean first pass); a complexity proxy. */
  fixRounds: number;
  /** MEASURED effort = (work + user-active) ms / 3.6e6, rounded to 2 decimals. */
  effortHours: number;
  /** This task's own prior AI estimate + confirmed estimate, when present, so a caller
   *  can show the model where past estimates missed. Null before this feature. */
  aiEstimateHours: number | null;
  confirmedEstimateHours: number | null;
  /** The files the task changed — the overlap signal ("touches the same feature"). */
  changedPaths: string[];
  /** True when this anchor came from ANOTHER repository (same user, same detected
   *  framework) as a cold-start fallback, not from this repo's own history. Cross-repo
   *  anchors seed the heuristic / range when local history is thin, but are excluded from
   *  the per-repo bias factor and file-overlap refinement (both of which are local-only
   *  signals — a matching path or a prior estimate from a different repo is coincidental). */
  crossRepo: boolean;
}

export function clampHours(n: number): number {
  return Math.min(MAX_HOURS, Math.max(MIN_HOURS, n));
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Effort in hours for one prior task from its step rows, via the SAME pure timing
 *  function the api/web use so the anchor matches the verdict card's actual.
 *
 *  `nowMs` must be the task's EFFECTIVE now — its completedAt when terminal, the wall clock
 *  only while it is still live. Do NOT assume a terminal task has no open steps: rows left
 *  open by a cancel/crash exist (20 of them in this database), and each one bills
 *  start->nowMs as work, so passing a bare Date.now() inflates an anchor's effort without
 *  bound and biases every later estimate off it. */
export function effortHoursFromSteps(steps: TaskTimingStep[], nowMs: number): number {
  const t = computeTaskTiming(steps, nowMs);
  return round2((t.workMs + t.userActiveMs) / 3_600_000);
}

export function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  // Guarded non-empty above, so mid and mid-1 are valid indices; the assertions satisfy
  // noUncheckedIndexedAccess without masking a real out-of-bounds.
  const hi = sorted[mid]!;
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + hi) / 2 : hi;
}

/** Prefer local same-path effort, then same-path cold-start anchors, when sufficiently
 *  sampled. With sparse/unknown path history, retain the broader-history fallback. */
function effortAnchors(
  anchors: EstimateAnchor[],
  path: string | null,
  minimum = MIN_PATH_ANCHORS,
): { anchors: EstimateAnchor[]; samePath: boolean } {
  const usable = anchors.filter((a) => a.effortHours > 0);
  const matching = path ? usable.filter((a) => a.executionPath === path) : [];
  const local = matching.filter((a) => !a.crossRepo);
  if (local.length >= minimum) return { anchors: local, samePath: true };
  if (matching.length >= minimum) return { anchors: matching, samePath: true };
  return { anchors: usable, samePath: false };
}

/** Same-path measured effort needs no path multiplier: it already includes that path's
 *  planning/review work. Scale only the broader-history fallback. */
export function heuristicEstimate(
  anchors: EstimateAnchor[],
  path: string | null,
): { hours: number; reason: string } {
  const selected = effortAnchors(anchors, path);
  const scale = selected.samePath ? 1 : (PATH_SCALE[path ?? ''] ?? 1.0);
  const efforts = selected.anchors.map((a) => a.effortHours);
  if (efforts.length === 0) {
    const hours = FALLBACK_HOURS[path ?? ''] ?? 2;
    return {
      hours: clampHours(hours),
      reason: `No prior completed tasks to learn from — using the ${
        path ?? 'default'
      } path baseline of ${hours}h.`,
    };
  }
  const hours = clampHours(round2(median(efforts) * scale));
  return {
    hours,
    reason: selected.samePath
      ? `Median effort of ${efforts.length} prior ${path} task(s) (${round2(median(efforts))}h); no path scaling needed.`
      : `Sparse or unknown same-path history — median effort of ${efforts.length} broader prior task(s) (${round2(median(efforts))}h) scaled ${scale}x for the ${path ?? 'default'} path.`,
  };
}

/** Below this many usable LOCAL anchors a repo is treated as cold-start, and buildAnchors
 *  supplements from the same user's other same-framework repos (see buildColdStartAnchors). */
export const COLD_START_MIN_ANCHORS = 3;

/** The task columns an anchor is built from. Shared by the local + cross-repo queries. */
const PRIOR_TASK_COLUMNS = {
  id: true,
  title: true,
  description: true,
  executionPath: true,
  currentRound: true,
  changedPaths: true,
  aiEstimatedTimeHours: true,
  estimatedTimeHours: true,
  // Needed to cap each anchor's timing at ITS completion instant — see effortHoursFromSteps.
  completedAt: true,
} as const;

interface PriorTaskRow {
  id: string;
  title: string;
  description: string | null;
  executionPath: string | null;
  currentRound: number | null;
  changedPaths: string[] | null;
  aiEstimatedTimeHours: number | null;
  estimatedTimeHours: number | null;
  completedAt: Date | null;
}

/** One measurement path for hydration and semantic-result eligibility. */
async function measuredEfforts(db: Database, priors: PriorTaskRow[]): Promise<Map<string, number>> {
  if (priors.length === 0) return new Map();
  const priorIds = priors.map((p) => p.id);
  const stepRows = await db.query.taskSteps.findMany({
    where: inArray(schema.taskSteps.taskId, priorIds),
    columns: {
      taskId: true,
      startedAt: true,
      endedAt: true,
      idleMs: true,
      userActiveMs: true,
      waitingStartedAt: true,
      status: true,
      carriedWorkMs: true,
      carriedIdleMs: true,
      carriedUserActiveMs: true,
    },
  });
  const stepsByTask = new Map<string, TaskTimingStep[]>();
  for (const s of stepRows) {
    const list = stepsByTask.get(s.taskId) ?? [];
    list.push(s as TaskTimingStep);
    stepsByTask.set(s.taskId, list);
  }

  const nowMs = Date.now();
  const efforts = new Map<string, number>();
  for (const p of priors) {
    // Cap at THIS anchor's completion instant, not the shared wall clock.
    const effortHours = effortHoursFromSteps(
      stepsByTask.get(p.id) ?? [],
      p.completedAt ? p.completedAt.getTime() : nowMs,
    );
    if (effortHours > 0) efforts.set(p.id, effortHours);
  }
  return efforts;
}

/** Turn prior task rows into anchors, dropping any with no measurable effort. */
async function hydrateAnchors(
  db: Database,
  priors: PriorTaskRow[],
  crossRepo: boolean,
): Promise<EstimateAnchor[]> {
  const efforts = await measuredEfforts(db, priors);
  const anchors: EstimateAnchor[] = [];
  for (const p of priors) {
    const effortHours = efforts.get(p.id);
    if (effortHours == null) continue;
    anchors.push({
      title: p.title,
      description: (p.description ?? '').trim().slice(0, ANCHOR_DESC_CAP),
      executionPath: p.executionPath ?? null,
      fixRounds: p.currentRound ?? 0,
      effortHours,
      aiEstimateHours: p.aiEstimatedTimeHours ?? null,
      confirmedEstimateHours: p.estimatedTimeHours ?? null,
      changedPaths: p.changedPaths ?? [],
      crossRepo,
    });
  }
  return anchors;
}

/** Apply an anchor budget after measurement, walking preferred rows in bounded batches.
 *  Unmeasured rows must not consume the budget and hide useful later candidates. */
async function hydrateAnchorBudget(
  db: Database,
  priors: PriorTaskRow[],
  crossRepo: boolean,
  limit: number,
): Promise<EstimateAnchor[]> {
  const anchors: EstimateAnchor[] = [];
  for (let offset = 0; anchors.length < limit && offset < priors.length; offset += MAX_ANCHORS) {
    anchors.push(
      ...(await hydrateAnchors(db, priors.slice(offset, offset + MAX_ANCHORS), crossRepo)),
    );
  }
  return anchors.slice(0, limit);
}

/** Fetch the given prior task rows (validated: same repo, completed workflow, not the current
 *  task) and return them in the SAME order as `ids` — the semantic ranking order that
 *  retrieveSimilarTaskIds produced. Ids that don't resolve to a valid anchor (a non-completed
 *  or other-repo id lingering in the vector store, or a stale id) are dropped. */
async function fetchPreferredTaskRows(
  db: Database,
  taskId: string,
  repositoryId: string,
  ids: string[],
): Promise<PriorTaskRow[]> {
  if (ids.length === 0) return [];
  const byId = new Map<string, PriorTaskRow>();
  for (let offset = 0; offset < ids.length; offset += TASK_LOOKUP_BATCH_SIZE) {
    const rows = await db.query.tasks.findMany({
      where: and(
        inArray(schema.tasks.id, ids.slice(offset, offset + TASK_LOOKUP_BATCH_SIZE)),
        eq(schema.tasks.repositoryId, repositoryId),
        eq(schema.tasks.type, 'workflow'),
        eq(schema.tasks.status, 'completed'),
        ne(schema.tasks.id, taskId),
      ),
      columns: PRIOR_TASK_COLUMNS,
    });
    for (const row of rows) byId.set(row.id, row);
  }
  return ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => r !== undefined);
}

/** Validate and measure a bounded semantic-result page against the application DB.
 *  Return ids in retrieval order, excluding stale, foreign or unmeasured rows. */
export async function measuredPriorTaskIds(
  db: Database,
  taskId: string,
  repositoryId: string,
  ids: string[],
): Promise<string[]> {
  const priors = await fetchPreferredTaskRows(db, taskId, repositoryId, ids);
  const efforts = await measuredEfforts(db, priors);
  return [...new Set(ids)].filter((id) => efforts.has(id));
}

/**
 * Prior tasks near this one in the PROJECT PLAN, closest first.
 *
 * For `00b-estimate`, which runs at index 0.6 — before 04-phase-0b exists, so
 * `affectedComponents` is not available. `plan_node_tasks` rows are, because the
 * create-task endpoint writes them at task INSERT; `loadFromTaskLinks` in
 * `_plan-impact.ts` falls back to the same source for the same reason.
 *
 * Origins are the `implements` links ONLY. `touched` is written by the spec writer's
 * affected-components pass and is a statement about blast radius, not about what the task
 * is: MEASURED on a live plan, one task carried 358 `touched` rows against a 543-node plan,
 * so seeding proximity from those would reach most of the project.
 *
 * Two tiers, each newest-completed first:
 *   1. tasks implementing the SAME node;
 *   2. tasks implementing a node in the same PARENT's subtree — one prefix predicate, which
 *      `plan_nodes.path` supports directly (self-inclusive and slash-terminated, so the
 *      match is structural rather than accidentally correct). Covers siblings and their
 *      descendants without a third tier nothing has measured.
 *
 * A task can implement SEVERAL nodes (measured: 5 on one task), so the origin is a set.
 * Best-effort: any failure returns [] and the caller keeps the ordering it already had.
 */
export async function planProximityTaskIds(
  db: Database,
  taskId: string,
  repositoryId: string,
  executionPath: string | null = null,
): Promise<string[]> {
  const origins = await db
    .select({ nodeId: schema.planNodeTasks.nodeId, path: schema.planNodes.path })
    .from(schema.planNodeTasks)
    .innerJoin(schema.planNodes, eq(schema.planNodes.id, schema.planNodeTasks.nodeId))
    .where(
      and(
        eq(schema.planNodeTasks.taskId, taskId),
        eq(schema.planNodeTasks.role, 'implements'),
        eq(schema.planNodes.repositoryId, repositoryId),
      ),
    );
  if (origins.length === 0) return [];

  // The parent's subtree = this node's path with its own last segment removed. The path is
  // '/root/…/self/', so dropping the final segment yields the parent prefix every sibling
  // (and every sibling's descendant) also starts with.
  const parentPrefixes = [
    ...new Set(origins.map((o) => o.path.replace(/[^/]+\/$/, '')).filter((p) => p.length > 1)),
  ];
  const nodeIds = origins.map((o) => o.nodeId);

  const rows = await db
    .select({
      taskId: schema.planNodeTasks.taskId,
      nodeId: schema.planNodeTasks.nodeId,
      path: schema.planNodes.path,
      completedAt: schema.tasks.completedAt,
      executionPath: schema.tasks.executionPath,
    })
    .from(schema.planNodeTasks)
    .innerJoin(schema.planNodes, eq(schema.planNodes.id, schema.planNodeTasks.nodeId))
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.planNodeTasks.taskId))
    .where(
      and(
        eq(schema.planNodeTasks.role, 'implements'),
        eq(schema.planNodes.repositoryId, repositoryId),
        eq(schema.tasks.repositoryId, repositoryId),
        eq(schema.tasks.type, 'workflow'),
        eq(schema.tasks.status, 'completed'),
        ne(schema.planNodeTasks.taskId, taskId),
        parentPrefixes.length > 0
          ? or(
              inArray(schema.planNodeTasks.nodeId, nodeIds),
              ...parentPrefixes.map((prefix) => like(schema.planNodes.path, `${prefix}%`)),
            )
          : inArray(schema.planNodeTasks.nodeId, nodeIds),
      ),
    );

  // The anchor builder applies its budget after timing hydration. Returning the whole
  // ordered candidate set prevents unmeasured plan rows from hiding measured matches.
  return rankPlanProximity(rows, nodeIds, executionPath, rows.length);
}

/** One (task, node) row as the proximity query returns it. */
export interface PlanProximityRow {
  taskId: string;
  nodeId: string;
  completedAt: Date | null;
  executionPath?: string | null;
}

/**
 * Rank proximity rows: current execution path first when known, then same-node tier
 * and newest-completed within a tier. Partition before applying the result budget.
 *
 * Split out as a pure function because the query around it can only be exercised against a
 * live database, while this is where the ordering rules actually live.
 *
 * One entry per TASK. A task implementing several nodes in range produces several rows, and
 * it must be ranked by the CLOSEST tier it reached — not by how many nodes happened to match,
 * which would let a task linked to a dozen distant nodes outrank one that implements exactly
 * the node in hand.
 */
export function rankPlanProximity(
  rows: PlanProximityRow[],
  sameNodeIds: string[],
  executionPath: string | null = null,
  limit = MAX_ANCHORS,
): string[] {
  const sameNode = new Set(sameNodeIds);
  const best = new Map<string, { tier: number; at: number; samePath: boolean }>();
  for (const r of rows) {
    const tier = sameNode.has(r.nodeId) ? 0 : 1;
    const at = r.completedAt ? r.completedAt.getTime() : 0;
    const prev = best.get(r.taskId);
    if (!prev || tier < prev.tier || (tier === prev.tier && at > prev.at)) {
      best.set(r.taskId, {
        tier,
        at,
        samePath: executionPath != null && r.executionPath === executionPath,
      });
    }
  }
  return [...best.entries()]
    .sort(
      (a, b) =>
        Number(b[1].samePath) - Number(a[1].samePath) || a[1].tier - b[1].tier || b[1].at - a[1].at,
    )
    .slice(0, limit)
    .map(([id]) => id);
}

/**
 * Prior tasks that actually changed any of `paths`, best overlap first.
 *
 * For `06b`'s post-planning refinement, which knows the files the planner predicted.
 * `overlapRefinedEstimate` scores anchors by exactly this overlap and needs
 * `MIN_OVERLAP_ANCHORS` of them, but it can only score what `buildAnchors` handed it — and
 * that was the newest `MAX_ANCHORS` tasks, which excludes the tasks that touched these files
 * whenever they are not also among the most recent. This is the candidate query that stops
 * that; the SCORING stays in `overlapRefinedEstimate`, so the count computed here only orders
 * the selection.
 *
 * `tasks.changed_paths` is `jsonb` (not `text[]`), so the predicate is the jsonb
 * "contains any of these strings" operator `?|`, not the array overlap operator `&&`. The
 * path list goes through `sql.param` because drizzle expands a bare `${array}` into a
 * parenthesised record — `?|` wants ONE text[] parameter, and the record form fails with
 * "cannot cast type record to text[]".
 *
 * No row cap: an arbitrary bound on the candidate pool is the bug being fixed. Matching rows
 * are relevant by definition, and each row's `changed_paths` is already capped when written.
 */
export async function fileOverlapTaskIds(
  db: Database,
  taskId: string,
  repositoryId: string,
  paths: string[],
  executionPath: string | null = null,
): Promise<string[]> {
  if (paths.length === 0) return [];
  const rows = await db
    .select({
      id: schema.tasks.id,
      executionPath: schema.tasks.executionPath,
      changedPaths: schema.tasks.changedPaths,
      completedAt: schema.tasks.completedAt,
    })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.repositoryId, repositoryId),
        eq(schema.tasks.type, 'workflow'),
        eq(schema.tasks.status, 'completed'),
        ne(schema.tasks.id, taskId),
        sql`${schema.tasks.changedPaths} ?| ${sql.param(paths)}::text[]`,
      ),
    );
  const wanted = new Set(paths);
  return rows
    .map((r) => ({
      id: r.id,
      samePath: executionPath != null && r.executionPath === executionPath,
      overlap: (r.changedPaths ?? []).filter((p) => wanted.has(p)).length,
      at: r.completedAt ? r.completedAt.getTime() : 0,
    }))
    .filter((r) => r.overlap > 0)
    .sort((a, b) => Number(b.samePath) - Number(a.samePath) || b.overlap - a.overlap || b.at - a.at)
    .map((r) => r.id);
}

/** Gather the anchor set: the repository's prior COMPLETED workflow tasks with their MEASURED
 *  effort (computeTaskTiming) and the files they changed. Same-type only — an onboarding's
 *  multi-hour run is not a workflow-effort anchor. `preferredTaskIds` (from 00b's stored
 *  semantic retrieval, most-similar first) are taken first, then topped up with the newest
 *  completed tasks not already chosen — so semantic selection degrades gracefully to
 *  newest-first when the vector store is empty/partial/unavailable (preferredTaskIds = [], the
 *  default and 06b's path). When the repo has fewer than COLD_START_MIN_ANCHORS local anchors,
 *  it is supplemented with cross-repo cold-start anchors from the same user's other
 *  same-framework repos. With an execution path, prefer same-path plan/semantic matches,
 *  then newest same-path runs (queried separately so older matches remain reachable).
 *  Once MIN_PATH_ANCHORS usable local matches exist, other paths are unnecessary;
 *  otherwise top up from broader history. A caller without a path keeps its original order. */
export async function buildAnchors(
  db: Database,
  taskId: string,
  repositoryId: string,
  preferredTaskIds: string[] = [],
  executionPath: string | null = null,
): Promise<EstimateAnchor[]> {
  const preferred = await fetchPreferredTaskRows(db, taskId, repositoryId, preferredTaskIds);
  const seen = new Set(preferred.map((p) => p.id));

  let matching: EstimateAnchor[] = [];
  if (executionPath) {
    const matchingPreferred = preferred.filter((p) => p.executionPath === executionPath);
    matching = await hydrateAnchorBudget(db, matchingPreferred, false, MAX_ANCHORS);
    // A page of completed rows is not a page of measured runs. Keep looking past
    // unmeasured rows until the same-path sample is sufficient or history is exhausted.
    for (let offset = 0; matching.length < MAX_ANCHORS; offset += MAX_ANCHORS) {
      const recentMatching = await db.query.tasks.findMany({
        where: and(
          eq(schema.tasks.repositoryId, repositoryId),
          eq(schema.tasks.type, 'workflow'),
          eq(schema.tasks.status, 'completed'),
          ne(schema.tasks.id, taskId),
          eq(schema.tasks.executionPath, executionPath),
        ),
        orderBy: [desc(schema.tasks.completedAt), desc(schema.tasks.id)],
        limit: MAX_ANCHORS,
        offset,
        columns: PRIOR_TASK_COLUMNS,
      });
      const unseen = recentMatching.filter((p) => !seen.has(p.id));
      for (const p of unseen) seen.add(p.id);
      matching.push(...(await hydrateAnchors(db, unseen, false)));
      matching = matching.slice(0, MAX_ANCHORS);
      if (matching.length >= MIN_PATH_ANCHORS || recentMatching.length < MAX_ANCHORS) break;
    }
    if (matching.length >= MIN_PATH_ANCHORS) return matching;
  }

  const local = [...matching];
  local.push(
    ...(await hydrateAnchorBudget(
      db,
      executionPath ? preferred.filter((p) => p.executionPath !== executionPath) : preferred,
      false,
      MAX_ANCHORS - local.length,
    )),
  );
  // Fill the MEASURED budget from broader local history before considering cross-repo
  // fallback, even if retrieval returned a full page of unmeasured completed rows.
  for (let offset = 0; local.length < MAX_ANCHORS; offset += MAX_ANCHORS) {
    const newest = await db.query.tasks.findMany({
      where: and(
        eq(schema.tasks.repositoryId, repositoryId),
        eq(schema.tasks.type, 'workflow'),
        eq(schema.tasks.status, 'completed'),
        ne(schema.tasks.id, taskId),
      ),
      orderBy: [desc(schema.tasks.completedAt), desc(schema.tasks.id)],
      limit: MAX_ANCHORS,
      offset,
      columns: PRIOR_TASK_COLUMNS,
    });
    const unseen = newest.filter((p) => !seen.has(p.id));
    for (const p of unseen) seen.add(p.id);
    local.push(...(await hydrateAnchors(db, unseen, false)));
    if (newest.length < MAX_ANCHORS) break;
  }
  const budgeted = local.slice(0, MAX_ANCHORS);
  if (budgeted.length >= COLD_START_MIN_ANCHORS) return budgeted;
  const cross = await buildColdStartAnchors(
    db,
    repositoryId,
    MAX_ANCHORS - budgeted.length,
    executionPath,
  );
  return [...budgeted, ...cross];
}

/** Cold-start fallback: anchors from the SAME user's OTHER repositories that share this
 *  repo's detected framework (a durable clone-time facet). Scoped to the same user so no
 *  cross-tenant data leaks, and to the same framework so the anchors are stack-comparable.
 *  Tagged crossRepo so downstream local-only signals (bias, overlap) exclude them. */
async function buildColdStartAnchors(
  db: Database,
  repositoryId: string,
  limit: number,
  executionPath: string | null,
): Promise<EstimateAnchor[]> {
  if (limit <= 0) return [];
  const repo = await db.query.repositories.findFirst({
    where: eq(schema.repositories.id, repositoryId),
    columns: { userId: true, detectedFramework: true },
  });
  if (!repo?.detectedFramework) return []; // no framework -> nothing stack-comparable to match
  const siblings = await db.query.repositories.findMany({
    where: and(
      eq(schema.repositories.userId, repo.userId),
      eq(schema.repositories.detectedFramework, repo.detectedFramework),
      ne(schema.repositories.id, repositoryId),
    ),
    columns: { id: true },
  });
  if (siblings.length === 0) return [];
  const repoIds = siblings.map((r) => r.id);
  const anchors: EstimateAnchor[] = [];
  const seen = new Set<string>();
  for (let offset = 0; anchors.length < limit; offset += MAX_ANCHORS) {
    const priors = await db.query.tasks.findMany({
      where: and(
        inArray(schema.tasks.repositoryId, repoIds),
        eq(schema.tasks.type, 'workflow'),
        eq(schema.tasks.status, 'completed'),
      ),
      orderBy: executionPath
        ? [
            sql`case when ${schema.tasks.executionPath} = ${executionPath} then 0 else 1 end`,
            desc(schema.tasks.completedAt),
            desc(schema.tasks.id),
          ]
        : [desc(schema.tasks.completedAt), desc(schema.tasks.id)],
      limit: MAX_ANCHORS,
      offset,
      columns: PRIOR_TASK_COLUMNS,
    });
    const unseen = priors.filter((p) => !seen.has(p.id));
    for (const p of unseen) seen.add(p.id);
    anchors.push(...(await hydrateAnchors(db, unseen, true)));
    if (priors.length < MAX_ANCHORS) break;
  }
  return anchors.slice(0, limit);
}

/** Post-planning refinement: once the task's likely files are known (the sprint plan's
 *  estimated_files), estimate effort deterministically from the prior tasks that ACTUALLY
 *  touched those files — "tasks that changed these files took X". Conservative: refines
 *  only when at least MIN_OVERLAP_ANCHORS prior tasks overlap, otherwise returns null so
 *  the caller keeps the description-level estimate rather than trusting one thin match. */
export const MIN_OVERLAP_ANCHORS = 2;

export function overlapRefinedEstimate(
  anchors: EstimateAnchor[],
  predictedFiles: string[],
  executionPath: string | null = null,
): { hours: number; overlapAnchors: number; matchedFiles: number } | null {
  if (predictedFiles.length === 0) return null;
  const predicted = new Set(predictedFiles);
  const scored = anchors
    // Local anchors only: a cross-repo anchor sharing a path string is coincidental, not
    // the same feature, so it must not drive this repo's file-overlap refinement.
    .filter((a) => !a.crossRepo)
    .map((a) => ({
      a,
      overlap: a.changedPaths.filter((p) => predicted.has(p)).length,
    }))
    .filter((s) => s.overlap > 0 && s.a.effortHours > 0)
    .sort((x, y) => y.overlap - x.overlap);
  if (scored.length < MIN_OVERLAP_ANCHORS) return null;
  const selected = effortAnchors(
    scored.map((s) => s.a),
    executionPath,
    MIN_OVERLAP_ANCHORS,
  );
  const hours = clampHours(round2(median(selected.anchors.map((a) => a.effortHours))));
  const matchedFiles = new Set(
    selected.anchors.flatMap((a) => a.changedPaths.filter((p) => predicted.has(p))),
  ).size;
  return { hours, overlapAnchors: selected.anchors.length, matchedFiles };
}

/** Minimum anchors carrying BOTH a prior AI estimate and a measured actual before a
 *  bias factor is trusted. */
export const MIN_BIAS_ANCHORS = 2;

/** Per-repo estimation bias: the median ratio of ACTUAL effort to the AI's own prior
 *  estimate across anchors that carry both. > 1 means the estimator historically ran
 *  UNDER (tasks took longer than predicted); < 1 means it ran over. Clamped to
 *  [0.25, 4] so a single outlier can't wildly skew a fresh estimate, and null until at
 *  least MIN_BIAS_ANCHORS tasks have an (estimate, actual) pair. Fed to the estimator as
 *  an explicit correction hint rather than post-multiplied, so the LLM (which also sees
 *  the raw pairs) does not double-correct. */
export function computeBiasFactor(
  anchors: EstimateAnchor[],
  executionPath: string | null = null,
): number | null {
  const ratios = anchors
    // Local anchors only — bias is THIS repo's estimator calibration; another repo's
    // (estimate, actual) pair is a different context and must not skew it.
    .filter(
      (a) =>
        !a.crossRepo &&
        a.aiEstimateHours != null &&
        a.aiEstimateHours > 0 &&
        a.effortHours > 0 &&
        (!executionPath || a.executionPath === executionPath),
    )
    .map((a) => a.effortHours / (a.aiEstimateHours as number));
  if (ratios.length < MIN_BIAS_ANCHORS) return null;
  return Math.min(4, Math.max(0.25, round2(median(ratios))));
}

/** Minimum anchors before a confidence range is offered. */
export const MIN_RANGE_ANCHORS = 3;

/** A p20/p80 effort band from the anchor tasks' ACTUAL effort — "tasks like this ran
 *  low..high". A confidence range around the point estimate, not a re-derivation of it.
 *  null until at least MIN_RANGE_ANCHORS anchors exist or when the band would collapse. */
export function estimateRange(
  anchors: EstimateAnchor[],
  executionPath: string | null = null,
): { low: number; high: number } | null {
  const selected = effortAnchors(anchors, executionPath, MIN_RANGE_ANCHORS);
  const scale = selected.samePath ? 1 : (PATH_SCALE[executionPath ?? ''] ?? 1);
  const efforts = selected.anchors
    .map((a) => a.effortHours)
    .filter((h) => h > 0)
    .sort((a, b) => a - b);
  if (efforts.length < MIN_RANGE_ANCHORS) return null;
  const pct = (p: number): number => {
    const idx = Math.min(
      efforts.length - 1,
      Math.max(0, Math.round((p / 100) * (efforts.length - 1))),
    );
    return efforts[idx]!;
  };
  const low = clampHours(round2(pct(20) * scale));
  const high = clampHours(round2(pct(80) * scale));
  return high > low ? { low, high } : null;
}
