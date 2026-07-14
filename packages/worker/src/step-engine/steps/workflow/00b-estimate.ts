import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { FormSchema } from '@haive/shared';
import { computeTaskTiming, type TaskTimingStep } from '@haive/shared/timing';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { parseJsonLoose } from '../_fenced-json.js';

// 00b-estimate — the pre-flight effort estimate. Runs right after 00-triage (index 0.6,
// so it sorts ahead of the env-replicate prelude and 01-worktree-setup on every path)
// and produces a LEARNED estimate of how long the task will take, anchored on THIS
// repository's own prior completed tasks and their MEASURED effort. The target metric is
// EFFORT (agent work + user-active time), matching the completion "verdict card" and
// excluding idle / queue-park noise. A one-shot LLM reads the anchors, weights the prior
// tasks whose changed files / description overlap the new task's area, corrects for its
// own past bias, and emits an estimate; the user confirms or overrides it on the form.
// The LLM is optional — with no usable CLI it degrades to a deterministic heuristic
// (median anchor effort scaled by the triage path), so the step never blocks task start.
//
// The RAW AI number is stored on tasks.ai_estimated_time_hours (never user-edited) so AI
// accuracy stays measurable against actual effort over time — that (aiEstimate, actual)
// pair is the calibration signal fed back into future estimates. The CONFIRMED value goes
// to tasks.estimated_time_hours, which the verdict card already compares against actual.

/** Ceiling on how many prior tasks to hand the model as anchors. */
const MAX_ANCHORS = 30;
/** Per-anchor description budget in the prompt / info panel. */
const ANCHOR_DESC_CAP = 240;
/** Per-anchor changed-path budget shown to the model (the overlap signal). */
const ANCHOR_PATHS_SHOWN = 12;

/** Multiplier applied to the median anchor effort per triage path in the heuristic
 *  fallback: a quick bugfix is lighter than the median task, the full workflow heavier. */
const PATH_SCALE: Record<string, number> = {
  quick_bugfix: 0.5,
  plan_tasklist: 1.0,
  full_workflow: 1.5,
};
/** Cold-start baseline (decimal hours) when the repo has NO usable prior-task anchors —
 *  a sane per-path default the model/heuristic starts from until real actuals accrue. */
const FALLBACK_HOURS: Record<string, number> = {
  quick_bugfix: 0.5,
  plan_tasklist: 2,
  full_workflow: 6,
};
/** Same [>0, 1000] envelope the shared task schema enforces on estimated_time_hours. */
const MIN_HOURS = 0.05;
const MAX_HOURS = 1000;

export interface EstimateAnchor {
  title: string;
  description: string;
  executionPath: string | null;
  /** Fix-loop rounds the task needed (0 = clean first pass); a complexity proxy. */
  fixRounds: number;
  /** MEASURED effort = (work + user-active) ms / 3.6e6, rounded to 2 decimals. */
  effortHours: number;
  /** This task's own prior AI estimate + confirmed estimate, when present, so the model
   *  can see where past estimates missed and correct its bias. Null before this feature. */
  aiEstimateHours: number | null;
  confirmedEstimateHours: number | null;
  /** The files the task changed — the overlap signal ("touches the same feature"). */
  changedPaths: string[];
}

interface EstimateDetect {
  title: string;
  description: string;
  executionPath: string | null;
  /** A manual estimate the user typed on the new-task form, if any. The confirm field
   *  defaults to this (respect an explicit human value) over the AI number. */
  manualEstimateHours: number | null;
  anchors: EstimateAnchor[];
  /** Deterministic baseline used as the recommendation when the LLM can't run. */
  heuristicHours: number;
  heuristicReason: string;
}

interface EstimateApply {
  aiHours: number;
  confirmedHours: number;
  source: 'llm' | 'heuristic';
  confidence: string;
  anchorCount: number;
}

const ESTIMATE_RULES = [
  'You are an effort-estimation assistant for an automated engineering workflow. Estimate',
  'how much EFFORT the task below will take, in decimal hours. "Effort" means active agent',
  'work plus time the user spends at review gates — it EXCLUDES idle waiting and queue',
  'time. You MAY glance at the repository with your tools to gauge the change, but keep it',
  'quick — this is a fast pre-flight check, not the implementation.',
  '',
  'You are given prior COMPLETED tasks from THIS repository with their MEASURED actual',
  'effort and the files they changed. Anchor your estimate on them:',
  '- Weight most heavily the prior tasks whose changed files or description overlap the',
  '  area THIS task will touch (infer that area from the task text and a repo glance).',
  '- More fix-loop rounds on a prior task means it was harder than its size suggested.',
  '- If a prior task shows a previous AI estimate AND its actual effort, and the AI',
  '  consistently under- or over-estimated, correct your number in that direction.',
  '- With no relevant anchors, fall back to the task size implied by the triage path.',
  '',
  'Emit ONE JSON object inside a ```json fenced code block, and nothing else:',
  '{ "estimatedHours": <number>, "confidence": "low" | "medium" | "high",',
  '  "rationale": "<one or two sentences naming the prior tasks you anchored on>",',
  '  "similarPriorTasks": ["<title>", ...], "predictedAreas": ["<path or area>", ...] }',
] as const;

function clampHours(n: number): number {
  return Math.min(MAX_HOURS, Math.max(MIN_HOURS, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Effort in hours for one prior task from its step rows, via the SAME pure timing
 *  function the api/web use so the anchor matches the verdict card's actual. Completed
 *  tasks have no open steps, so nowMs only matters for the (excluded) live-wait branch. */
export function effortHoursFromSteps(steps: TaskTimingStep[], nowMs: number): number {
  const t = computeTaskTiming(steps, nowMs);
  return round2((t.workMs + t.userActiveMs) / 3_600_000);
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  // Guarded non-empty above, so mid and mid-1 are valid indices; the assertions satisfy
  // noUncheckedIndexedAccess without masking a real out-of-bounds.
  const hi = sorted[mid]!;
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + hi) / 2 : hi;
}

/** Deterministic baseline estimate: the median measured effort of the anchors scaled by
 *  the triage path, or a per-path cold-start constant when there are no anchors. Used as
 *  the LLM fallback and to seed the prompt. */
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

/** Parse the classifier output (raw string with a fenced JSON object, or an already
 *  parsed object) into a usable estimate, or null when unusable. */
export function parseEstimateOutput(raw: unknown): {
  estimatedHours: number;
  confidence: string;
  rationale: string;
  similarPriorTasks: string[];
} | null {
  if (raw === null || raw === undefined) return null;
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.trim() === '') return null;
    obj = parseJsonLoose(raw);
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const hours = typeof o.estimatedHours === 'number' ? o.estimatedHours : Number(o.estimatedHours);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  const similar = Array.isArray(o.similarPriorTasks)
    ? o.similarPriorTasks.filter((s): s is string => typeof s === 'string').slice(0, 10)
    : [];
  return {
    estimatedHours: clampHours(round2(hours)),
    confidence: typeof o.confidence === 'string' ? o.confidence : 'low',
    rationale: typeof o.rationale === 'string' ? o.rationale : '',
    similarPriorTasks: similar,
  };
}

/** Resolve the effective AI estimate: the LLM's when usable, else the heuristic. */
export function resolveEstimate(
  llmOutput: unknown,
  detected: EstimateDetect,
): { hours: number; source: 'llm' | 'heuristic'; rationale: string; confidence: string } {
  const parsed = parseEstimateOutput(llmOutput);
  if (parsed) {
    return {
      hours: parsed.estimatedHours,
      source: 'llm',
      rationale: parsed.rationale || detected.heuristicReason,
      confidence: parsed.confidence,
    };
  }
  return {
    hours: detected.heuristicHours,
    source: 'heuristic',
    rationale: detected.heuristicReason,
    confidence: 'low',
  };
}

/** One compact anchor line for the prompt and the form's info panel. */
function renderAnchor(a: EstimateAnchor): string {
  const bits = [
    `- "${a.title}" — ${a.effortHours}h effort`,
    a.executionPath ? `[${a.executionPath}]` : '',
    a.fixRounds > 0 ? `${a.fixRounds} fix round(s)` : '',
    a.aiEstimateHours != null ? `(AI predicted ${a.aiEstimateHours}h)` : '',
  ].filter(Boolean);
  let line = bits.join(' ');
  if (a.description) line += `\n    ${a.description}`;
  if (a.changedPaths.length > 0) {
    line += `\n    files: ${a.changedPaths.slice(0, ANCHOR_PATHS_SHOWN).join(', ')}`;
  }
  return line;
}

export const estimateStep: StepDefinition<EstimateDetect, EstimateApply> = {
  metadata: {
    id: '00b-estimate',
    workflowType: 'workflow',
    index: 0.6,
    title: 'Estimate effort',
    description:
      "Estimates how long the task will take by learning from this repository's prior " +
      'completed tasks and their measured effort; you confirm or adjust the estimate.',
    requiresCli: false,
    requiredCapabilities: ['tool_use'],
    // Under auto-continue submit the confirm field's default (the AI estimate, or the
    // user's own new-task-form estimate when they set one) without pausing; with
    // auto-continue off the form parks so the user can adjust.
    autoSubmitDefaults: true,
  },

  async detect(ctx: StepContext): Promise<EstimateDetect> {
    const task = await ctx.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, ctx.taskId),
      columns: {
        title: true,
        description: true,
        executionPath: true,
        repositoryId: true,
        estimatedTimeHours: true,
      },
    });
    const title = task?.title ?? '';
    const description = task?.description ?? '';
    const executionPath = task?.executionPath ?? null;
    const manualEstimateHours = task?.estimatedTimeHours ?? null;

    const anchors: EstimateAnchor[] = [];
    if (task?.repositoryId) {
      // Prior COMPLETED workflow tasks in the same repo (newest first). Same-type only —
      // an onboarding's multi-hour run is not a workflow-effort anchor.
      const priors = await ctx.db.query.tasks.findMany({
        where: and(
          eq(schema.tasks.repositoryId, task.repositoryId),
          eq(schema.tasks.type, 'workflow'),
          eq(schema.tasks.status, 'completed'),
          ne(schema.tasks.id, ctx.taskId),
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
      if (priors.length > 0) {
        const priorIds = priors.map((p) => p.id);
        const stepRows = await ctx.db.query.taskSteps.findMany({
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
      }
    }

    const h = heuristicEstimate(anchors, executionPath);
    return {
      title,
      description,
      executionPath,
      manualEstimateHours,
      anchors,
      heuristicHours: h.hours,
      heuristicReason: h.reason,
    };
  },

  llm: {
    requiredCapabilities: ['tool_use'],
    preForm: true,
    // Best-effort: a missing/unusable CLI degrades to the heuristic baseline rather than
    // failing the step, so estimation never blocks task start.
    optional: true,
    timeoutMs: 10 * 60 * 1000,
    buildPrompt: (args) => {
      const d = args.detected as EstimateDetect;
      const anchorBlock =
        d.anchors.length > 0
          ? d.anchors.map(renderAnchor).join('\n')
          : '(no prior completed tasks in this repository yet)';
      return [
        ...ESTIMATE_RULES,
        '',
        '=== Task ===',
        `Title: ${d.title}`,
        `Description: ${d.description || '(none)'}`,
        `Chosen execution path: ${d.executionPath ?? '(not set)'}`,
        '',
        '=== Prior completed tasks in this repository (measured effort) ===',
        anchorBlock,
        '',
        `A deterministic baseline suggests ${d.heuristicHours}h (${d.heuristicReason}). Use`,
        'your own judgment anchored on the tasks above.',
      ].join('\n');
    },
    // Test-bypass: return the heuristic estimate so HAIVE_TEST_BYPASS_LLM smoke runs
    // exercise the full step (and auto-submit its default) without a real CLI provider.
    bypassStub: (args) => ({
      estimatedHours: (args.detected as EstimateDetect).heuristicHours,
      confidence: 'low',
      rationale: 'test bypass',
    }),
  },

  form(_ctx, detected, llmOutput): FormSchema {
    const r = resolveEstimate(llmOutput ?? null, detected);
    const sourceLabel = r.source === 'llm' ? 'AI assessment' : 'heuristic';
    // Respect an explicit human estimate from the new-task form; otherwise default to the
    // AI number. Either way the raw AI number is stored separately in apply().
    const defaultHours = detected.manualEstimateHours ?? r.hours;

    const anchorPanel =
      detected.anchors.length > 0
        ? detected.anchors.map(renderAnchor).join('\n')
        : 'No prior completed tasks in this repository yet — this estimate uses the path baseline.';

    const fields: FormSchema['fields'] = [];
    if (detected.manualEstimateHours != null) {
      fields.push({
        type: 'note',
        id: 'priorEstimateNote',
        label: 'Your earlier estimate',
        body: `You set ${detected.manualEstimateHours}h on the new-task form. The AI predicts ${r.hours}h. Edit below to keep or change it.`,
        variant: 'info',
      });
    }
    fields.push({
      type: 'number',
      id: 'estimatedHours',
      label: 'Estimated effort (hours)',
      description:
        'Effort = active agent work + your time at review gates (idle / queue time excluded). ' +
        'Defaults to the AI estimate; adjust if you disagree.',
      default: round2(defaultHours),
      min: MIN_HOURS,
      step: 0.25,
      required: true,
    });

    return {
      title: 'Estimate effort',
      description:
        "Learned from this repository's prior tasks and their measured effort. Confirm or " +
        'adjust the estimate — it is compared against the actual effort when the task finishes.',
      statusSummary: [
        {
          label: 'AI estimate',
          status: 'info',
          statusLabel: `${r.hours} h`,
          detail: `${r.confidence} confidence (${sourceLabel}) · ${detected.anchors.length} prior task(s)`,
        },
      ],
      infoSections: [
        {
          title: 'How this was estimated',
          preview: `${r.hours}h · ${detected.anchors.length} anchor(s)`,
          body: `${r.rationale}\n\nPrior tasks used as anchors:\n${anchorPanel}`,
        },
      ],
      fields,
      submitLabel: 'Confirm estimate',
    };
  },

  async apply(ctx, args): Promise<EstimateApply> {
    const detected = args.detected;
    const r = resolveEstimate(args.llmOutput ?? null, detected);
    // The RAW AI number, independent of what the user confirmed — the calibration signal.
    const aiHours = clampHours(r.hours);

    const values = (args.formValues ?? {}) as { estimatedHours?: unknown };
    const submitted = Number(values.estimatedHours);
    // Confirmed value: the user's number when valid, else the field default (their manual
    // estimate or the AI number). Feeds the existing verdict card via estimated_time_hours.
    const confirmedHours =
      Number.isFinite(submitted) && submitted > 0
        ? clampHours(round2(submitted))
        : clampHours(detected.manualEstimateHours ?? aiHours);

    await ctx.db
      .update(schema.tasks)
      .set({
        aiEstimatedTimeHours: aiHours,
        estimatedTimeHours: confirmedHours,
        updatedAt: new Date(),
      })
      .where(eq(schema.tasks.id, ctx.taskId));

    await ctx.db.insert(schema.taskEvents).values({
      taskId: ctx.taskId,
      taskStepId: ctx.taskStepId,
      eventType: 'estimate.recorded',
      payload: {
        aiHours,
        confirmedHours,
        source: r.source,
        confidence: r.confidence,
        anchorCount: detected.anchors.length,
      },
    });

    ctx.logger.info(
      { aiHours, confirmedHours, source: r.source, anchorCount: detected.anchors.length },
      'task effort estimate recorded',
    );
    return {
      aiHours,
      confirmedHours,
      source: r.source,
      confidence: r.confidence,
      anchorCount: detected.anchors.length,
    };
  },
};
