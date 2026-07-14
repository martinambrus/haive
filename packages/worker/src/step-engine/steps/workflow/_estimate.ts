import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { computeTaskTiming, type TaskTimingStep } from '@haive/shared/timing';
import { ollamaEmbed, probeOllama } from '@haive/shared/rag';

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
}

/** Turn prior task rows into anchors: join their step timing, compute MEASURED effort via
 *  computeTaskTiming, and drop any with no measurable effort. `crossRepo` tags the origin. */
async function hydrateAnchors(
  db: Database,
  priors: PriorTaskRow[],
  crossRepo: boolean,
): Promise<EstimateAnchor[]> {
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
      crossRepo,
    });
  }
  return anchors;
}

/** When a repo has MORE than MAX_ANCHORS completed tasks the anchor set must be SELECTED, not
 *  just "the newest 30". This is the candidate pool fetched for that selection: the newest N
 *  completed tasks are embedded and cosine-ranked against the new task, and the top
 *  MAX_ANCHORS are kept. Bounded so the one-shot embed at estimate time stays cheap. Below
 *  this many tasks selection is moot (every candidate fits), so no embedding ever happens. */
export const SEMANTIC_CANDIDATE_POOL = 100;

/** Opts enabling the semantic anchor-selection rerank. Absent => the estimator keeps the
 *  deterministic newest-first selection (the only behaviour below MAX_ANCHORS tasks, and the
 *  fallback whenever embeddings are unavailable). Resolved by 00b-estimate from the repo's
 *  RAG tooling prefs; kept as a minimal local shape to avoid importing the prefs type here. */
export interface SemanticRerankOpts {
  ollamaUrl: string;
  model: string;
  /** The new task's text (title + description) — the query candidates are ranked against. */
  queryText: string;
}

/** Cosine similarity of two equal-length vectors; 0 when either is empty, all-zero, or a
 *  dimension mismatch makes them incomparable. */
export function cosineSim(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Embed the candidate rows' title+description alongside the query and return them reordered
 *  most-similar-first. Best-effort: returns null (caller keeps newest-first) if embeddings are
 *  unavailable or the model returns an unexpected shape. The ollama probe/embed live here so
 *  they only ever run when there is actually an oversized pool to rank. */
async function semanticRankRows(
  rows: PriorTaskRow[],
  opts: SemanticRerankOpts,
): Promise<PriorTaskRow[] | null> {
  try {
    if (!(await probeOllama(opts.ollamaUrl))) return null;
    const texts = rows.map((r) => `${r.title}\n${(r.description ?? '').slice(0, ANCHOR_DESC_CAP)}`);
    const vectors = await ollamaEmbed(opts.ollamaUrl, opts.model, [opts.queryText, ...texts]);
    if (!Array.isArray(vectors) || vectors.length !== texts.length + 1) return null;
    const queryVec = vectors[0]!;
    return rows
      .map((r, i) => ({ r, sim: cosineSim(queryVec, vectors[i + 1]!) }))
      .sort((x, y) => y.sim - x.sim)
      .map((s) => s.r);
  } catch {
    return null;
  }
}

/** Gather the anchor set: the repository's prior COMPLETED workflow tasks with their MEASURED
 *  effort (computeTaskTiming) and the files they changed. Same-type only — an onboarding's
 *  multi-hour run is not a workflow-effort anchor. Selection is newest-first, EXCEPT when the
 *  pool exceeds MAX_ANCHORS and `semantic` opts are given, where the newest SEMANTIC_CANDIDATE_POOL
 *  are cosine-ranked against the new task and the most-similar MAX_ANCHORS kept. When the repo
 *  has fewer than COLD_START_MIN_ANCHORS local anchors, it is supplemented with cross-repo
 *  cold-start anchors from the same user's other same-framework repos. */
export async function buildAnchors(
  db: Database,
  taskId: string,
  repositoryId: string,
  semantic?: SemanticRerankOpts,
): Promise<EstimateAnchor[]> {
  // With semantic selection available, pull a larger candidate pool so there is something to
  // choose from; otherwise the newest MAX_ANCHORS is the whole set.
  const poolLimit = semantic ? SEMANTIC_CANDIDATE_POOL : MAX_ANCHORS;
  const localPriors = await db.query.tasks.findMany({
    where: and(
      eq(schema.tasks.repositoryId, repositoryId),
      eq(schema.tasks.type, 'workflow'),
      eq(schema.tasks.status, 'completed'),
      ne(schema.tasks.id, taskId),
    ),
    orderBy: desc(schema.tasks.completedAt),
    limit: poolLimit,
    columns: PRIOR_TASK_COLUMNS,
  });

  // Selection only matters once the pool exceeds the cap — the sole place an embed call is
  // made, so a small repo pays nothing. A null rerank (embeddings down) keeps newest-first.
  let selected: PriorTaskRow[] = localPriors;
  if (localPriors.length > MAX_ANCHORS) {
    const ranked = semantic ? await semanticRankRows(localPriors, semantic) : null;
    selected = (ranked ?? localPriors).slice(0, MAX_ANCHORS);
  }

  const local = await hydrateAnchors(db, selected, false);
  if (local.length >= COLD_START_MIN_ANCHORS) return local;
  const cross = await buildColdStartAnchors(db, repositoryId, MAX_ANCHORS - local.length);
  return [...local, ...cross];
}

/** Cold-start fallback: anchors from the SAME user's OTHER repositories that share this
 *  repo's detected framework (a durable clone-time facet). Scoped to the same user so no
 *  cross-tenant data leaks, and to the same framework so the anchors are stack-comparable.
 *  Tagged crossRepo so downstream local-only signals (bias, overlap) exclude them. */
async function buildColdStartAnchors(
  db: Database,
  repositoryId: string,
  limit: number,
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
  const priors = await db.query.tasks.findMany({
    where: and(
      inArray(schema.tasks.repositoryId, repoIds),
      eq(schema.tasks.type, 'workflow'),
      eq(schema.tasks.status, 'completed'),
    ),
    orderBy: desc(schema.tasks.completedAt),
    limit,
    columns: PRIOR_TASK_COLUMNS,
  });
  return hydrateAnchors(db, priors, true);
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
  const hours = clampHours(round2(median(scored.map((s) => s.a.effortHours))));
  const matchedFiles = new Set(
    scored.flatMap((s) => s.a.changedPaths.filter((p) => predicted.has(p))),
  ).size;
  return { hours, overlapAnchors: scored.length, matchedFiles };
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
export function computeBiasFactor(anchors: EstimateAnchor[]): number | null {
  const ratios = anchors
    // Local anchors only — bias is THIS repo's estimator calibration; another repo's
    // (estimate, actual) pair is a different context and must not skew it.
    .filter(
      (a) =>
        !a.crossRepo && a.aiEstimateHours != null && a.aiEstimateHours > 0 && a.effortHours > 0,
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
export function estimateRange(anchors: EstimateAnchor[]): { low: number; high: number } | null {
  const efforts = anchors
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
  const low = clampHours(round2(pct(20)));
  const high = clampHours(round2(pct(80)));
  return high > low ? { low, high } : null;
}
