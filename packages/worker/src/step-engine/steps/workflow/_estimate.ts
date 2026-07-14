import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { computeTaskTiming, type TaskTimingStep } from '@haive/shared/timing';

// Shared building blocks for the task-effort estimator, used by BOTH the pre-flight
// estimate step (00b-estimate) and the post-planning refinement folded into
// 06b-sprint-planning. The target metric is EFFORT (agent work + user-active), matching
// computeTaskTiming and the completion verdict card. Kept framework-free (a db handle +
// pure functions) so either caller can reuse it without a circular step import.

/** Ceiling on how many prior tasks to gather as anchors. */
export const MAX_ANCHORS = 30;
/** Per-anchor description budget when an anchor is rendered into a prompt / panel. */
export const ANCHOR_DESC_CAP = 240;

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
}

export function clampHours(n: number): number {
  return Math.min(MAX_HOURS, Math.max(MIN_HOURS, n));
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Effort in hours for one prior task from its step rows, via the SAME pure timing
 *  function the api/web use so the anchor matches the verdict card's actual. Completed
 *  tasks have no open steps, so nowMs only matters for the (excluded) live-wait branch. */
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

/** Deterministic baseline estimate: the median measured effort of the anchors scaled by
 *  the triage path, or a per-path cold-start constant when there are no anchors. */
export function heuristicEstimate(
  anchors: EstimateAnchor[],
  path: string | null,
): { hours: number; reason: string } {
  const scale = PATH_SCALE[path ?? ''] ?? 1.0;
  const efforts = anchors.map((a) => a.effortHours).filter((h) => h > 0);
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
    reason: `Median effort of ${efforts.length} prior task(s) (${round2(
      median(efforts),
    )}h) scaled ${scale}x for the ${path ?? 'default'} path.`,
  };
}

/** Gather the anchor set: the repository's prior COMPLETED workflow tasks (newest first,
 *  capped) with their MEASURED effort (computeTaskTiming) and the files they changed.
 *  Same-type only — an onboarding's multi-hour run is not a workflow-effort anchor. */
export async function buildAnchors(
  db: Database,
  taskId: string,
  repositoryId: string,
): Promise<EstimateAnchor[]> {
  const priors = await db.query.tasks.findMany({
    where: and(
      eq(schema.tasks.repositoryId, repositoryId),
      eq(schema.tasks.type, 'workflow'),
      eq(schema.tasks.status, 'completed'),
      ne(schema.tasks.id, taskId),
    ),
    orderBy: desc(schema.tasks.completedAt),
    limit: MAX_ANCHORS,
    columns: {
      id: true,
      title: true,
      description: true,
      executionPath: true,
      currentRound: true,
      changedPaths: true,
      aiEstimatedTimeHours: true,
      estimatedTimeHours: true,
    },
  });
  if (priors.length === 0) return [];

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
  const anchors: EstimateAnchor[] = [];
  for (const p of priors) {
    const effortHours = effortHoursFromSteps(stepsByTask.get(p.id) ?? [], nowMs);
    if (effortHours <= 0) continue; // no measurable effort — not a useful anchor
    anchors.push({
      title: p.title,
      description: (p.description ?? '').trim().slice(0, ANCHOR_DESC_CAP),
      executionPath: p.executionPath ?? null,
      fixRounds: p.currentRound ?? 0,
      effortHours,
      aiEstimateHours: p.aiEstimatedTimeHours ?? null,
      confirmedEstimateHours: p.estimatedTimeHours ?? null,
      changedPaths: p.changedPaths ?? [],
    });
  }
  return anchors;
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
): { hours: number; overlapAnchors: number; matchedFiles: number } | null {
  if (predictedFiles.length === 0) return null;
  const predicted = new Set(predictedFiles);
  const scored = anchors
    .map((a) => ({
      a,
      overlap: a.changedPaths.filter((p) => predicted.has(p)).length,
    }))
    .filter((s) => s.overlap > 0 && s.a.effortHours > 0)
    .sort((x, y) => y.overlap - x.overlap);
  if (scored.length < MIN_OVERLAP_ANCHORS) return null;
  const hours = clampHours(round2(median(scored.map((s) => s.a.effortHours))));
  const matchedFiles = new Set(
    scored.flatMap((s) => s.a.changedPaths.filter((p) => predicted.has(p))),
  ).size;
  return { hours, overlapAnchors: scored.length, matchedFiles };
}
