import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { loadTaskMeta } from './_task-meta.js';
import { parseJsonLoose } from '../_fenced-json.js';
import { INSIGHTS_INSTRUCTION } from './08e-insights-triage.js';
import { loadFixLoopDiagnosis } from './_fix-loop.js';
import { getTaskEnvTemplate } from '../env-replicate/_shared.js';

interface ImplementDetect {
  specSummary: string;
  spec: string;
  sandboxWorkspacePath: string;
  gateFeedback: string;
  /** Fix-loop diagnosis to address on this round, or null on the original pass
   *  (round 0). When set, the step runs in fix mode (diagnosis-first prompt). */
  fixContext: string | null;
  /** Fix-loop round (0 = original implementation pass). */
  round: number;
  /** Env template ready with browserTesting on → a chrome-devtools MCP is wired to
   *  the running app's browser (same gate as resolvers.ts), so the fix pass directs
   *  the agent to verify its change in-browser. */
  browserTesting: boolean;
}

interface ImplementApply {
  summary: string;
  filesTouched: string[];
  notes: string;
  source: 'llm' | 'stub';
}

interface PrePlanningOutput {
  summary?: string;
  spec?: string;
}

interface Gate1Output {
  decision?: string;
  feedback?: string;
}

export function parseImplementOutput(raw: unknown): {
  summary: string;
  filesTouched: string[];
  notes: string;
} | null {
  if (!raw) return null;
  let text: string;
  if (typeof raw === 'string') {
    text = raw;
  } else if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.summary === 'string') {
      return normalise(
        obj.summary,
        obj.filesTouched,
        typeof obj.notes === 'string' ? obj.notes : '',
      );
    }
    return null;
  } else {
    return null;
  }
  const parsed = parseJsonLoose(text);
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    typeof (parsed as Record<string, unknown>).summary === 'string'
  ) {
    const obj = parsed as Record<string, unknown>;
    return normalise(
      obj.summary as string,
      obj.filesTouched,
      typeof obj.notes === 'string' ? (obj.notes as string) : '',
    );
  }
  return null;
}

function normalise(
  summary: string,
  filesTouchedRaw: unknown,
  notes: string,
): { summary: string; filesTouched: string[]; notes: string } {
  const filesTouched = Array.isArray(filesTouchedRaw)
    ? (filesTouchedRaw as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  return { summary, filesTouched, notes };
}

/** Remove fenced code blocks (```...```), leaving the agent's prose. */
function stripFencedBlocks(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Best-effort touched-file list from an off-schema object, tolerating the common key
 *  spellings agents use. Provenance only — the authoritative set is the dirty worktree
 *  (see collectImplementationFiles in _impl-changes.ts), so this need not be exact. */
function collectFileList(obj: Record<string, unknown> | null): string[] {
  if (!obj) return [];
  for (const key of ['filesTouched', 'files_changed', 'filesChanged', 'files']) {
    const val = obj[key];
    if (Array.isArray(val)) {
      const list = val.filter((v): v is string => typeof v === 'string');
      if (list.length > 0) return list;
    }
  }
  return [];
}

/** Strict parse missed (e.g. the browser-verify fix pass emits a different JSON shape
 *  with no top-level `summary`). The agent still ran and likely edited files, so
 *  salvage an honest record from whatever it returned — its prose summary plus any file
 *  list — instead of falsely reporting a skip. Null only when there is no agent output
 *  at all (then apply emits the genuine no-output stub). */
export function salvageImplementOutput(
  raw: unknown,
): { summary: string; filesTouched: string[]; notes: string } | null {
  let text = '';
  let obj: Record<string, unknown> | null = null;
  if (typeof raw === 'string') {
    text = raw;
    // parseJsonLoose runs a jsonrepair salvage pass; null leaves obj null and the
    // prose summary below is still used.
    const parsed = parseJsonLoose(raw);
    if (parsed && typeof parsed === 'object') obj = parsed as Record<string, unknown>;
  } else if (raw && typeof raw === 'object') {
    obj = raw as Record<string, unknown>;
  }
  if (!text.trim() && !obj) return null;
  const objSummary = obj && typeof obj.summary === 'string' ? obj.summary.trim() : '';
  const prose = stripFencedBlocks(text);
  const summary =
    objSummary ||
    prose ||
    'The implementation agent ran but returned no readable summary; see the step terminal for its full output.';
  return { summary: summary.slice(0, 2000), filesTouched: collectFileList(obj), notes: '' };
}

function stubImplement(detect: ImplementDetect): {
  summary: string;
  filesTouched: string[];
  notes: string;
} {
  return {
    summary:
      'The implementation agent produced no output (no CLI provider was available, or the run returned nothing). No changes were recorded; the spec remains the authoritative source of intent.',
    filesTouched: [],
    notes: detect.gateFeedback
      ? `Gate 1 feedback carried forward: ${detect.gateFeedback}`
      : 'No additional notes recorded.',
  };
}

export const phase2ImplementStep: StepDefinition<ImplementDetect, ImplementApply> = {
  metadata: {
    id: '07-phase-2-implement',
    workflowType: 'workflow',
    index: 7,
    title: 'Phase 2: Implement',
    description:
      'Delegates the spec to the active CLI provider for implementation inside the workspace and records a summary of what was changed.',
    requiresCli: false,
    // The only field is an optional "additional instructions" textarea — nothing
    // to decide. Under auto-continue, auto-submit on its empty default and start
    // implementing; manual mode still parks so instructions can be added first.
    autoSubmitDefaults: true,
  },

  async shouldRun(ctx: StepContext): Promise<boolean> {
    // Skip when 2c sprint planning chose DAG mode — 06c-dag-execute implements
    // instead. Runs for single mode or when 06b is absent (legacy tasks).
    const sprint = await loadPreviousStepOutput(ctx.db, ctx.taskId, '06b-sprint-planning');
    const mode = (sprint?.output as { mode?: string } | null)?.mode;
    return mode !== 'dag';
  },

  async detect(ctx: StepContext): Promise<ImplementDetect> {
    const plan = await loadPreviousStepOutput(ctx.db, ctx.taskId, '04-phase-0b-pre-planning');
    const quality = await loadPreviousStepOutput(ctx.db, ctx.taskId, '05-phase-0b5-spec-quality');
    const resolved = await loadPreviousStepOutput(ctx.db, ctx.taskId, '05a-resolve-spec-warnings');
    const gate = await loadPreviousStepOutput(ctx.db, ctx.taskId, '06-gate-1-spec-approval');
    const worktree = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-worktree-setup');
    const planOutput = (plan?.output as PrePlanningOutput | null) ?? {};
    const qualityOutput = (quality?.output as { spec?: string } | null) ?? {};
    const resolvedOutput = (resolved?.output as { spec?: string } | null) ?? {};
    const gateOutput = (gate?.output as Gate1Output | null) ?? {};
    const worktreeOutput = (worktree?.output as { sandboxWorktreePath?: string } | null) ?? {};
    if (!worktreeOutput.sandboxWorktreePath) {
      throw new Error(
        '07-phase-2-implement requires 01-worktree-setup to have produced sandboxWorktreePath',
      );
    }
    const envTemplate = await getTaskEnvTemplate(ctx.db, ctx.taskId);
    const browserTesting =
      envTemplate?.status === 'ready' &&
      !!(envTemplate.declaredDeps as Record<string, unknown> | null)?.browserTesting;
    // Implement from the spec the user APPROVED at gate 1: the post-checkpoint spec
    // (05a user/agent fixes), then the 05 amended body, then the 04 draft.
    let spec = resolvedOutput.spec ?? qualityOutput.spec ?? planOutput.spec ?? '';
    let specSummary = planOutput.summary ?? '';
    if (spec.trim().length === 0) {
      // Lightweight paths (quick_bugfix) skip the spec steps (03/04/05), so there is
      // no drafted spec — fall back to the raw task title + description as the
      // implementation brief ("hand the agent the problem directly"). Full/plan paths
      // always have a spec here, so this never changes their behavior.
      const meta = await loadTaskMeta(ctx.db, ctx.taskId);
      const title = meta.title.trim();
      const description = meta.description.trim();
      spec = [title ? `# ${title}` : '', description].filter((s) => s.length > 0).join('\n\n');
      if (specSummary.length === 0) specSummary = title;
    }
    return {
      specSummary,
      spec,
      sandboxWorkspacePath: worktreeOutput.sandboxWorktreePath,
      gateFeedback: gateOutput.feedback ?? '',
      // Fix-loop: on a round > 0 re-entry, the diagnosis a downstream step recorded.
      fixContext: await loadFixLoopDiagnosis(ctx),
      round: ctx.round,
      browserTesting,
    };
  },

  form(_ctx, detected): FormSchema {
    const isFix = Boolean(detected.fixContext);
    return {
      title: isFix ? `Phase 2: Implement — fix round ${detected.round}` : 'Phase 2: Implement',
      description: [
        `Workspace (inside sandbox): ${detected.sandboxWorkspacePath}`,
        `Spec length: ${detected.spec.length} chars`,
        isFix
          ? `Fix pass — addressing a defect found downstream. Latest tool output (the error is usually at the end):\n…${(detected.fixContext ?? '').slice(-800)}`
          : detected.gateFeedback
            ? `Gate 1 feedback: ${detected.gateFeedback}`
            : 'No gate 1 feedback recorded.',
      ].join('\n'),
      fields: [
        {
          type: 'textarea',
          id: 'instructions',
          label: 'Additional implementation instructions (optional)',
          rows: 4,
          placeholder: 'Hard constraints, required files to touch, style overrides for this run.',
        },
      ],
      submitLabel: isFix ? 'Apply fix' : 'Implement',
    };
  },

  llm: {
    requiredCapabilities: ['tool_use', 'file_write'],
    timeoutMs: 60 * 60 * 1000,
    buildPrompt: (args) => {
      const detected = args.detected as ImplementDetect;
      const values = args.formValues as { instructions?: string };
      // Shared guidance + output contract used by both the original and fix passes.
      const common = [
        'Before implementing, search for the existing patterns the spec references, in this order:',
        '1. `rag_search` FIRST — query the haive-rag tool for the symbols/components/patterns involved',
        '   (semantic + lexical search over the indexed code AND knowledge base); prefer it over blind grepping.',
        '2. If rag_search is unavailable or returns nothing useful, READ the relevant `.claude/knowledge_base/` files.',
        '3. If still not enough, Grep / Read the codebase directly for the symbols you need.',
        'Follow the patterns you find; avoid documented anti-patterns.',
        '',
        'When finished emit ONE JSON object inside a ```json fenced code block with the shape:',
        '{ "summary": "<what changed and why>", "filesTouched": ["path/one", "path/two"], "notes": "<follow-ups or caveats>" }',
        '',
        `Workspace path: ${detected.sandboxWorkspacePath}`,
        `Your current working directory is already set to the workspace path above.`,
        `Gate 1 feedback: ${detected.gateFeedback || '(none)'}`,
        `Extra instructions: ${values.instructions ?? '(none)'}`,
      ];

      // When the repo does browser testing, a chrome-devtools MCP is wired to the
      // running app's browser (resolvers.ts attaches it to the live headed desktop
      // when up, else a headless isolated Chrome). On a fix pass, direct the agent to
      // re-verify its change there — closing the loop the defect came from.
      const browserVerify = detected.browserTesting
        ? [
            '',
            '=== Verify in the browser (a chrome-devtools MCP is available) ===',
            "A `chrome-devtools` MCP is connected to the running app's browser — the",
            'same instance under test (or an isolated headless Chrome). For any change',
            "affecting the app's runtime behavior or UI: after editing, use chrome-devtools",
            'to navigate to the app, reproduce the reported problem, and confirm it is',
            'resolved BEFORE finishing. Note what you observed in your summary.',
          ]
        : [];

      // Fix pass (round > 0): lead with the defect + a "fix only this" framing, THEN
      // append the full spec as supporting context — the implementation already exists.
      if (detected.fixContext) {
        return [
          'You are the implementation phase of an engineering workflow, running a FIX PASS.',
          'A later step found a BLOCKING defect in the current implementation. Fix ONLY the',
          'issue(s) below by editing files in the workspace. Keep the diff minimal and do not',
          're-do unrelated work — the rest of the implementation already exists and passed.',
          'The diagnosis below is raw tool/agent output and may include unrelated banner or',
          'promotional text — identify the actual error or failure it reports and fix that.',
          '',
          '=== Defect to fix (found downstream) ===',
          detected.fixContext,
          '',
          ...common,
          ...browserVerify,
          '',
          'The full specification is included below for context — use it to understand the',
          'intended behavior, but only change what is needed to resolve the defect above.',
          '',
          '=== Spec ===',
          detected.spec || '(empty spec)',
          '',
          INSIGHTS_INSTRUCTION,
        ].join('\n');
      }

      // Original pass (round 0): implement the spec from scratch.
      return [
        'You are the implementation phase of an engineering workflow.',
        'Apply the specification below to the workspace. You may read and write files freely inside the workspace.',
        'Prefer minimal, reviewable diffs. Follow existing conventions. Do not invent requirements.',
        '',
        ...common,
        '',
        '=== Spec ===',
        detected.spec || '(empty spec — default to minimal safe change)',
        '',
        INSIGHTS_INSTRUCTION,
      ].join('\n');
    },
  },

  async apply(ctx, args): Promise<ImplementApply> {
    const parsed = parseImplementOutput(args.llmOutput ?? null);
    if (parsed) {
      ctx.logger.info(
        { filesTouched: parsed.filesTouched.length, source: 'llm' },
        'implementation summary parsed',
      );
      return {
        summary: parsed.summary,
        filesTouched: parsed.filesTouched,
        notes: parsed.notes,
        source: 'llm',
      };
    }
    // Strict parse missed. If the agent still returned output (e.g. the browser-verify
    // fix pass emits a different JSON shape), salvage an honest record from it rather
    // than reporting a skip. Only the genuine no-output case falls through to the stub.
    const salvaged = salvageImplementOutput(args.llmOutput ?? null);
    if (salvaged) {
      ctx.logger.info(
        { filesTouched: salvaged.filesTouched.length, source: 'llm' },
        'implementation summary salvaged from off-format agent output',
      );
      return { ...salvaged, source: 'llm' };
    }
    const stub = stubImplement(args.detected);
    ctx.logger.info({ source: 'stub' }, 'implementation stubbed (no agent output)');
    return {
      summary: stub.summary,
      filesTouched: stub.filesTouched,
      notes: stub.notes,
      source: 'stub',
    };
  },
};
