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

// 00-triage — the pre-flight difficulty assessment. Runs second, right after the
// 00-model-health canary and ahead of the env-replicate prelude, so the user picks an
// execution path up front. A one-shot LLM classifies the task into quick_bugfix /
// plan_tasklist / full_workflow; that recommendation pre-selects a radio the user can
// override. The chosen path is written to tasks.execution_path, which buildRunList
// then uses to trim the workflow step list. The LLM is optional — with no usable CLI
// it degrades to a deterministic heuristic baseline so the step never blocks.

interface TriageDetect {
  title: string;
  description: string;
  /** Deterministic baseline used as the recommendation when the LLM can't run. */
  heuristicPath: ExecutionPath;
  heuristicReason: string;
  /** Repository this task runs against, so the note below can link to its plan.
   *  Null for a task with no repository, where there is no plan to link to. */
  repositoryId: string | null;
  /** True when a plan chat is what proposed this task. Suppresses the note
   *  entirely: without it the chat says "run these as one task", triage says
   *  "these should be plan nodes", and the user bounces between the two — on
   *  exactly the tasks both heuristics agree are large. */
  fromPlanChat: boolean;
}

/** The triage agent's optional aside: this looks less like one task than like
 *  several pieces of a project, which the plan canvas is for.
 *
 *  Optional at every layer. The heuristic baseline emits NOTHING rather than
 *  `should_plan: false` — it classifies on keywords and description length and
 *  has no basis for the judgement, and a fabricated negative reads as a check
 *  that was made and passed. */
export interface PlanCandidate {
  reason: string;
  parts: string[];
}

interface TriageApply {
  path: ExecutionPath;
  recommended: ExecutionPath;
  source: 'llm' | 'heuristic';
  /** Effective broad-audit flag persisted to tasks.broad_audit for the chosen path. */
  broadAudit: boolean;
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
  '',
  'OPTIONALLY add a "plan_candidate" key when this reads less like one task than like',
  'several separate pieces of the project that different people could take independently —',
  'not merely a big task, but distinct capabilities that will each outlive this piece of',
  'work. The project keeps a PLAN (a durable tree of what it is meant to be), and those',
  'belong there as nodes rather than inside one task description.',
  '',
  '{ "plan_candidate": { "reason": "<one sentence: why these are separate>", "parts": ["<each piece, briefly>"] } }',
  '',
  'This never blocks anything — the user is shown it as a note beside their own choice and',
  'may ignore it. OMIT the key entirely when the task is one coherent piece of work, which',
  'is the common case. Do not add it merely because the task is large: a large task with one',
  'goal is what "full_workflow" is for.',
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
): { recommended: ExecutionPath; rationale: string; planCandidate: PlanCandidate | null } | null {
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
    planCandidate: parsePlanCandidate(o.plan_candidate),
  };
}

/** The aside, when the agent made one and it says something. A candidate with no
 *  parts is not a suggestion the user can act on, so it is treated as absent
 *  rather than rendered as an empty list. */
export function parsePlanCandidate(raw: unknown): PlanCandidate | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const parts = Array.isArray(o.parts)
    ? o.parts.filter((p): p is string => typeof p === 'string' && p.trim() !== '').slice(0, 12)
    : [];
  const reason = typeof o.reason === 'string' ? o.reason.trim() : '';
  if (parts.length < 2 || !reason) return null;
  return { reason, parts };
}

/** Resolve the effective recommendation: the LLM's when usable, else the heuristic. */
export function resolveTriage(
  llmOutput: unknown,
  detected: TriageDetect,
): {
  recommended: ExecutionPath;
  rationale: string;
  source: 'llm' | 'heuristic';
  planCandidate: PlanCandidate | null;
} {
  const parsed = parseTriageOutput(llmOutput);
  if (parsed) {
    return {
      recommended: parsed.recommended,
      rationale: parsed.rationale || detected.heuristicReason,
      source: 'llm',
      // Suppressed for a task a plan chat proposed: it was decomposed there
      // already, and telling the user to go back and decompose it is a loop.
      planCandidate: detected.fromPlanChat ? null : parsed.planCandidate,
    };
  }
  return {
    recommended: detected.heuristicPath,
    rationale: detected.heuristicReason,
    source: 'heuristic',
    // The heuristic classifies on keywords and length; it cannot tell separate
    // capabilities from one big one, so it says nothing rather than "no".
    planCandidate: null,
  };
}

/** Effective broad_audit for the chosen path. quick_bugfix's step set (SPINE) contains
 *  neither audit step (04a-spec-audit / 08c2-code-audit), so the flag is a no-op there —
 *  force it off so the DB matches the run list and a hidden-but-ticked checkbox can't
 *  submit a stale true. plan_tasklist and full_workflow both include the audits, so they
 *  default on unless the user unticked. See orchestrator/execution-paths.ts. */
export function resolveBroadAudit(chosen: ExecutionPath, broadAudit: boolean | undefined): boolean {
  if (chosen === 'quick_bugfix') return false;
  return broadAudit ?? true;
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
      columns: { title: true, description: true, metadata: true, repositoryId: true },
    });
    const title = row?.title ?? '';
    const description = row?.description ?? '';
    const meta = (row?.metadata ?? {}) as { category?: string; fromPlanChat?: boolean };
    const h = heuristicTriage(title, description, meta.category ?? null);
    return {
      title,
      description,
      heuristicPath: h.path,
      heuristicReason: h.reason,
      repositoryId: row?.repositoryId ?? null,
      fromPlanChat: meta.fromPlanChat === true,
    };
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
      // A note, deliberately NOT a fourth radio option: the radio group means
      // "execution path", and "put this in the plan instead" is not one of them.
      // Mixing the two would make one control answer two questions. Open by
      // default because a note nobody expands is a note nobody reads, and this
      // one is only ever emitted when the agent thought it mattered.
      ...(r.planCandidate
        ? {
            infoSections: [
              {
                title: 'This looks like several separate pieces',
                preview: `${r.planCandidate.parts.length} parts`,
                body: [
                  r.planCandidate.reason,
                  '',
                  ...r.planCandidate.parts.map((part) => `- ${part}`),
                  '',
                  'Each of these outlives this piece of work, so they may belong in the project',
                  "plan as nodes rather than inside one task's description. Adding them there lets",
                  'you run them independently and keeps a record of what is left.',
                  '',
                  detected.repositoryId
                    ? `Open the plan: /repos/${detected.repositoryId}/plan`
                    : '',
                  '',
                  'You can also ignore this entirely and carry on with the task as it stands —',
                  'nothing here blocks it, and the path you pick below is what runs.',
                ]
                  .filter((line, i, all) => line !== '' || all[i - 1] !== '')
                  .join('\n'),
                defaultOpen: true,
              },
            ],
          }
        : {}),
      fields: [
        {
          type: 'radio',
          id: 'path',
          label: 'Execution path',
          options,
          default: r.recommended,
          required: true,
        },
        {
          type: 'checkbox',
          id: 'broadAudit',
          label: 'Extended results validation (Recommended)',
          description:
            'By using this option, hAIve will perform additional accuracy validation of ' +
            'technical specification and the actual code changes in this task. ' +
            "It's recommended to keep this option ticked, unless you're very restricted " +
            'in tokens usage, as unticking it will potentially save you some tokens (but may ' +
            'also cost you more, as the spec or code could need more corrections after ' +
            'your review).',
          default: true,
          // Hide on quick_bugfix: that path's step set (SPINE) has neither audit step
          // (04a-spec-audit / 08c2-code-audit), so the flag does nothing there. The
          // plan_tasklist and full_workflow paths both include the audits. If a future
          // path is added that also lacks the audits, revisit this predicate (see
          // orchestrator/execution-paths.ts).
          visibleWhen: { field: 'path', notEquals: 'quick_bugfix' },
        },
      ],
      submitLabel: 'Start task',
    };
  },

  async apply(ctx, args): Promise<TriageApply> {
    const r = resolveTriage(args.llmOutput ?? null, args.detected);
    const values = (args.formValues ?? {}) as { path?: string; broadAudit?: boolean };
    const parsedChoice = executionPathSchema.safeParse(values.path);
    const chosen: ExecutionPath = parsedChoice.success ? parsedChoice.data : r.recommended;
    const broadAudit = resolveBroadAudit(chosen, values.broadAudit);
    await ctx.db
      .update(schema.tasks)
      .set({ executionPath: chosen, broadAudit, updatedAt: new Date() })
      .where(eq(schema.tasks.id, ctx.taskId));
    ctx.logger.info(
      { chosen, recommended: r.recommended, source: r.source, broadAudit },
      'execution path selected',
    );
    return { path: chosen, recommended: r.recommended, source: r.source, broadAudit };
  },
};
