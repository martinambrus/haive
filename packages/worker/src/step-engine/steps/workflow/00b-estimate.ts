import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { parseJsonLoose } from '../_fenced-json.js';
import { resolveRagSyncPrefs } from './_rag-index.js';
import {
  buildAnchors,
  clampHours,
  computeBiasFactor,
  estimateRange,
  heuristicEstimate,
  round2,
  type EstimateAnchor,
  type SemanticRerankOpts,
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
    a.crossRepo ? '(other repo — same stack)' : '',
  ].filter(Boolean);
  let line = bits.join(' ');
  if (a.description) line += `\n    ${a.description}`;
  if (a.changedPaths.length > 0) {
    line += `\n    files: ${a.changedPaths.slice(0, ANCHOR_PATHS_SHOWN).join(', ')}`;
  }
  return line;
}

/** Build the semantic anchor-rerank opts from the repo's RAG tooling prefs, or undefined when
 *  RAG is not configured — in which case the estimator keeps its deterministic newest-first
 *  anchor selection. Prefs only: the actual ollama probe + embed happen inside buildAnchors and
 *  only when the candidate pool exceeds the anchor cap, so a small repo never pays for them. */
async function resolveSemanticRerank(
  ctx: StepContext,
  queryText: string,
): Promise<SemanticRerankOpts | undefined> {
  if (!queryText) return undefined;
  try {
    const resolved = await resolveRagSyncPrefs(ctx);
    const p = resolved.ragToolingPrefs;
    if (!resolved.ragConfigured || !p?.ollamaUrl || !p?.embeddingModel) return undefined;
    return { ollamaUrl: p.ollamaUrl, model: p.embeddingModel, queryText };
  } catch {
    return undefined;
  }
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
    const semantic = task?.repositoryId
      ? await resolveSemanticRerank(ctx, `${title}\n${description}`.trim())
      : undefined;
    const anchors = task?.repositoryId
      ? await buildAnchors(ctx.db, ctx.taskId, task.repositoryId, semantic)
      : [];
    const h = heuristicEstimate(anchors, executionPath);
    return {
      title,
      description,
      executionPath,
      manualEstimateHours,
      anchors,
      biasFactor: computeBiasFactor(anchors),
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
        ...(d.biasFactor != null && (d.biasFactor >= 1.15 || d.biasFactor <= 0.85)
          ? [
              '',
              `Calibration: across prior tasks with an AI estimate, ACTUAL effort was about ${d.biasFactor}x the estimate — bias your number in that direction.`,
            ]
          : []),
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
      min: 0.05,
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
    const range = estimateRange(detected.anchors);

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
