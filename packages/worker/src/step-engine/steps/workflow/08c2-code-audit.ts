import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { resolveSpecView } from './_spec-artifact.js';
import { retrievalGuidanceLines } from '../_retrieval-guidance.js';
import { REPO_IS_DATA_LINES } from '../_untrusted-repo.js';
import { hasAnyKey, parseAgentJson } from './_agent-json.js';
import {
  changedFilesBlock,
  collectImplementationFiles,
  fileCoverage,
  type FileCoverage,
  type ImplementationFileSet,
} from './_impl-changes.js';
import { INSIGHTS_INSTRUCTION } from './08e-insights-triage.js';
import { coerceReviewSeverity } from '@haive/shared/review';
import type { ReviewSeverity } from '@haive/shared/review';
import { recordReviewFindings } from './_review-findings.js';

// 08c2 — broad code audit (report-only). A single one-shot auditor verifies the
// written code against the spec as broadly as possible — beyond the narrow
// peer/security scope of 08c — and reports every bug, missing piece, ambiguity,
// or wrong implementation relative to the spec. It FIXES nothing and has NO loop
// hook: its findings surface at gate-2 (09) as an advisory section, and a
// developer reject there folds them into the implement diagnosis with a
// validate-then-act instruction (so the implementer acts only on the valid,
// in-scope ones). Out-of-scope observations go to 08e via `## INSIGHTS`. Gated by
// tasks.broad_audit (default on); runs in full_workflow and plan_tasklist.

const AUDIT_TIMEOUT_MS = 30 * 60 * 1000;

interface CodeAuditDetect {
  spec: string;
  implementationFiles: ImplementationFileSet;
}

interface AuditFinding {
  severity: ReviewSeverity;
  path?: string;
  lines?: string;
  issue?: string;
  fix?: string;
}

interface CodeAuditApply {
  audited: boolean;
  findings: AuditFinding[];
  /** How much of the change the auditor was actually given; null when the step replayed
   *  a pre-coverage detect output. */
  coverage: FileCoverage | null;
}

const AUDIT_RULES = [
  'You are a broad, independent CODE AUDITOR. Separate narrow reviewers already checked this',
  'change for peer-quality and security; your job is the opposite — verify the WRITTEN code',
  'against the spec as broadly as possible and report ANY point where the code is buggy, has',
  'missing pieces, is ambiguous, or is otherwise wrongly implemented relative to what the spec',
  'requires. Read each changed file in full. Look beyond the happy path: edge / error cases,',
  'missing requirements, partial implementations, contradictions with the spec, and silently',
  'wrong behavior.',
  '',
  'When you need conventions or context, search in this order:',
  ...retrievalGuidanceLines(),
  '',
  'Blast radius — for every symbol whose signature, behavior, or schema this change modifies,',
  'use `rag_search` / grep to find its callers and dependents across the codebase and flag any',
  'the change breaks or adversely affects (stale callers, violated contracts, shared-state or',
  "concurrency effects, backward-compatibility breaks). Stay scoped to the change's connections",
  '— do NOT review unrelated code.',
  '',
  'You are REPORT-ONLY: do NOT edit code and do NOT run git. Emit IN-SCOPE problems (things',
  'wrong with THIS change versus the spec) as findings. Put VALID-but-OUT-OF-SCOPE observations',
  '(improvements unrelated to this task) in the `## INSIGHTS` section instead — never in findings.',
  '',
  'Emit ONE JSON object inside a ```json fenced code block with the shape:',
  '{ "findings": [ { "severity": "critical|high|medium|low", "path": "<file>", "lines": "<start-end>", "issue": "<what is wrong vs the spec>", "fix": "<concrete fix>" } ] }',
  'Reserve critical/high for a defect that would break behaviour, lose data, or expose a',
  'vulnerability. A finding that is real but leaves the code working is medium or low.',
  'If the code faithfully implements the spec, return an empty findings array.',
] as const;

/** The auditor's own report names a findings list; a code/config snippet it quoted as
 *  evidence does not. Without the gate an empty findings array — "the code is clean" —
 *  is what a quoted JSON file parses to. */
const AUDIT_KEYS = ['findings'] as const;

export function parseCodeAuditFindings(raw: unknown): AuditFinding[] {
  return (
    parseAgentJson(raw, (candidate) => {
      if (!hasAnyKey(candidate, AUDIT_KEYS)) return null;
      const findings = candidate.findings;
      if (!Array.isArray(findings)) return null;
      return findings
        .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
        .map((f) => ({
          // Advisory step: an unrecognised severity lands on medium, never on the
          // blocking tier.
          severity: coerceReviewSeverity(f.severity, 'medium'),
          path: typeof f.path === 'string' ? f.path : undefined,
          lines: typeof f.lines === 'string' ? f.lines : undefined,
          issue: typeof f.issue === 'string' ? f.issue : undefined,
          fix: typeof f.fix === 'string' ? f.fix : undefined,
        }));
    }) ?? []
  );
}

export const codeAuditStep: StepDefinition<CodeAuditDetect, CodeAuditApply> = {
  metadata: {
    id: '08c2-code-audit',
    workflowType: 'workflow',
    index: 8.85,
    title: 'Code audit (broad)',
    description:
      'Broad, report-only audit of the written code against the spec. Findings surface at gate 2; a reject there hands them to the implementer to validate and act on the valid ones.',
    requiresCli: false,
  },

  async shouldRun(ctx: StepContext): Promise<boolean> {
    const task = await ctx.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, ctx.taskId),
      columns: { broadAudit: true },
    });
    if (task?.broadAudit === false) return false;
    const worktree = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-worktree-setup');
    return Boolean((worktree?.output as { worktreePath?: string } | null)?.worktreePath);
  },

  async detect(ctx: StepContext): Promise<CodeAuditDetect> {
    const worktree = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-worktree-setup');
    const wt = worktree?.output as { worktreePath?: string } | null;
    if (!wt?.worktreePath) {
      throw new Error('08c2-code-audit requires 01-worktree-setup to have produced a worktree');
    }
    // Section index + a pointer to the on-disk `.haive/spec.md` gate 1 wrote, not the whole
    // document: this agent is a fresh CLI process that only needs to know what the change
    // must deliver, and can Read any section it needs in full.
    const spec = (await resolveSpecView(ctx)).text;
    return {
      spec,
      implementationFiles: await collectImplementationFiles(ctx, wt.worktreePath),
    };
  },

  llm: {
    requiredCapabilities: ['tool_use'],
    // Report-only audit: reads code, writes findings. See 04a-spec-audit.
    toolProfile: 'rag_only',
    timeoutMs: AUDIT_TIMEOUT_MS,
    buildPrompt: (args) => {
      const d = args.detected as CodeAuditDetect;
      return [
        ...AUDIT_RULES,
        '',
        ...REPO_IS_DATA_LINES,
        '',
        changedFilesBlock(
          d.implementationFiles,
          'Changed files to review (read each in full)',
          'Determine the recently-changed files from the workspace and read each in full.',
        ),
        '',
        '=== Spec (what the change must deliver) ===',
        d.spec || '(no spec recorded)',
        '',
        INSIGHTS_INSTRUCTION,
      ].join('\n');
    },
    // Smoke tests (HAIVE_TEST_BYPASS_LLM=1) get an empty audit.
    bypassStub: () => ({ findings: [] }),
  },

  async apply(ctx, args): Promise<CodeAuditApply> {
    const findings = parseCodeAuditFindings(args.llmOutput ?? null);
    // Report-only step: nothing here blocks, so every finding records blocking:false.
    await recordReviewFindings(
      ctx,
      '08c2-code-audit',
      findings
        .filter((f) => (f.issue ?? '').trim().length > 0)
        .map((f) => ({
          reviewerId: 'code-auditor',
          severity: f.severity,
          issue: f.issue as string,
          path: f.path,
          lines: f.lines,
          fix: f.fix,
          blocking: false,
          raw: f,
        })),
    );
    return {
      audited: true,
      findings,
      coverage: fileCoverage(args.detected.implementationFiles),
    };
  },
};
