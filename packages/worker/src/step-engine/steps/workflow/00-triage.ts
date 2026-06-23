import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  EXECUTION_PATHS,
  EXECUTION_PATH_LABELS,
  executionPathSchema,
  type ExecutionPath,
  type FormSchema,
} from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { TRIAGE_STEP_ID } from '../../../orchestrator/execution-paths.js';
import { isBugBranch } from './01-worktree-setup.js';
import { parseJsonLoose } from '../_fenced-json.js';

// 00-triage — the pre-flight difficulty assessment. Runs FIRST (buildRunList pulls
// it ahead of the env-replicate prelude) so the user picks an execution path up
// front. A one-shot LLM classifies the task into quick_bugfix / plan_tasklist /
// full_workflow; that recommendation pre-selects a radio the user can override. The
// chosen path is written to tasks.execution_path, which buildRunList then uses to
// trim the workflow step list. The LLM is optional — with no usable CLI it degrades
// to a deterministic heuristic baseline so the step never blocks.

interface TriageDetect {
  title: string;
  description: string;
  /** Deterministic baseline used as the recommendation when the LLM can't run. */
  heuristicPath: ExecutionPath;
  heuristicReason: string;
}

interface TriageApply {
  path: ExecutionPath;
  recommended: ExecutionPath;
  source: 'llm' | 'heuristic';
}

/** One-line gray sub-text shown under each path's radio option. */
const PATH_DESCRIPTIONS: Record<ExecutionPath, string> = {
  quick_bugfix:
    'Hand the change straight to the AI, then verify, commit and push. Best for small, well-understood fixes.',
  plan_tasklist:
    'Draft a short spec, break it into a checklist of tasks, run them, then verify and commit. Best for medium changes with a few moving parts.',
  full_workflow:
    'The full pipeline: discovery, spec + quality review, sprint planning, implementation, validation, code review, adversarial QA and staged approvals. Best for large or risky work.',
};

const TRIAGE_RULES = [
  'You are a task triage assistant for an automated engineering workflow. Classify the',
  'task below into ONE execution path and briefly justify it. You MAY glance at the',
  'repository with your tools if it helps, but keep it quick — this is a fast pre-flight',
  'check, not the implementation.',
  '',
  'Paths:',
  '- "quick_bugfix": a small, focused change (a bug fix or tiny tweak) one agent can do',
  '  directly. No spec or decomposition needed.',
  '- "plan_tasklist": a medium change worth a short spec and a task breakdown, run as a',
  '  small plan. A few independent pieces.',
  '- "full_workflow": a large, complex, or risky change needing full discovery, spec',
  '  review, sprint planning, code review and adversarial QA.',
  '',
  'Default to the LIGHTEST path that fits. When unsure between two, pick the lighter.',
  '',
  'Emit ONE JSON object inside a ```json fenced code block, and nothing else:',
  '{ "recommended": "quick_bugfix" | "plan_tasklist" | "full_workflow", "rationale": "<one or two sentences>", "confidence": "low" | "medium" | "high" }',
] as const;

/** Deterministic baseline recommendation from the task title/description + the
 *  creation-time bug flag (tasks.metadata.category). Used as the LLM fallback and
 *  to seed the LLM prompt. Conservative: only an unambiguous bug goes to the quick
 *  path; clear feature/refactor signals go full; everything else takes the middle. */
export function heuristicTriage(
  title: string,
  description: string,
  category: string | null,
): { path: ExecutionPath; reason: string } {
  const text = `${title} ${description}`;
  const looksComplex =
    /\b(feature|implement|build|redesign|refactor|migrat|architecture|integrat|multiple|system|epic|overhaul|rewrite|end-to-end)\b/i.test(
      text,
    ) || description.length > 600;
  if (isBugBranch(title, description, category) && !looksComplex) {
    return {
      path: 'quick_bugfix',
      reason:
        'Looks like a focused bug fix (matched bug keywords or marked as a bug, with no broad-feature signals).',
    };
  }
  if (looksComplex) {
    return {
      path: 'full_workflow',
      reason:
        'Looks like a substantial feature or change (feature/refactor keywords, or a long description).',
    };
  }
  return {
    path: 'plan_tasklist',
    reason: 'Moderate scope — a short plan with a task breakdown fits.',
  };
}

/** Parse the classifier output (raw string with a fenced JSON object, or an already
 *  parsed object) into a valid recommendation, or null when unusable. */
export function parseTriageOutput(
  raw: unknown,
): { recommended: ExecutionPath; rationale: string } | null {
  if (raw === null || raw === undefined) return null;
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.trim() === '') return null;
    obj = parseJsonLoose(raw);
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const rec = typeof o.recommended === 'string' ? o.recommended : '';
  if (!(EXECUTION_PATHS as readonly string[]).includes(rec)) return null;
  return {
    recommended: rec as ExecutionPath,
    rationale: typeof o.rationale === 'string' ? o.rationale : '',
  };
}

/** Resolve the effective recommendation: the LLM's when usable, else the heuristic. */
export function resolveTriage(
  llmOutput: unknown,
  detected: TriageDetect,
): { recommended: ExecutionPath; rationale: string; source: 'llm' | 'heuristic' } {
  const parsed = parseTriageOutput(llmOutput);
  if (parsed) {
    return {
      recommended: parsed.recommended,
      rationale: parsed.rationale || detected.heuristicReason,
      source: 'llm',
    };
  }
  return {
    recommended: detected.heuristicPath,
    rationale: detected.heuristicReason,
    source: 'heuristic',
  };
}

export const triageStep: StepDefinition<TriageDetect, TriageApply> = {
  metadata: {
    id: TRIAGE_STEP_ID,
    workflowType: 'workflow',
    index: 0.5,
    title: 'Choose execution path',
    description:
      'Assesses the task and recommends a quick bugfix, a plan + tasklist, or the full workflow; you pick which to run.',
    requiresCli: false,
    requiredCapabilities: ['tool_use'],
  },

  async detect(ctx: StepContext): Promise<TriageDetect> {
    const row = await ctx.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, ctx.taskId),
      columns: { title: true, description: true, metadata: true },
    });
    const title = row?.title ?? '';
    const description = row?.description ?? '';
    const category = (row?.metadata as { category?: string } | null)?.category ?? null;
    const h = heuristicTriage(title, description, category);
    return { title, description, heuristicPath: h.path, heuristicReason: h.reason };
  },

  llm: {
    requiredCapabilities: ['tool_use'],
    preForm: true,
    // Best-effort: a missing/unusable CLI degrades to the heuristic baseline rather
    // than failing the step, so triage never blocks task start.
    optional: true,
    timeoutMs: 10 * 60 * 1000,
    buildPrompt: (args) => {
      const d = args.detected as TriageDetect;
      return [
        ...TRIAGE_RULES,
        '',
        '=== Task ===',
        `Title: ${d.title}`,
        `Description: ${d.description || '(none)'}`,
        '',
        `A heuristic pre-classifier suggested "${d.heuristicPath}". Use your own judgment.`,
      ].join('\n');
    },
    // Test-bypass: return the heuristic recommendation so HAIVE_TEST_BYPASS_LLM smoke
    // runs exercise the full step without a real CLI provider.
    bypassStub: (args) => ({
      recommended: (args.detected as TriageDetect).heuristicPath,
      rationale: 'test bypass',
      confidence: 'low',
    }),
  },

  form(_ctx, detected, llmOutput): FormSchema {
    const r = resolveTriage(llmOutput, detected);
    const sourceLabel = r.source === 'llm' ? 'AI assessment' : 'heuristic';
    const options = EXECUTION_PATHS.map((p) => {
      const isRecommended = p === r.recommended;
      return {
        value: p,
        // "(recommended)" goes at the end of the label itself; the info icon renders
        // right after it (only on the recommended option).
        label: isRecommended
          ? `${EXECUTION_PATH_LABELS[p]} (recommended)`
          : EXECUTION_PATH_LABELS[p],
        // Gray one-liner under each option so the user sees what it does at a glance.
        description: PATH_DESCRIPTIONS[p],
        // Hover tooltip on the recommended option carries the full rationale, so the
        // old top-of-form collapsible is no longer needed.
        ...(isRecommended ? { info: `Recommended (${sourceLabel})\n\n${r.rationale}` } : {}),
      };
    });
    return {
      title: 'Choose execution path',
      description:
        'A quick assessment recommends a path. Pick the one you want — you can choose a lighter or heavier path than recommended.',
      fields: [
        {
          type: 'radio',
          id: 'path',
          label: 'Execution path',
          options,
          default: r.recommended,
          required: true,
        },
      ],
      submitLabel: 'Start task',
    };
  },

  async apply(ctx, args): Promise<TriageApply> {
    const r = resolveTriage(args.llmOutput ?? null, args.detected);
    const values = (args.formValues ?? {}) as { path?: string };
    const parsedChoice = executionPathSchema.safeParse(values.path);
    const chosen: ExecutionPath = parsedChoice.success ? parsedChoice.data : r.recommended;
    await ctx.db
      .update(schema.tasks)
      .set({ executionPath: chosen, updatedAt: new Date() })
      .where(eq(schema.tasks.id, ctx.taskId));
    ctx.logger.info(
      { chosen, recommended: r.recommended, source: r.source },
      'execution path selected',
    );
    return { path: chosen, recommended: r.recommended, source: r.source };
  },
};
