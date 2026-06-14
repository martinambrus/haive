import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { STEP_CLI_ROLES } from '@haive/shared';
import type { StepContext, StepDefinition, StepLoopPassRecord } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { extractFencedJson } from '../_fenced-json.js';
import { collectImplementationFiles } from './_impl-changes.js';

// Phase 3.5 — Code simplification (legacy phase3_5-code-simplification.md). A
// simplifier agent reviews the just-implemented code in the integration worktree
// and simplifies it in place — NO functionality changes — in a single pass; only
// if it changed files, ONE fixup agent verifies the simplifications didn't break
// the spec'd behavior and restores anything lost. No further loops. Gated on the
// per-task `tasks.simplify_code` toggle (the Haive equivalent of the legacy
// "plugin installed" gate — Haive has no user-scope plugin registry). Agents
// edit files only (git is unavailable in the sandbox); 10-gate-3-commit picks
// the edits up via `git add -A` later.

const ROLE_SIMPLIFIER = 'simplifier';
const ROLE_FIXUP = 'fixup';

interface SimplifyDetect {
  worktreePath: string;
  sandboxWorktreePath: string;
  spec: string;
  /** Files touched by implementation (single-agent output or DAG issue union)
   *  plus currently-dirty worktree files; deduped, capped for prompt size. */
  implementationFiles: string[];
}

interface SimplifyApply {
  ran: boolean;
  filesSimplified: string[];
  changesMade: string[];
  noChangesNeeded: boolean;
  fixesNeeded: boolean;
  fixesMade: string[];
  source: 'simplifier' | 'fixup' | 'stub';
}

const simplifierOutputSchema = z.object({
  files_simplified: z.array(z.string()).default([]),
  changes_made: z.array(z.string()).default([]),
  no_changes_needed: z.boolean().optional(),
});

const fixupOutputSchema = z.object({
  fixes_needed: z.boolean().default(false),
  fixes_made: z.array(z.string()).default([]),
});

function fencedCandidate(raw: unknown): unknown {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  const body = extractFencedJson(raw);
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** Parse the simplifier's JSON; null when unparseable (treated as no-changes —
 *  a parse miss must not trigger a pointless fixup pass). */
export function parseSimplifierOutput(
  raw: unknown,
): { filesSimplified: string[]; changesMade: string[]; noChangesNeeded: boolean } | null {
  const parsed = simplifierOutputSchema.safeParse(fencedCandidate(raw));
  if (!parsed.success) return null;
  const { files_simplified, changes_made, no_changes_needed } = parsed.data;
  return {
    filesSimplified: files_simplified,
    changesMade: changes_made,
    noChangesNeeded: no_changes_needed ?? files_simplified.length === 0,
  };
}

/** Parse the fixup agent's JSON; falls back to "no fixes" on a parse miss. */
export function parseFixupOutput(raw: unknown): { fixesNeeded: boolean; fixesMade: string[] } {
  const parsed = fixupOutputSchema.safeParse(fencedCandidate(raw));
  if (!parsed.success) return { fixesNeeded: false, fixesMade: [] };
  return { fixesNeeded: parsed.data.fixes_needed, fixesMade: parsed.data.fixes_made };
}

/** The pass-0 simplifier result carried into the fixup pass / final output. */
function priorSimplifier(previous: StepLoopPassRecord[]): SimplifyApply | null {
  for (let i = previous.length - 1; i >= 0; i -= 1) {
    const out = previous[i]?.applyOutput as SimplifyApply | undefined;
    if (out && (out.source === 'simplifier' || out.source === 'stub')) return out;
  }
  return null;
}

const SEARCH_LADDER = [
  'When you need existing patterns or context, search in this order:',
  '1. `rag_search` FIRST (semantic + lexical over the indexed code and knowledge base),',
  '2. then the relevant `.claude/knowledge_base/` files,',
  '3. then Grep / Read the codebase directly.',
] as const;

// The code-simplifier agent definition, vendored from Anthropic's open-source
// `code-simplifier@claude-plugins-official` plugin v1.0.0 (Apache-2.0;
// agents/code-simplifier.md). Embedded in the prompt so EVERY CLI provider gets
// the real simplifier behavior — in the Haive sandbox no provider has the plugin
// installed (auth volumes carry credentials, not plugins). Point 2 is
// generalized: the original hardcoded its origin repo's standards (ES modules /
// arrow-function rules / React patterns), which are wrong for arbitrary target
// repos — the intent (apply the project's established standards) is kept.
const CODE_SIMPLIFIER_DEFINITION = [
  'You are an expert code simplification specialist focused on enhancing code clarity, consistency,',
  'and maintainability while preserving exact functionality. Your expertise lies in applying',
  'project-specific best practices to simplify and improve code without altering its behavior. You',
  'prioritize readable, explicit code over overly compact solutions. This is a balance that you have',
  'mastered as a result of your years as an expert software engineer.',
  '',
  'You will analyze recently modified code and apply refinements that:',
  '',
  '1. **Preserve Functionality**: Never change what the code does - only how it does it. All',
  '   original features, outputs, and behaviors must remain intact.',
  '',
  "2. **Apply Project Standards**: Follow the project's established coding standards — read its",
  '   CLAUDE.md / AGENTS.md / contributor docs when present, and infer conventions from the',
  '   surrounding code (module style, naming, error-handling patterns, formatting).',
  '',
  '3. **Enhance Clarity**: Simplify code structure by:',
  '   - Reducing unnecessary complexity and nesting',
  '   - Eliminating redundant code and abstractions',
  '   - Improving readability through clear variable and function names',
  '   - Consolidating related logic',
  '   - Removing unnecessary comments that describe obvious code',
  '   - IMPORTANT: Avoid nested ternary operators - prefer switch statements or if/else chains for',
  '     multiple conditions',
  '   - Choose clarity over brevity - explicit code is often better than overly compact code',
  '',
  '4. **Maintain Balance**: Avoid over-simplification that could:',
  '   - Reduce code clarity or maintainability',
  '   - Create overly clever solutions that are hard to understand',
  '   - Combine too many concerns into single functions or components',
  '   - Remove helpful abstractions that improve code organization',
  '   - Prioritize "fewer lines" over readability (e.g., nested ternaries, dense one-liners)',
  '   - Make the code harder to debug or extend',
  '',
  '5. **Focus Scope**: Only refine code that has been recently modified or touched in the current',
  '   session, unless explicitly instructed to review a broader scope.',
  '',
  'Your refinement process:',
  '',
  '1. Identify the recently modified code sections',
  '2. Analyze for opportunities to improve elegance and consistency',
  '3. Apply project-specific best practices and coding standards',
  '4. Ensure all functionality remains unchanged',
  '5. Verify the refined code is simpler and more maintainable',
  '6. Document only significant changes that affect understanding',
] as const;

export const codeSimplifyStep: StepDefinition<SimplifyDetect, SimplifyApply> = {
  metadata: {
    id: '07a-code-simplify',
    workflowType: 'workflow',
    index: 7.5,
    title: 'Phase 3.5: Code simplification',
    description:
      'A simplifier agent reduces unnecessary complexity in the implemented code without changing functionality; if it edits anything, one fixup agent verifies the spec still holds.',
    requiresCli: false,
    cliRoles: STEP_CLI_ROLES['07a-code-simplify'],
    // Rewrites existing working code; a weak local model is risky here. Block
    // local Ollama by default.
    unsafeForLocalModels: true,
  },

  async shouldRun(ctx: StepContext): Promise<boolean> {
    const task = await ctx.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, ctx.taskId),
      columns: { simplifyCode: true },
    });
    return task?.simplifyCode === true;
  },

  async detect(ctx: StepContext): Promise<SimplifyDetect> {
    const worktree = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-worktree-setup');
    const wt = worktree?.output as {
      worktreePath?: string;
      sandboxWorktreePath?: string;
    } | null;
    if (!wt?.worktreePath || !wt.sandboxWorktreePath) {
      throw new Error('07a-code-simplify requires 01-worktree-setup to have produced a worktree');
    }

    // Spec with the same precedence as 07-phase-2-implement (05a → 05 → 04).
    const plan = await loadPreviousStepOutput(ctx.db, ctx.taskId, '04-phase-0b-pre-planning');
    const quality = await loadPreviousStepOutput(ctx.db, ctx.taskId, '05-phase-0b5-spec-quality');
    const resolved = await loadPreviousStepOutput(ctx.db, ctx.taskId, '05a-resolve-spec-warnings');
    const spec =
      ((resolved?.output as { spec?: string } | null)?.spec ??
        (quality?.output as { spec?: string } | null)?.spec ??
        (plan?.output as { spec?: string } | null)?.spec) ||
      '';

    return {
      worktreePath: wt.worktreePath,
      sandboxWorktreePath: wt.sandboxWorktreePath,
      spec,
      implementationFiles: await collectImplementationFiles(ctx, wt.worktreePath),
    };
  },

  llm: {
    requiredCapabilities: ['tool_use', 'file_write'],
    timeoutMs: 30 * 60 * 1000,
    // Pass 0 — the simplifier (the vendored plugin definition + Haive's frame).
    buildPrompt: (args) => {
      const d = args.detected as SimplifyDetect;
      return [
        ...CODE_SIMPLIFIER_DEFINITION,
        '',
        '=== Your assignment ===',
        `An implementation just finished in the workspace: ${d.sandboxWorktreePath}`,
        'Your current working directory has the workspace mounted; work on the files there.',
        d.implementationFiles.length > 0
          ? `The recently modified code (your Focus Scope):\n- ${d.implementationFiles.join('\n- ')}`
          : 'Determine the recently-implemented files from the workspace — they are your Focus Scope.',
        '',
        'If you find areas to simplify, edit the files directly. If the code is already clean,',
        'report that no changes were needed.',
        'Do NOT run git (it is unavailable in this environment — the orchestrator commits later)',
        'and do NOT run tests.',
        ...SEARCH_LADDER,
        '',
        'When finished emit ONE JSON object inside a ```json fenced code block with EXACTLY this shape:',
        '{ "files_simplified": ["path/one"], "changes_made": ["<brief description per simplification>"], "no_changes_needed": true|false }',
        '',
        '=== Spec (what the implementation must keep doing) ===',
        d.spec || '(no spec recorded)',
      ].join('\n');
    },
    bypassStub: () => ({ files_simplified: [], changes_made: [], no_changes_needed: true }),
  },

  loop: {
    // Two passes max: simplifier, then — only when it changed files — one fixup
    // verification pass. Never loops back to the simplifier (legacy contract).
    maxIterations: 2,
    resolveRole: (iteration) => (iteration === 0 ? ROLE_SIMPLIFIER : ROLE_FIXUP),
    shouldContinue: ({ applyOutput, iteration }) => {
      if (iteration > 0) return false;
      const out = applyOutput as SimplifyApply;
      return out.filesSimplified.length > 0;
    },
    buildIterationPrompt: ({ detected, previousIterations }) => {
      const d = detected as SimplifyDetect;
      const prior = priorSimplifier(previousIterations);
      return [
        'A code-simplifier agent just simplified the implementation in the workspace:',
        d.sandboxWorktreePath,
        'Your current working directory has the workspace mounted; work on the files there.',
        '',
        `Files it simplified:\n- ${(prior?.filesSimplified ?? []).join('\n- ') || '(unknown)'}`,
        `Changes it made:\n- ${(prior?.changesMade ?? []).join('\n- ') || '(not described)'}`,
        '',
        'Your job:',
        '1. Read the simplified files.',
        '2. Verify the simplifications did not break any functionality required by the spec below.',
        '3. If a simplification accidentally removed required behavior, restore it.',
        '4. Make ONLY the minimum fixes needed — do not re-add complexity.',
        'Do NOT run git (it is unavailable in this environment) and do NOT run tests.',
        '',
        'When finished emit ONE JSON object inside a ```json fenced code block with EXACTLY this shape:',
        '{ "fixes_needed": true|false, "fixes_made": ["<each correction, or empty>"] }',
        '',
        '=== Spec (the original requirements) ===',
        d.spec || '(no spec recorded)',
      ].join('\n');
    },
  },

  async apply(ctx, args): Promise<SimplifyApply> {
    // Pass 1 — fixup verification: merge with the pass-0 simplifier result.
    if (args.iteration > 0) {
      const fixup = parseFixupOutput(args.llmOutput ?? null);
      const prior = priorSimplifier(args.previousIterations);
      ctx.logger.info(
        { fixesNeeded: fixup.fixesNeeded, fixes: fixup.fixesMade.length },
        'simplification fixup verified',
      );
      return {
        ran: true,
        filesSimplified: prior?.filesSimplified ?? [],
        changesMade: prior?.changesMade ?? [],
        noChangesNeeded: prior?.noChangesNeeded ?? false,
        fixesNeeded: fixup.fixesNeeded,
        fixesMade: fixup.fixesMade,
        source: 'fixup',
      };
    }

    // Pass 0 — the simplifier. A parse miss is treated as no-changes so it can
    // never trigger a pointless fixup pass (mirrors 07's stub fallback).
    const parsed = parseSimplifierOutput(args.llmOutput ?? null);
    if (parsed) {
      ctx.logger.info(
        { filesSimplified: parsed.filesSimplified.length, noChanges: parsed.noChangesNeeded },
        'code simplification pass complete',
      );
      return {
        ran: true,
        filesSimplified: parsed.filesSimplified,
        changesMade: parsed.changesMade,
        noChangesNeeded: parsed.noChangesNeeded,
        fixesNeeded: false,
        fixesMade: [],
        source: 'simplifier',
      };
    }
    ctx.logger.info('code simplification output unparseable — treating as no changes');
    return {
      ran: true,
      filesSimplified: [],
      changesMade: [],
      noChangesNeeded: true,
      fixesNeeded: false,
      fixesMade: [],
      source: 'stub',
    };
  },
};
