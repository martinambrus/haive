import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { STEP_CLI_ROLES } from '@haive/shared';
import type { StepContext, StepDefinition, StepLoopPassRecord } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { briefFromTaskMeta, resolveSpecView } from './_spec-artifact.js';
import { recordLedgerEntry } from '../../task-ledger.js';
import { retrievalGuidanceLines } from '../_retrieval-guidance.js';
import { hasAnyKey, parseAgentJson } from './_agent-json.js';
import { QA_LENS_NUMBERED } from '../_qa-lenses.js';
import { SCOPE_FENCE_DOC_REPORT_ONLY, SCOPE_FENCE_REPORT_ONLY } from '../_scope-fence.js';
import {
  assertReviewableChange,
  changedFilesBlock,
  collectImplementationFiles,
  NO_CHANGE_SET_FALLBACK,
  isDocsOnlyChange,
  type ImplementationFileSet,
} from './_impl-changes.js';
import { loadTaskMeta } from './_task-meta.js';
import { loadHonoredConstraints } from './_fix-loop.js';
import { PROMPT_DEFECT_INSTRUCTION } from './_prompt-defect.js';
import { isStepGuidanceEnabled } from '../../guidance-context.js';
import {
  coerceReviewSeverity,
  numberedDimensionBlock,
  resolveReviewDimensions,
} from '@haive/shared/review';
import type { ReviewDimension, ReviewSeverity } from '@haive/shared/review';
import { resolveTaskReviewDimensions } from '../../review-dimension-context.js';
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
  /** What this change must deliver: the approved spec, or — on lightweight paths that
   *  skip 03/04/05 — the raw task title + description, the same brief 07 implements
   *  from. Never '' unless the task itself is untitled and undescribed. */
  spec: string;
  implementationFiles: ImplementationFileSet;
  /** Pre-formatted KNOWN TECHNICAL DEBT block from DAG execution ('' if none). */
  debtBlock: string;
  /** Prior objective/runtime fix-loop constraints the validator must not revert ('' if none). */
  honoredBlock: string;
  /** Env template ready with browserTesting on → a chrome-devtools MCP is wired to the
   *  running app's browser; the fixer pass verifies runtime-affecting fixes in-browser. */
  browserTesting: boolean;
  /** Learned-guidance capture is on for this task: the validator is invited to name an
   *  INSTRUCTION defect behind the issues it found. Resolved in detect() and carried on
   *  the payload because buildPrompt is pure and has no ctx. */
  promptDefectCapture: boolean;
  /** This change touched documentation only, so the validator runs the documentation
   *  protocol instead of the code one. Resolved in detect() for the same reason as
   *  promptDefectCapture above. */
  docsOnly: boolean;
  /** Review dimensions in scope for this run (ids from REVIEW_DIMENSIONS). Resolved
   *  in detect() from the task override falling back to the repository policy, and
   *  carried as IDS rather than objects so a replayed detect_output stays valid
   *  across a catalog change — buildPrompt re-resolves them against the current
   *  catalog and simply drops any id that no longer exists. */
  reviewDimensionIds: string[];
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
  /** Labels of the dimensions this run did NOT score, because the repository or the
   *  task scoped them out. Recorded so gate-2 can say so: a review that skipped a
   *  dimension produces exactly the same empty finding list as one that checked it
   *  and found nothing, and only this field tells them apart. */
  excludedDimensions: string[];
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
/** Step 7's dimension table, built from the dimensions in scope for this run.
 *
 *  The header is kept separate from the rows so an empty scope still tells the
 *  agent what to emit: the JSON contract below always asks for a `dimensions`
 *  array, and silently dropping the section would leave the agent to invent a
 *  table from the persona it inherited. */
function reviewDimensionSection(dimensions: readonly ReviewDimension[]): string[] {
  if (dimensions.length === 0) {
    return [
      'Step 7 - Review dimensions validation: this project has scoped every review dimension out of',
      'this run. Skip the dimension table and emit an empty "dimensions" array in your JSON.',
    ];
  }
  return [
    'Step 7 - Review dimensions validation (MANDATORY): for each dimension below ask "does the code,',
    'as written, match what the spec promised?" Score PASS / FAIL / N/A:',
    ...numberedDimensionBlock(dimensions),
  ];
}

function codeValidatorDefinition(dimensions: readonly ReviewDimension[]): readonly string[] {
  return [
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
    '(use code-navigation tools if available, else grep). The changed-file list names the lines',
    'this change wrote beside each path — read the rest of a file for context, and judge the change',
    'by what it wrote. A file listed with no line note has none recorded: treat all of it as',
    'changed.',
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
    ...reviewDimensionSection(dimensions),
    '',
    'Anti-patterns (what NOT to do): do not assume code is correct because it exists; do not skip',
    "edge-case validation; do not only check that code runs (check that it's RIGHT); do not miss",
    'missing functionality.',
    '',
    ...SCOPE_FENCE_REPORT_ONLY,
    '',
    'You may fix what your protocol REQUIRES you to fix (stale callers in Step 4, dead-code removal',
    'in Step 5) by editing files directly. All OTHER issues you find are reported, not fixed - a',
    'separate fix agent applies them.',
  ];
}

// The documentation validator, used when the change set is documentation only
// (isDocsOnlyChange). A separate protocol rather than the code one with most rows
// scored N/A: 12 of the 14 code dimensions cannot apply to prose, and the code
// protocol's Steps 4-6 tell the agent to search the whole repository for stale
// callers, delete dead code and check UI translation — repo-wide edit instructions
// that have no referent on a prose change and every reason to be absent from it.
//
// What it checks instead is what the README-quality benchmark measured 66 runs
// failing at. Two findings drive the content. Accuracy dominates the score and one
// hallucination costs about six composite points, so Step 3 makes an uncitable claim
// an issue rather than a stylistic note. And the gap between a very good document and
// the rubric's ceiling was consistently DISCLOSURE, not error: top runs stated weak
// password hashing and a hardcoded default salt as neutral facts, never telling the
// reader either was a risk. That is Step 4, and it is the reason this protocol exists.
const DOC_VALIDATOR_DEFINITION = [
  'You are the Documentation Validator, a specialized agent that verifies a documentation change',
  'against the repository it describes. This change touched documentation only, so there is no',
  'code behaviour to trace. What you verify is whether every statement in the document is TRUE of',
  'this tree, and whether the document tells its reader what that reader needs to know.',
  '',
  'Core responsibilities:',
  '1. Verify every factual claim against the source, by reading the source',
  '2. Catch invented mechanisms - an API, table, column, config key or flow this repo lacks',
  '3. Catch undisclosed risk - a mechanism stated neutrally that the reader must be warned about',
  '4. Catch omissions - something a reader of this document needs and will not find in it',
  '',
  'Execution protocol:',
  '',
  'Step 1 - Read the brief below: what this document was asked to cover.',
  '',
  'Step 2 - Read the changed documentation files completely.',
  '',
  'Step 3 - Verify claim by claim (THE MAIN WORK). For EVERY factual statement the document',
  'makes, locate the code, config or metadata that supports it and record the file:line. A claim',
  'you cannot locate in this tree is an issue: severity high when a reader would ACT on it (setup',
  'and install steps, commands, API shapes, schema, file paths, dependencies), medium otherwise.',
  'Do not accept a claim because it is plausible, conventional for this kind of project, or',
  'stated confidently - the failure mode here is a fluent document that is quietly wrong, and',
  'confident phrasing is what makes it dangerous rather than what makes it true.',
  '',
  'Step 4 - Security posture pass (THE ONE MOST OFTEN MISSED). For each security-relevant',
  'mechanism the document names - authentication, password or credential storage, session and',
  'identity handling, input validation, output escaping, file upload, access control, CSRF or',
  'equivalent request authenticity, cryptography, secrets in the tree - read the CODE, decide',
  'whether it is sound by current practice, and then check what the document SAYS about it.',
  'Describing a weak mechanism as a neutral fact is an ISSUE: a reader who is not already an',
  'expert cannot tell it is a risk, and the document is where they were entitled to learn it.',
  'Naming the mechanism is not disclosure - saying plainly that it is weak, and why, is.',
  'The reverse is equally an issue: do not invent or imply a weakness the code does not have. If',
  'a mechanism is sound, the absence of a warning about it is correct.',
  '',
  'Step 5 - Review dimensions validation (MANDATORY): score each dimension PASS / FAIL / N/A:',
  '1. Factual accuracy - every stated fact is traceable to a file:line in this repository',
  '   (cross-reference Step 3)',
  '2. Security posture disclosure - every security-relevant mechanism the document names is',
  '   labelled safe or unsafe rather than described neutrally (cross-reference Step 4)',
  '3. Coverage - the subsystems a reader of this document must know about are present; note any',
  '   the document silently omits',
  '4. No invention - no API, table, column, config key, command or dependency that does not',
  '   exist in this tree',
  '5. No harness bleed - nothing belonging to the sandbox, container or toolchain this agent',
  '   runs in is presented as a fact about the project',
  '6. Currency - version numbers, release metadata, licence and author claims match the tree',
  '',
  'Anti-patterns (what NOT to do): do not verify prose against other prose - a claim repeated in',
  'two documents is still unverified; do not treat the document as correct because it reads well;',
  'do not report style preferences as issues; do not pad the document with generic sections that',
  'say nothing about THIS project.',
  '',
  ...SCOPE_FENCE_DOC_REPORT_ONLY,
  '',
  'CITE OR DROP. Every issue you file must carry the file:line that proves it, and every',
  'correction you require must be supportable the same way. If you cannot cite it, do not require',
  'it - an unsupported "improvement" written into the document is a new false claim, which is the',
  'exact defect you are here to prevent, and it costs more than the omission it replaced.',
  '',
  'You fix nothing yourself. Every issue you find is reported; a separate fix agent applies them.',
] as const;

/** The protocol this pass runs. Documentation-only changes get their own; everything
 *  else gets the code protocol, byte-for-byte as before this branch existed. */
function validatorDefinition(
  docsOnly: boolean,
  dimensions: readonly ReviewDimension[],
): readonly string[] {
  return docsOnly ? DOC_VALIDATOR_DEFINITION : codeValidatorDefinition(dimensions);
}

/** Re-resolve the stored ids against the current catalog. Both prompt builders go
 *  through here so the validator and its re-validation pass cannot disagree about
 *  what is in scope mid-loop. */
function dimensionsFor(d: ValidateDetect): ReviewDimension[] {
  return resolveReviewDimensions(d.reviewDimensionIds).enabled;
}

/** The evidence bar for the FIXER pass on a documentation-only change. The validator
 *  carries its own copy inside DOC_VALIDATOR_DEFINITION; the fixer never receives that
 *  definition, and the fixer is the pass that writes the text. */
const DOC_FIXER_EVIDENCE_BAR = [
  '',
  'CITE OR DROP. You are editing a document that a reader will trust. Every sentence you add',
  'or change must be supported by something you have actually read in this repository - name',
  'the file:line in your notes for each one. If you cannot support a correction, do not write',
  'it: say so in `notes` and leave the gap. An invented sentence is a worse outcome than the',
  'omission it replaced, because the omission was visible and the invention is not.',
  'Fix the document. Do NOT edit application code, configuration or tooling to make a sentence',
  'true - if an issue can only be resolved that way, leave it and explain in `notes`.',
] as const;

/** Heading over the brief. On lightweight paths there is no spec document at all and
 *  the brief is the task title + description, so calling it "Spec" would tell the
 *  agent to expect a structure that was never written. */
function specHeading(docsOnly: boolean): string {
  return docsOnly
    ? '=== Brief (what the document was asked to cover) ==='
    : '=== Spec (what the implementation must deliver) ===';
}

// What the report must contain, per protocol: the code pass names artifacts only it
// produces (refactoring impact, dead code, UI language), the documentation pass names
// its own. The JSON shape below is identical for both — `dimensions[].name` is free
// text, so a different dimension set needs no contract change.
function codeReportContents(dimensionCount: number): string[] {
  return [
    'First write your full validation report as markdown (verdict, requirement table, issues with',
    'file:line + suggested fix, refactoring-impact result, dead code removed, UI language findings,',
    dimensionCount > 0
      ? `the ${dimensionCount}-dimension table with PASS/FAIL/N/A).`
      : 'and no dimension table — every dimension is out of scope for this run).',
  ];
}

const DOC_REPORT_CONTENTS = [
  'First write your full validation report as markdown (verdict, the claim-by-claim verification',
  'with its file:line evidence, the security-posture findings, issues with the required',
  'correction for each, the dimension table with PASS/FAIL/N/A).',
] as const;

// What VALID means, per protocol. The code pass has to exclude the repairs its own
// protocol required it to make; the documentation pass fixes nothing, so it does not.
const CODE_VERDICT_KEY = [
  'verdict VALID = no blocking issues (the dead code you removed and stale callers you fixed do',
  'not count as open issues). verdict ISSUES_FOUND = open issues remain that a fix agent must',
  'address; list each one.',
] as const;

const DOC_VERDICT_KEY = [
  'verdict VALID = no blocking issues remain in the document. verdict ISSUES_FOUND = open issues',
  'remain that a fix agent must address; list each one.',
] as const;

function outputContract(docsOnly: boolean, dimensions: readonly ReviewDimension[]): string[] {
  // The example name is drawn from the set actually in scope: naming an excluded
  // dimension in the contract invites the agent to score it back in.
  const exampleDimension = docsOnly ? 'Security' : (dimensions[0]?.label ?? 'Security');
  return [
    ...(docsOnly ? [...DOC_REPORT_CONTENTS] : codeReportContents(dimensions.length)),
    'Then emit ONE JSON object inside a ```json fenced code block as the FINAL thing in your',
    'response, with EXACTLY this shape:',
    '{ "verdict": "VALID|ISSUES_FOUND", "summary": "<one paragraph>", "issues": [{ "severity":',
    '"critical|high|medium|low", "file": "path:line", "description": "...", "fix": "<required fix>" }],',
    `"dimensions": [{ "name": "${exampleDimension}", "status": "PASS|FAIL|N/A", "note": "<one line>" }] }`,
    ...(docsOnly ? DOC_VERDICT_KEY : CODE_VERDICT_KEY),
  ];
}

export const phase4ValidateStep: StepDefinition<ValidateDetect, ValidateApply> = {
  needsRuntime: 'if-serving',
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
      // A parse miss is not a finding. Its findingsSummary reads "_No issues found — nothing to
      // fix._", so looping back spends a whole fix round on a diagnosis that names no defect —
      // and hands the oscillation guard a phantom opposing side, which is how one task reached
      // a "07c vs 07b" gate whose 07b half said nothing at all. The raw report still reaches
      // the human at gate-2, which is where the UNPARSEABLE branch below intends it to land.
      if (out.verdict === 'UNPARSEABLE') return null;
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
    // Section index + a pointer to the on-disk `.haive/spec.md` gate 1 wrote, not the whole
    // document: this agent is a fresh CLI process that only needs to know what the change
    // must deliver, and can Read any section it needs in full.
    const view = await resolveSpecView(ctx);
    let spec = view.text;
    if (view.spec.trim().length === 0) {
      // Lightweight paths (quick_bugfix) skip 03/04/05, so no spec was ever drafted and
      // this used to render as "(no spec recorded)" while the protocol asked whether the
      // code matched what the spec promised — a validator grading against nothing. 07
      // already falls back to the raw task title + description here; share the helper so
      // the implementer and the validator cannot drift on what was asked.
      const meta = await loadTaskMeta(ctx.db, ctx.taskId);
      spec = briefFromTaskMeta(meta.title, meta.description);
    }

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

    // Hoisted out of the literal below because docsOnly is derived from it.
    const implementationFiles = await collectImplementationFiles(ctx, wt.worktreePath);

    return {
      worktreePath: wt.worktreePath,
      // Worktree is mounted alone at the workdir root — agent workspace is ctx.sandboxWorkdir.
      sandboxWorktreePath: ctx.sandboxWorkdir,
      spec,
      implementationFiles,
      debtBlock,
      honoredBlock: await loadHonoredConstraints(ctx),
      browserTesting,
      promptDefectCapture: await isStepGuidanceEnabled(ctx.db, ctx.taskId),
      docsOnly: isDocsOnlyChange(implementationFiles),
      reviewDimensionIds: (await resolveTaskReviewDimensions(ctx.db, ctx.taskId)).enabled.map(
        (d) => d.id,
      ),
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
      // Here rather than in detect() so a replayed detect_output is guarded too, and still
      // before dispatch. The re-validation prompt below needs no guard: it cannot be reached
      // without this pass having run. See assertReviewableChange.
      assertReviewableChange('07b-phase-4-validate', d.implementationFiles);
      return [
        ...validatorDefinition(d.docsOnly, dimensionsFor(d)),
        '',
        '=== Your assignment ===',
        `An implementation just finished in the workspace: ${d.sandboxWorktreePath}`,
        'Your current working directory has the workspace mounted; work on the files there.',
        changedFilesBlock(
          d.implementationFiles,
          'Changed files (your validation scope)',
          NO_CHANGE_SET_FALLBACK,
        ),
        d.debtBlock ? `\n${d.debtBlock}` : '',
        d.honoredBlock ? `\n${d.honoredBlock}` : '',
        '',
        'Do NOT run git (it is unavailable in this environment — the orchestrator commits later)',
        'and do NOT run the test suite (a later step does).',
        ...SEARCH_LADDER,
        '',
        ...outputContract(d.docsOnly, dimensionsFor(d)),
        '',
        specHeading(d.docsOnly),
        d.spec || '(no brief recorded)',
        d.promptDefectCapture ? `\n${PROMPT_DEFECT_INSTRUCTION}` : '',
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
          // The fixer is the agent that actually writes the prose, so the evidence bar has
          // to reach IT, not only the validator that raised the issue. Measured over 66
          // README runs: one unsupported claim costs about six composite points, against a
          // ceiling only three points above the best unaided run — so an invented sentence
          // written while closing a gap costs more than the gap did.
          ...(d.docsOnly ? DOC_FIXER_EVIDENCE_BAR : []),
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
          'Put anything you established about this sandbox, its tooling or its runtime into',
          '`notes` (including what you ruled out) — later agents are fresh processes and are',
          'given your notes so they need not re-derive it.',
          '',
          d.docsOnly
            ? '=== Brief (what the document was asked to cover) ==='
            : '=== Spec (the original requirements) ===',
          d.spec || '(no brief recorded)',
        ].join('\n');
      }
      // Validator re-pass after fixes.
      const fixes = accumulatedFixes(previousIterations);
      return [
        ...validatorDefinition(d.docsOnly, dimensionsFor(d)),
        '',
        '=== Your assignment (RE-VALIDATION) ===',
        `A fix agent just addressed your previous findings in the workspace: ${d.sandboxWorktreePath}`,
        'Your current working directory has the workspace mounted; work on the files there.',
        fixes.length > 0 ? `Fixes the fix agent reported:\n- ${fixes.join('\n- ')}` : '',
        changedFilesBlock(d.implementationFiles, 'Changed files (your validation scope)', ''),
        // The notes were measured before the fix agent ran, so its edits have shifted them.
        // They still say which PART of a file this change is, which is what they are for —
        // but an exact line number from them is no longer exact, and a reviewer told
        // otherwise would report a defect at the wrong location.
        'The line notes above were recorded BEFORE the fix agent edited these files, so treat',
        'them as approximate now: they still show which part of each file this change is, but',
        'take exact line numbers from the file in front of you, not from the list.',
        d.debtBlock ? `\n${d.debtBlock}` : '',
        d.honoredBlock ? `\n${d.honoredBlock}` : '',
        '',
        'Re-validate from scratch — verify the fixes hold AND nothing else broke.',
        'Do NOT run git and do NOT run the test suite.',
        ...SEARCH_LADDER,
        '',
        ...outputContract(d.docsOnly, dimensionsFor(d)),
        '',
        specHeading(d.docsOnly),
        d.spec || '(no brief recorded)',
        d.promptDefectCapture ? `\n${PROMPT_DEFECT_INSTRUCTION}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    },
  },

  async apply(ctx, args): Promise<ValidateApply> {
    const previous = args.previousIterations;
    const fixesSoFar = accumulatedFixes(previous);
    // What nobody scored. Recorded on EVERY return, including the parse-miss one:
    // gate-2 renders it so a narrowed review is never read as a clean one, and the
    // pass with the fewest findings is exactly the pass where that matters most.
    const excludedDimensions = resolveReviewDimensions(
      (args.detected as ValidateDetect).reviewDimensionIds,
    ).excluded.map((d) => d.label);
    const validatorPasses = previous.filter(
      (p) => (p.applyOutput as ValidateApply | undefined)?.source !== 'fixer',
    ).length;

    // Fixer pass: record fixes, carry the latest validator state forward.
    if (roleForIteration(args.iteration) === ROLE_FIXER) {
      const fixer = parseFixerOutput(args.llmOutput ?? null);
      const prior = latestValidator(previous);
      const allFixes = [...fixesSoFar, ...fixer.fixesMade];
      ctx.logger.info({ fixes: fixer.fixesMade.length }, 'phase-4 fixer pass complete');
      // No-op for empty text. `notes` is where the contract asks the fixer to put what it
      // established about the sandbox, so later agents inherit it instead of re-probing.
      await recordLedgerEntry(ctx.db, ctx.taskId, ctx.taskStepId, {
        stepId: '07b-phase-4-validate',
        round: ctx.round,
        text: fixer.notes,
      });
      return {
        verdict: prior?.verdict ?? 'ISSUES_FOUND',
        summary: prior?.summary ?? '',
        issues: prior?.issues ?? [],
        dimensions: prior?.dimensions ?? [],
        excludedDimensions,
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
            cliInvocationId: args.llmInvocationId ?? null,
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
      await recordLedgerEntry(ctx.db, ctx.taskId, ctx.taskStepId, {
        stepId: '07b-phase-4-validate',
        round: ctx.round,
        text: parsed.summary,
      });
      return {
        verdict: parsed.verdict,
        summary: parsed.summary,
        issues: parsed.issues,
        dimensions: parsed.dimensions,
        excludedDimensions,
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
      excludedDimensions,
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
