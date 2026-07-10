import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { STEP_CLI_ROLES } from '@haive/shared';
import type { StepContext, StepDefinition, StepLoopPassRecord } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { retrievalGuidanceLines } from '../_retrieval-guidance.js';
import { hasAnyKey, parseAgentJson } from './_agent-json.js';
import { QA_LENS_NUMBERED } from '../_qa-lenses.js';
import { collectImplementationFiles } from './_impl-changes.js';
import { loadHonoredConstraints } from './_fix-loop.js';
import { coerceReviewSeverity } from '@haive/shared/review';
import type { ReviewSeverity } from '@haive/shared/review';
import { recordReviewFindings, splitLocation } from './_review-findings.js';
import { getTaskEnvTemplate } from '../env-replicate/_shared.js';
import { ensureAppServing } from './_app-runtime.js';
import { startBrowserDesktop } from '../../../sandbox/ddev-runner.js';
import { startBrowserDesktop as startAppBrowserDesktop } from '../../../sandbox/app-runner.js';

// Phase 4 — Implementation validation (legacy phase4-validation.md + the
// implementation-validator agent). An LLM validator checks what the test suite
// cannot: spec compliance / logic / edge cases, refactoring impact across the
// WHOLE codebase (stale callers of renamed/removed functions are blocking),
// dead-code removal in modified files, UI language, and a 14-dimension
// code-vs-spec cross-check. Issues feed a fix loop (validator <-> fixer, the
// 05-spec-quality two-role pattern) for up to 5 rounds; budget exhaustion with
// open issues escalates to the user at gate-2 (which surfaces the verdict).
// Mandatory for workflow tasks (legacy ran it unconditionally). No form.

const ROLE_VALIDATOR = 'validator';
const ROLE_FIXER = 'fixer';
const REPORT_CAP = 16_000;
// A file the validator re-flags across this many distinct validator passes is
// treated as non-converging churn: the fixer keeps touching it without the
// validator clearing it (the ext/mysql-enablement thrash that ran all 5 rounds).
// The loop then stops and surfaces to the human at gate-2 instead of burning more
// rounds or routing back to implement. Tunable.
const CHURN_FILE_THRESHOLD = 3;

function roleForIteration(iteration: number): string {
  return iteration % 2 === 0 ? ROLE_VALIDATOR : ROLE_FIXER;
}

interface ValidateDetect {
  worktreePath: string;
  sandboxWorktreePath: string;
  spec: string;
  implementationFiles: string[];
  /** Pre-formatted KNOWN TECHNICAL DEBT block from DAG execution ('' if none). */
  debtBlock: string;
  /** Prior objective/runtime fix-loop constraints the validator must not revert ('' if none). */
  honoredBlock: string;
  /** Env template ready with browserTesting on → a chrome-devtools MCP is wired to the
   *  running app's browser; the fixer pass verifies runtime-affecting fixes in-browser. */
  browserTesting: boolean;
}

export type ValidationVerdict = 'VALID' | 'ISSUES_FOUND' | 'UNPARSEABLE';

interface ValidationIssue {
  severity: ReviewSeverity;
  file?: string;
  description: string;
  fix?: string;
}

interface DimensionResult {
  name: string;
  status: 'PASS' | 'FAIL' | 'N/A';
  note?: string;
}

interface ValidateApply {
  verdict: ValidationVerdict;
  summary: string;
  issues: ValidationIssue[];
  dimensions: DimensionResult[];
  /** False when the validator re-flagged the same file across CHURN_FILE_THRESHOLD
   *  validator passes (non-converging). A false value routes the run to a human
   *  decision at gate-2 instead of another fix round. */
  converged: boolean;
  /** Files that tripped the churn guard (empty when converged). */
  churnFiles: string[];
  /** Fixes accumulated across fixer passes. */
  fixesApplied: string[];
  /** Bullet-point markdown of the run's outcome (verdict + all fixes applied across
   *  iterations + any remaining issues), shown read-only on the done card. */
  findingsSummary: string;
  /** Tail of the latest validator pass's raw output (the markdown report). */
  report: string;
  validatorPasses: number;
  source: 'validator' | 'fixer' | 'stub';
}

const validatorOutputSchema = z.object({
  verdict: z.enum(['VALID', 'ISSUES_FOUND']),
  summary: z.string().default(''),
  issues: z
    .array(
      z.object({
        severity: z
          .unknown()
          .optional()
          .transform((v) => coerceReviewSeverity(v, 'medium')),
        file: z.string().optional(),
        description: z.string(),
        fix: z.string().optional(),
      }),
    )
    .default([]),
  dimensions: z
    .array(
      z.object({
        name: z.string(),
        status: z.enum(['PASS', 'FAIL', 'N/A']).default('N/A'),
        note: z.string().optional(),
      }),
    )
    .default([]),
});

const fixerOutputSchema = z.object({
  fixes_made: z.array(z.string()).default([]),
  notes: z.string().default(''),
});

/** The fixer's own report names the fixes it made, or the notes it left; a config it
 *  quoted names neither. `notes` is in the gate because a fixer that changed nothing
 *  legitimately reports only notes. The validator needs no key gate — its schema
 *  REQUIRES a verdict — but it still needs the candidate scan, or a JSON file it quoted
 *  is the only thing it gets judged on. */
const FIXER_KEYS = ['fixes_made', 'notes'] as const;

/** Parse the validator's final fenced JSON; null when unparseable (the step then
 *  records UNPARSEABLE — no fix loop, surfaced as a warning at gate-2). */
export function parseValidatorOutput(raw: unknown): {
  verdict: 'VALID' | 'ISSUES_FOUND';
  summary: string;
  issues: ValidationIssue[];
  dimensions: DimensionResult[];
} | null {
  return parseAgentJson(raw, (candidate) => {
    const parsed = validatorOutputSchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  });
}

/** Parse the fixer's JSON; falls back to "no fixes recorded" on a parse miss. */
export function parseFixerOutput(raw: unknown): { fixesMade: string[]; notes: string } {
  return (
    parseAgentJson(raw, (candidate) => {
      if (!hasAnyKey(candidate, FIXER_KEYS)) return null;
      const parsed = fixerOutputSchema.safeParse(candidate);
      if (!parsed.success) return null;
      return { fixesMade: parsed.data.fixes_made, notes: parsed.data.notes };
    }) ?? { fixesMade: [], notes: '' }
  );
}

/** Latest validator (or stub) pass — its verdict/issues drive the fixer and are
 *  carried forward until the next validator pass re-scores (the 05 pattern). */
function latestValidator(previous: StepLoopPassRecord[]): ValidateApply | null {
  for (let i = previous.length - 1; i >= 0; i -= 1) {
    const out = previous[i]?.applyOutput as ValidateApply | undefined;
    if (out && (out.source === 'validator' || out.source === 'stub')) return out;
  }
  return null;
}

function accumulatedFixes(previous: StepLoopPassRecord[]): string[] {
  const fixes: string[] = [];
  for (const p of previous) {
    const out = p.applyOutput as ValidateApply | undefined;
    if (out?.source === 'fixer') fixes.push(...out.fixesApplied.slice(fixes.length));
  }
  const last = previous[previous.length - 1]?.applyOutput as ValidateApply | undefined;
  return last ? last.fixesApplied : fixes;
}

/** Strip a trailing `:line` (or `:line:col`) so the same file flagged at different
 *  lines across passes is counted as one. */
function normalizeIssueFile(file?: string): string {
  if (!file) return '';
  return file.trim().replace(/:\d+(?::\d+)?$/, '');
}

/** Files the validator re-flagged in at least CHURN_FILE_THRESHOLD distinct
 *  validator passes — the fixer keeps editing them but the validator never clears
 *  them, so the loop is not converging there. Counts once per pass (a file flagged
 *  twice in one pass still counts as one). */
export function churnHotspots(issuesPerValidatorPass: ValidationIssue[][]): string[] {
  const counts = new Map<string, number>();
  for (const issues of issuesPerValidatorPass) {
    const filesThisPass = new Set<string>();
    for (const issue of issues) {
      const f = normalizeIssueFile(issue.file);
      if (f) filesThisPass.add(f);
    }
    for (const f of filesThisPass) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n >= CHURN_FILE_THRESHOLD).map(([f]) => f);
}

/** Issue lists from every prior validator (or stub) pass, oldest first — the input
 *  to the churn detector. */
function priorValidatorIssueLists(previous: StepLoopPassRecord[]): ValidationIssue[][] {
  const lists: ValidationIssue[][] = [];
  for (const p of previous) {
    const out = p.applyOutput as ValidateApply | undefined;
    if (out && (out.source === 'validator' || out.source === 'stub')) lists.push(out.issues);
  }
  return lists;
}

/** Bullet-point markdown of the whole run for the done card: the final verdict,
 *  every fix applied across the validator<->fixer iterations, and any issue still
 *  open. Persists on the step so the user can review what was found and fixed. */
function buildFindingsSummary(
  verdict: ValidationVerdict,
  fixesApplied: string[],
  issues: ValidationIssue[],
  churnFiles: string[] = [],
): string {
  const lines: string[] = [`**Verdict:** ${verdict}`];
  if (churnFiles.length > 0) {
    lines.push(
      '',
      `**Did not converge** — re-flagged after repeated fix attempts: ${churnFiles.join(', ')}. Manual decision needed.`,
    );
  }
  if (fixesApplied.length > 0) {
    lines.push('', `### Fixes applied (${fixesApplied.length})`);
    for (const f of fixesApplied) lines.push(`- ${f}`);
  }
  if (issues.length > 0) {
    lines.push('', `### Remaining issues (${issues.length})`);
    for (const i of issues) {
      const loc = i.file ? `\`${i.file}\` — ` : '';
      lines.push(`- [${i.severity}] ${loc}${i.description}`);
    }
  }
  if (fixesApplied.length === 0 && issues.length === 0) {
    lines.push('', '_No issues found — nothing to fix._');
  }
  return lines.join('\n');
}

const SEARCH_LADDER = [
  'When you need existing patterns or context, search in this order:',
  ...retrievalGuidanceLines(),
] as const;

// The implementation-validator agent definition, ported from the legacy
// workflow's templates/agents/individual/implementation-validator.md (the same
// source the rest of the step content was ported from). Framework-specific API
// names are kept as EXAMPLES ("e.g. ... or your framework's equivalent") so the
// validator works on any target repo; the legacy RAG/LSP sections are replaced
// by the house search ladder and "code-navigation tools if available".
const VALIDATOR_DEFINITION = [
  'You are the Implementation Validator, a specialized agent that verifies implementation',
  'correctness before browser testing begins. You catch logic errors early.',
  '',
  'Core responsibilities:',
  '1. Verify Spec Compliance - the code does what the spec says',
  '2. Check Logic Correctness - algorithms and conditionals are right',
  '3. Validate Edge Cases - boundary conditions are handled',
  '4. Confirm Error Handling - failures are handled gracefully',
  '5. Detect and REMOVE Dead Code - unused functions/code left behind by refactoring',
  '6. Validate All Review Dimensions - verify the actual code satisfies each dimension the spec',
  '   promised; mismatches between spec promises and code are validation failures.',
  '',
  'Execution protocol:',
  '',
  'Step 1 - Review the specification: functional requirements, edge cases, error handling.',
  '',
  'Step 2 - Read the implementation: each changed file completely; map code flow to requirements',
  '(use code-navigation tools if available, else grep).',
  '',
  'Step 3 - Validate logic: for each requirement verify the code implements it, the logic is',
  'correct, edge cases are handled, errors are handled. Trace execution mentally with sample data;',
  'check boundary conditions (0, 1, max, null); verify conditional branches; check loop termination.',
  '',
  'Step 3.5 - Failure, replay and safeguard pass: beyond happy-path correctness, evaluate the change',
  'against each of these four questions and record any it fails as an issue (this is where the most',
  'expensive bugs hide — a right line that should exist and does not):',
  QA_LENS_NUMBERED,
  '',
  'Step 4 - Refactoring impact check (HIGH PRIORITY, WHOLE CODEBASE, BLOCKING): if ANY function was',
  'renamed or removed in this implementation, search the ENTIRE codebase for calls to the old name',
  '(grep -rn / find-references). If references exist outside the modified files, UPDATE those',
  'callers to the new name (or restore the old function if removal was premature). FAIL if any old',
  'name is still called anywhere. Document every change made to external files.',
  '',
  'Step 5 - Dead code detection (SCOPED TO MODIFIED FILES ONLY - do not scan the whole codebase):',
  'unused functions (zero references), unused variables, unreachable code after return/exit,',
  'commented-out code, deprecated functions replaced in this change. REMOVE dead code immediately -',
  'do not leave it "for reference"; git history exists for that.',
  '',
  "Step 6 - UI language validation: all new/modified user-facing strings match the project's UI",
  'language (from project config such as .claude/project-config.yaml ui_language when present, else',
  'infer from the existing UI strings) and are wrapped in the translation mechanism the project',
  'uses (e.g. t() / framework equivalent). Check labels, options, error messages, descriptions.',
  '',
  'Step 7 - Review dimensions validation (MANDATORY): for each dimension below ask "does the code,',
  'as written, match what the spec promised?" Score PASS / FAIL / N/A:',
  '1. Security - spec-named inputs validated/escaped at entry; required permission/authz gates',
  '   present; no hardcoded secrets; parameterized queries; output escaped (e.g. check_plain()/',
  "   filter_xss() or your framework's escaping)",
  '2. Maintainability - no hidden complexity that should be config; no new helper duplicating an',
  '   existing function; new code in the right file/module',
  '3. Testability - every spec-listed error branch is triggerable; functions not monolithic; no',
  '   hidden time/random/network dependencies (or isolated behind an injectable seam)',
  '4. Usability - user-facing strings exist and are correct; error messages user-friendly;',
  '   confirmation prompts for destructive actions the spec names (visual checks happen later in',
  '   browser testing)',
  '5. Stability - dependency failures (DB, HTTP, file IO) caught and handled per spec; no empty',
  '   catch blocks; any write/charge/external-effect that can run twice (retry, redelivery,',
  '   double-submit) is guarded against double-writes (idempotency key, dedupe, upsert, or unique',
  '   constraint), whether or not the spec named it idempotent',
  '6. Performance - no new N+1 queries; new WHERE/ORDER BY columns indexed per spec; no blocking',
  '   external HTTP on the request hot path',
  '7. Observability - failure paths log with context; no silent catches (log OR rethrow OR typed',
  '   error); logged context sufficient to debug from the log alone',
  '8. Operational Readiness - migrations (e.g. hook_update_N or framework equivalent) idempotent',
  '   and present where required; post-deploy cache clears documented; cron impact reasonable',
  '9. Data Integrity - atomic operations wrapped in transactions; cascading deletes honored;',
  '   server-side validation at every boundary; read-modify-write races identified',
  '10. Developer Experience - matches existing structure and naming; comments only where',
  '    non-obvious; no "TODO: figure out later" left in code',
  '11. Accessibility - ARIA labels per spec; form fields labeled; keyboard navigation works; color',
  '    not the sole carrier of information',
  '12. Internationalization - cross-reference Step 6 findings',
  '13. Backward Compatibility - renamed functions/hooks/services have all callers updated',
  '    (cross-reference Step 4); schema drops/renames have a migration path; public API signatures',
  '    unchanged or additive',
  '14. Privacy / Compliance - spec-named PII stored/logged per spec; audit trail for sensitive',
  '    actions; retention rules respected',
  '',
  'Anti-patterns (what NOT to do): do not assume code is correct because it exists; do not skip',
  "edge-case validation; do not only check that code runs (check that it's RIGHT); do not miss",
  'missing functionality.',
  '',
  'You may fix what your protocol REQUIRES you to fix (stale callers in Step 4, dead-code removal',
  'in Step 5) by editing files directly. All OTHER issues you find are reported, not fixed - a',
  'separate fix agent applies them.',
] as const;

function outputContract(): string[] {
  return [
    'First write your full validation report as markdown (verdict, requirement table, issues with',
    'file:line + suggested fix, refactoring-impact result, dead code removed, UI language findings,',
    'the 14-dimension table with PASS/FAIL/N/A).',
    'Then emit ONE JSON object inside a ```json fenced code block as the FINAL thing in your',
    'response, with EXACTLY this shape:',
    '{ "verdict": "VALID|ISSUES_FOUND", "summary": "<one paragraph>", "issues": [{ "severity":',
    '"critical|high|medium|low", "file": "path:line", "description": "...", "fix": "<required fix>" }],',
    '"dimensions": [{ "name": "Security", "status": "PASS|FAIL|N/A", "note": "<one line>" }] }',
    'verdict VALID = no blocking issues (the dead code you removed and stale callers you fixed do',
    'not count as open issues). verdict ISSUES_FOUND = open issues remain that a fix agent must',
    'address; list each one.',
  ];
}

export const phase4ValidateStep: StepDefinition<ValidateDetect, ValidateApply> = {
  metadata: {
    id: '07b-phase-4-validate',
    workflowType: 'workflow',
    index: 7.7,
    title: 'Phase 4: Implementation validation',
    description:
      'An implementation-validator agent checks the code against the approved spec (logic, edge cases, refactoring impact, dead code, UI language, review dimensions) and loops a fixer agent until valid.',
    requiresCli: false,
    cliRoles: STEP_CLI_ROLES['07b-phase-4-validate'],
  },

  // Fix-loop: if validation still reports issues after its internal fixer loop, route
  // back to implementation with the findings summary as the diagnosis.
  fixLoop: {
    // VALID passes do not loop. A churn bail (validator/fixer could not converge on
    // a file) also returns null: it surfaces at gate-2 for a human decision rather
    // than routing back to implement, where re-implementing the same churn would
    // just burn another round.
    evaluate: (out) => {
      if (out.verdict === 'VALID') return null;
      if ((out.churnFiles?.length ?? 0) > 0) return null;
      return {
        blocking: true,
        diagnosis: out.findingsSummary || out.summary || 'Validation found unresolved issues.',
      };
    },
  },

  async detect(ctx: StepContext): Promise<ValidateDetect> {
    const worktree = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-worktree-setup');
    const wt = worktree?.output as {
      worktreePath?: string;
      sandboxWorktreePath?: string;
    } | null;
    if (!wt?.worktreePath || !wt.sandboxWorktreePath) {
      throw new Error(
        '07b-phase-4-validate requires 01-worktree-setup to have produced a worktree',
      );
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

    // DAG runs: documented debt items must not be flagged (legacy debt awareness).
    let debtBlock = '';
    const dagPlan = await ctx.db.query.taskDagPlans.findFirst({
      where: eq(schema.taskDagPlans.taskId, ctx.taskId),
      columns: { mode: true },
    });
    if (dagPlan?.mode === 'dag') {
      const issues = await ctx.db
        .select({
          issueKey: schema.taskDagIssues.issueKey,
          title: schema.taskDagIssues.title,
          debtItems: schema.taskDagIssues.debtItems,
        })
        .from(schema.taskDagIssues)
        .where(eq(schema.taskDagIssues.taskId, ctx.taskId));
      const lines = issues
        .filter((i) => ((i.debtItems ?? []) as unknown[]).length > 0)
        .map((i) => `- ${i.issueKey} (${i.title}): ${JSON.stringify(i.debtItems).slice(0, 500)}`);
      if (lines.length > 0) {
        debtBlock = [
          'KNOWN TECHNICAL DEBT (do NOT flag these as issues):',
          ...lines,
          'These are documented compromises from DAG execution. Only flag them if they cause',
          'cascading problems in the merged codebase.',
        ].join('\n');
      }
    }

    const envTemplate = await getTaskEnvTemplate(ctx.db, ctx.taskId);
    const browserTesting =
      envTemplate?.status === 'ready' &&
      !!(envTemplate.declaredDeps as Record<string, unknown> | null)?.browserTesting;

    return {
      worktreePath: wt.worktreePath,
      sandboxWorktreePath: wt.sandboxWorktreePath,
      spec,
      implementationFiles: await collectImplementationFiles(ctx, wt.worktreePath),
      debtBlock,
      honoredBlock: await loadHonoredConstraints(ctx),
      browserTesting,
    };
  },

  llm: {
    requiredCapabilities: ['tool_use', 'file_write'],
    timeoutMs: 30 * 60 * 1000,
    // Bring up the headed app browser (idempotent) when the repo does browser testing so
    // the FIXER pass's chrome-devtools MCP connects to the LIVE app. Runs before each pass;
    // the static validator pass simply ignores it. Best-effort — never blocks the step.
    prepare: async ({ ctx, detected }) => {
      const d = detected as ValidateDetect;
      if (!d.browserTesting) return;
      try {
        const runtime = await ensureAppServing(ctx);
        if (runtime.mode === 'ddev') await startBrowserDesktop(runtime.handle);
        else if (runtime.mode === 'app-runner') await startAppBrowserDesktop(runtime.handle);
      } catch (err) {
        ctx.logger.warn({ err }, 'validation browser desktop bring-up failed (non-fatal)');
      }
    },
    // Pass 0 — the validator.
    buildPrompt: (args) => {
      const d = args.detected as ValidateDetect;
      return [
        ...VALIDATOR_DEFINITION,
        '',
        '=== Your assignment ===',
        `An implementation just finished in the workspace: ${d.sandboxWorktreePath}`,
        'Your current working directory has the workspace mounted; work on the files there.',
        d.implementationFiles.length > 0
          ? `Changed files (your validation scope):\n- ${d.implementationFiles.join('\n- ')}`
          : 'Determine the recently-implemented files from the workspace.',
        d.debtBlock ? `\n${d.debtBlock}` : '',
        d.honoredBlock ? `\n${d.honoredBlock}` : '',
        '',
        'Do NOT run git (it is unavailable in this environment — the orchestrator commits later)',
        'and do NOT run the test suite (a later step does).',
        ...SEARCH_LADDER,
        '',
        ...outputContract(),
        '',
        '=== Spec (what the implementation must deliver) ===',
        d.spec || '(no spec recorded)',
      ]
        .filter(Boolean)
        .join('\n');
    },
    bypassStub: () => ({ verdict: 'VALID', summary: 'bypass stub', issues: [], dimensions: [] }),
  },

  loop: {
    // Budget in ROUNDS; each round = validate + fix (legacy: 5 fix attempts,
    // then escalate — budget exhaustion surfaces at gate-2).
    maxIterations: 5,
    passesPerRound: 2,
    resolveRole: roleForIteration,
    shouldContinue: ({ applyOutput, iteration }) => {
      // After a fix (odd) always re-validate; after a validation (even) keep
      // going only while issues remain. UNPARSEABLE never loops. A churn-bailed
      // validator pass also stops — the human decides at gate-2.
      if (roleForIteration(iteration) === ROLE_FIXER) return true;
      const out = applyOutput as ValidateApply;
      if (out.verdict !== 'ISSUES_FOUND') return false;
      if ((out.churnFiles?.length ?? 0) > 0) return false;
      return true;
    },
    buildIterationPrompt: ({ detected, iteration, previousIterations }) => {
      const d = detected as ValidateDetect;
      if (roleForIteration(iteration) === ROLE_FIXER) {
        const prior = latestValidator(previousIterations);
        const issues = prior?.issues ?? [];
        return [
          'A validation agent reviewed the implementation in the workspace:',
          d.sandboxWorktreePath,
          'Your current working directory has the workspace mounted; work on the files there.',
          '',
          'Fix the following validation issues by editing files directly:',
          issues.length > 0
            ? issues
                .map(
                  (i, n) =>
                    `${n + 1}. [${i.severity}] ${i.file ?? ''} ${i.description}${i.fix ? ` — required fix: ${i.fix}` : ''}`,
                )
                .join('\n')
            : '(the validator reported issues but provided no list — re-read its report in the spec context and fix what is broken)',
          '',
          'Make ONLY the fixes needed - do not add unrelated changes.',
          'Do NOT run git and do NOT run the test suite.',
          ...SEARCH_LADDER,
          ...(d.browserTesting
            ? [
                '',
                '=== Verify runtime-affecting fixes in the browser (chrome-devtools MCP) ===',
                "A `chrome-devtools` MCP is connected to the running app's live browser. If any",
                'issue above affects runtime behavior or the UI, after editing use chrome-devtools',
                'to navigate to the affected view, reproduce the problem, and confirm your fix',
                'resolves it (no new console/network errors) before finishing. Purely static',
                'issues (dead code, naming) need no browser check.',
              ]
            : []),
          '',
          'When finished emit ONE JSON object inside a ```json fenced code block with EXACTLY this shape:',
          '{ "fixes_made": ["<each correction>"], "notes": "<caveats or empty>" }',
          '',
          '=== Spec (the original requirements) ===',
          d.spec || '(no spec recorded)',
        ].join('\n');
      }
      // Validator re-pass after fixes.
      const fixes = accumulatedFixes(previousIterations);
      return [
        ...VALIDATOR_DEFINITION,
        '',
        '=== Your assignment (RE-VALIDATION) ===',
        `A fix agent just addressed your previous findings in the workspace: ${d.sandboxWorktreePath}`,
        'Your current working directory has the workspace mounted; work on the files there.',
        fixes.length > 0 ? `Fixes the fix agent reported:\n- ${fixes.join('\n- ')}` : '',
        d.implementationFiles.length > 0
          ? `Changed files (your validation scope):\n- ${d.implementationFiles.join('\n- ')}`
          : '',
        d.debtBlock ? `\n${d.debtBlock}` : '',
        d.honoredBlock ? `\n${d.honoredBlock}` : '',
        '',
        'Re-validate from scratch — verify the fixes hold AND nothing else broke.',
        'Do NOT run git and do NOT run the test suite.',
        ...SEARCH_LADDER,
        '',
        ...outputContract(),
        '',
        '=== Spec (what the implementation must deliver) ===',
        d.spec || '(no spec recorded)',
      ]
        .filter(Boolean)
        .join('\n');
    },
  },

  async apply(ctx, args): Promise<ValidateApply> {
    const previous = args.previousIterations;
    const fixesSoFar = accumulatedFixes(previous);
    const validatorPasses = previous.filter(
      (p) => (p.applyOutput as ValidateApply | undefined)?.source !== 'fixer',
    ).length;

    // Fixer pass: record fixes, carry the latest validator state forward.
    if (roleForIteration(args.iteration) === ROLE_FIXER) {
      const fixer = parseFixerOutput(args.llmOutput ?? null);
      const prior = latestValidator(previous);
      const allFixes = [...fixesSoFar, ...fixer.fixesMade];
      ctx.logger.info({ fixes: fixer.fixesMade.length }, 'phase-4 fixer pass complete');
      return {
        verdict: prior?.verdict ?? 'ISSUES_FOUND',
        summary: prior?.summary ?? '',
        issues: prior?.issues ?? [],
        dimensions: prior?.dimensions ?? [],
        converged: prior?.converged ?? true,
        churnFiles: prior?.churnFiles ?? [],
        fixesApplied: allFixes,
        findingsSummary: buildFindingsSummary(
          prior?.verdict ?? 'ISSUES_FOUND',
          allFixes,
          prior?.issues ?? [],
          prior?.churnFiles ?? [],
        ),
        report: prior?.report ?? '',
        validatorPasses,
        source: 'fixer',
      };
    }

    // Validator pass.
    const report =
      typeof args.llmOutput === 'string'
        ? args.llmOutput.slice(-REPORT_CAP)
        : JSON.stringify(args.llmOutput ?? '').slice(-REPORT_CAP);
    const parsed = parseValidatorOutput(args.llmOutput ?? null);
    if (parsed) {
      // Churn only matters while issues remain; a VALID pass converged by definition.
      const churnFiles =
        parsed.verdict === 'ISSUES_FOUND'
          ? churnHotspots([...priorValidatorIssueLists(previous), parsed.issues])
          : [];
      ctx.logger.info(
        {
          verdict: parsed.verdict,
          issues: parsed.issues.length,
          dimensionFails: parsed.dimensions.filter((dim) => dim.status === 'FAIL').length,
          churnFiles: churnFiles.length,
        },
        'phase-4 validation pass complete',
      );
      // Every validator pass records; the dedupe index collapses an issue this step
      // row already saw this round, so a loop that re-flags the same file once per
      // pass leaves one row, not one per pass. blocking:false — 07b's fixLoop keys
      // on the verdict, not on a per-issue severity.
      await recordReviewFindings(
        ctx,
        '07b-phase-4-validate',
        parsed.issues.map((i) => {
          const { path, lines } = splitLocation(i.file);
          return {
            reviewerId: 'validator',
            severity: i.severity,
            issue: i.description,
            path,
            lines,
            fix: i.fix,
            blocking: false,
            raw: i,
          };
        }),
      );
      return {
        verdict: parsed.verdict,
        summary: parsed.summary,
        issues: parsed.issues,
        dimensions: parsed.dimensions,
        converged: churnFiles.length === 0,
        churnFiles,
        fixesApplied: fixesSoFar,
        findingsSummary: buildFindingsSummary(
          parsed.verdict,
          fixesSoFar,
          parsed.issues,
          churnFiles,
        ),
        report,
        validatorPasses: validatorPasses + 1,
        source: 'validator',
      };
    }
    // Parse miss: never wedge the loop, never silently pass — gate-2 shows it.
    ctx.logger.warn('phase-4 validator output unparseable — surfacing as UNPARSEABLE at gate-2');
    return {
      verdict: 'UNPARSEABLE',
      summary: 'Validator output could not be parsed; review the raw report at gate 2.',
      issues: [],
      dimensions: [],
      converged: true,
      churnFiles: [],
      fixesApplied: fixesSoFar,
      findingsSummary: buildFindingsSummary('UNPARSEABLE', fixesSoFar, []),
      report,
      validatorPasses: validatorPasses + 1,
      source: 'stub',
    };
  },
};
