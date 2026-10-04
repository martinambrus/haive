import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { CONFIG_KEYS, configService, type FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { parseJsonLoose } from '../_fenced-json.js';
import { resolveRagSyncPrefs } from './_rag-index.js';
import { retrieveSimilarTaskIds } from './_task-embedding.js';
import { collapseToLine } from '../_untrusted-repo.js';
import {
  buildAnchors,
  planProximityTaskIds,
  clampHours,
  computeBiasFactor,
  estimateRange,
  heuristicEstimate,
  MAX_ANCHORS,
  MIN_PATH_ANCHORS,
  MAX_HOURS,
  MIN_HOURS,
  round2,
  type EstimateAnchor,
} from './_estimate.js';

// 00b-estimate — the pre-flight effort estimate. Runs right after 00-triage (index 0.6,
// so it sorts ahead of the env-replicate prelude and 01-worktree-setup on every path)
// and produces a LEARNED estimate of how long the task will take, anchored on THIS
// repository's own prior completed tasks and their MEASURED effort (see _estimate.ts).
// The target metric is EFFORT (agent work + user-active time), matching the completion
// "verdict card" and excluding idle / queue-park noise. A one-shot LLM reads the anchors,
// weights the prior tasks whose changed files / description overlap the new task's area,
// corrects for its own past bias, and emits an estimate; the user confirms or overrides
// it on the form. The LLM is optional — with no usable CLI it degrades to a deterministic
// heuristic, so estimation never blocks task start.
//
// The RAW AI number is stored on tasks.ai_estimated_time_hours (never user-edited) so AI
// accuracy stays measurable against actual effort over time — that (aiEstimate, actual)
// pair is the calibration signal. The CONFIRMED value goes to tasks.estimated_time_hours,
// which the verdict card already compares against actual. The post-planning refinement
// (06b-sprint-planning) later sharpens ai_estimated_time_hours once the task's files are
// known.

/** Per-anchor changed-path budget shown to the model (the overlap signal). */
const ANCHOR_PATHS_SHOWN = 12;

interface EstimateDetect {
  title: string;
  description: string;
  executionPath: string | null;
  /** A manual estimate the user typed on the new-task form, if any. The confirm field
   *  defaults to this (respect an explicit human value) over the AI number. */
  manualEstimateHours: number | null;
  anchors: EstimateAnchor[];
  /** Median actual/estimate ratio over prior tasks that carry both; null until enough
   *  history. Fed to the estimator as an explicit calibration hint. */
  biasFactor: number | null;
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
  'quick — this is a fast pre-flight check, not the implementation. `rag_search` is the',
  'cheapest way to do that glance: one query returns ranked snippets with source paths, where',
  'a blind grep costs several rounds. Do not follow it up with a full grounding sweep here.',
  '',
  'You are given prior COMPLETED tasks from THIS repository with their MEASURED actual',
  'effort and the files they changed. Anchor your estimate on them:',
  '- Prefer tasks on the SAME execution path with similar scope. Different paths include',
  '  different planning and review work; do not treat a full workflow as a typical bugfix.',
  `- With fewer than ${MIN_PATH_ANCHORS} measured same-path tasks, use other paths only as a`,
  '  weaker fallback and explain that limitation. Unknown-path anchors are also weaker.',
  '- Weight most heavily the prior tasks whose changed files or description overlap the',
  '  area THIS task will touch (infer that area from the task text and a repo glance).',
  '- More fix-loop rounds on a prior task means it was harder than its size suggested.',
  '- Correct estimation bias from prior AI-estimate/actual pairs in THIS repository.',
  '  For a known execution path, use only same-path pairs, with at least two measurements;',
  '  do not infer its calibration from other paths or other repositories.',
  '- With no relevant anchors, fall back to the task size implied by the triage path.',
  '- Anchors marked "(other repo — same stack)" come from your other repositories on the',
  '  same framework and appear only when this repository has little history of its own —',
  '  treat them as a weak cold-start signal, below any same-repo anchor.',
  '',
  'Emit ONE JSON object inside a ```json fenced code block, and nothing else:',
  '{ "estimatedHours": <number>, "confidence": "low" | "medium" | "high",',
  '  "rationale": "<one or two sentences naming the prior tasks you anchored on>",',
  '  "similarPriorTasks": ["<title>", ...], "predictedAreas": ["<path or area>", ...] }',
] as const;

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
  const baseline = heuristicEstimate(detected.anchors, detected.executionPath);
  const parsed = parseEstimateOutput(llmOutput);
  if (parsed) {
    return {
      hours: parsed.estimatedHours,
      source: 'llm',
      rationale: parsed.rationale || baseline.reason,
      confidence: parsed.confidence,
    };
  }
  return {
    hours: baseline.hours,
    source: 'heuristic',
    rationale: baseline.reason,
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
    a.crossRepo ? '(other repo — same stack)' : '',
  ].filter(Boolean);
  let line = bits.join(' ');
  // Another TASK's description, quoted here as an anchor. It is not this task's
  // assignment and nothing in it is direction for this pass — it may have been composed
  // from plan-node bodies, which is agent prose. Collapsed rather than fenced: these are
  // one-line bullets in a list the estimator scans, and `_estimate` already caps them.
  if (a.description) line += `\n    ${collapseToLine(a.description)}`;
  if (a.changedPaths.length > 0) {
    line += `\n    files: ${a.changedPaths.slice(0, ANCHOR_PATHS_SHOWN).join(', ')}`;
  }
  return line;
}

/** Ask the repo's RAG vector store for the prior tasks most semantically similar to this one
 *  (most-similar first), for buildAnchors to prefer as effort anchors. Returns [] when RAG is
 *  not configured or anything fails — buildAnchors then uses recency within each path tier.
 *  Requests MAX_ANCHORS ids so a well-populated store can fill the whole anchor set from
 *  semantic matches, with newest-first top-up when the store is empty/partial. */
async function resolvePreferredAnchorIds(
  ctx: StepContext,
  repositoryId: string,
  queryText: string,
  executionPath: string | null,
): Promise<string[]> {
  if (!queryText) return [];
  try {
    const resolved = await resolveRagSyncPrefs(ctx);
    if (!resolved.ragConfigured || !resolved.ragToolingPrefs) return [];
    return await retrieveSimilarTaskIds(
      ctx,
      resolved.ragToolingPrefs,
      resolved.projectName,
      repositoryId,
      queryText,
      MAX_ANCHORS,
      executionPath,
    );
  } catch (err) {
    ctx.logger.warn({ err }, 'preferred anchor retrieval failed (falling back to newest-first)');
    return [];
  }
}

/**
 * The anchor order handed to `buildAnchors`: plan-near tasks first, then the semantic ones.
 *
 * Plan-first is a JUDGEMENT, not a measurement. Plan proximity is a relationship someone
 * asserted about the project's structure; the semantic order is inferred from the task's own
 * prose. This order decides which candidates fit once a path tier has more than MAX_ANCHORS
 * completed workflow tasks. Below that it is a prompt-ordering tie-break rather than a gate.
 * `CONFIG_KEYS.ESTIMATE_PLAN_ANCHORS_ENABLED` off restores semantic-first ordering within
 * each execution-path tier.
 *
 * Both halves degrade to [] independently, and `buildAnchors` then uses recency within tiers.
 */
async function resolveAnchorOrder(
  ctx: StepContext,
  repositoryId: string,
  queryText: string,
  executionPath: string | null,
): Promise<string[]> {
  let planIds: string[] = [];
  try {
    if (await configService.getBoolean(CONFIG_KEYS.ESTIMATE_PLAN_ANCHORS_ENABLED, true)) {
      planIds = await planProximityTaskIds(ctx.db, ctx.taskId, repositoryId, executionPath);
    }
  } catch (err) {
    ctx.logger.warn({ err }, 'plan-proximity anchors unavailable (non-fatal)');
  }
  const semanticIds = await resolvePreferredAnchorIds(ctx, repositoryId, queryText, executionPath);
  return [...new Set([...planIds, ...semanticIds])];
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
    const preferredTaskIds = task?.repositoryId
      ? await resolveAnchorOrder(
          ctx,
          task.repositoryId,
          `${title}\n${description}`.trim(),
          executionPath,
        )
      : [];
    const anchors = task?.repositoryId
      ? await buildAnchors(ctx.db, ctx.taskId, task.repositoryId, preferredTaskIds, executionPath)
      : [];
    const h = heuristicEstimate(anchors, executionPath);
    return {
      title,
      description,
      executionPath,
      manualEstimateHours,
      anchors,
      biasFactor: computeBiasFactor(anchors, executionPath),
      heuristicHours: h.hours,
      heuristicReason: h.reason,
    };
  },

  llm: {
    requiredCapabilities: ['tool_use'],
    // Estimation reads prior tasks and the repo; a browser or a DDEV container
    // cannot inform it.
    toolProfile: 'rag_only',
    preForm: true,
    // Best-effort: a missing/unusable CLI degrades to the heuristic baseline rather than
    // failing the step, so estimation never blocks task start.
    optional: true,
    timeoutMs: 10 * 60 * 1000,
    buildPrompt: (args) => {
      const d = args.detected as EstimateDetect;
      // Recompute from the anchors at prompt-build time: a persisted detect_output may
      // predate path-aware calibration and carry the old mixed-path factor/baseline.
      const biasFactor = computeBiasFactor(d.anchors, d.executionPath);
      const baseline = heuristicEstimate(d.anchors, d.executionPath);
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
        ...(biasFactor != null && (biasFactor >= 1.15 || biasFactor <= 0.85)
          ? [
              '',
              `Calibration: across prior ${d.executionPath ?? 'workflow'} tasks in this repository with an AI estimate, ACTUAL effort was about ${biasFactor}x the estimate — bias your number in that direction.`,
            ]
          : []),
        '',
        `A deterministic baseline suggests ${baseline.hours}h (${baseline.reason}). Use`,
        'your own judgment anchored on the tasks above.',
      ].join('\n');
    },
    // Test-bypass: return the heuristic estimate so HAIVE_TEST_BYPASS_LLM smoke runs
    // exercise the full step (and auto-submit its default) without a real CLI provider.
    bypassStub: (args) => ({
      estimatedHours: resolveEstimate(null, args.detected as EstimateDetect).hours,
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
      label: 'Estimated effort',
      unit: 'hours',
      description:
        'Effort = active agent work + your time at review gates (idle / queue time excluded). ' +
        'Defaults to the AI estimate; adjust if you disagree.',
      default: defaultHours,
      min: MIN_HOURS,
      max: MAX_HOURS,
      // 'any', not a numeric step: the browser anchors its step ladder at `min`, so
      // min 0.05 with step 0.25 rejected every whole hour (3h offered 2.8 / 3.05) and
      // every round2 AI number off that ladder. Hours is a free decimal; min/max bound it.
      step: 'any',
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
        ? clampHours(submitted)
        : clampHours(detected.manualEstimateHours ?? aiHours);
    const range = estimateRange(detected.anchors, detected.executionPath);

    await ctx.db
      .update(schema.tasks)
      .set({
        aiEstimatedTimeHours: aiHours,
        aiEstimateLowHours: range?.low ?? null,
        aiEstimateHighHours: range?.high ?? null,
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
