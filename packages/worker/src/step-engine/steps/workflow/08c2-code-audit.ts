import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { retrievalGuidanceLines } from '../_retrieval-guidance.js';
import { parseJsonLoose } from '../_fenced-json.js';
import { collectImplementationFiles } from './_impl-changes.js';
import { INSIGHTS_INSTRUCTION } from './08e-insights-triage.js';

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
  implementationFiles: string[];
}

interface AuditFinding {
  severity?: string;
  path?: string;
  lines?: string;
  issue?: string;
  fix?: string;
}

interface CodeAuditApply {
  audited: boolean;
  findings: AuditFinding[];
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
  '{ "findings": [ { "severity": "critical|warning|suggestion", "path": "<file>", "lines": "<start-end>", "issue": "<what is wrong vs the spec>", "fix": "<concrete fix>" } ] }',
  'If the code faithfully implements the spec, return an empty findings array.',
] as const;

/** Salvage a fenced-JSON object from the auditor output (object passes through). */
function fencedCandidate(raw: unknown): unknown {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  return parseJsonLoose(raw);
}

export function parseCodeAuditFindings(raw: unknown): AuditFinding[] {
  const obj = fencedCandidate(raw);
  if (!obj || typeof obj !== 'object') return [];
  const findings = (obj as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) return [];
  return findings
    .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
    .map((f) => ({
      severity: typeof f.severity === 'string' ? f.severity : undefined,
      path: typeof f.path === 'string' ? f.path : undefined,
      lines: typeof f.lines === 'string' ? f.lines : undefined,
      issue: typeof f.issue === 'string' ? f.issue : undefined,
      fix: typeof f.fix === 'string' ? f.fix : undefined,
    }));
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
    const plan = await loadPreviousStepOutput(ctx.db, ctx.taskId, '04-phase-0b-pre-planning');
    const quality = await loadPreviousStepOutput(ctx.db, ctx.taskId, '05-phase-0b5-spec-quality');
    const resolved = await loadPreviousStepOutput(ctx.db, ctx.taskId, '05a-resolve-spec-warnings');
    const spec =
      ((resolved?.output as { spec?: string } | null)?.spec ??
        (quality?.output as { spec?: string } | null)?.spec ??
        (plan?.output as { spec?: string } | null)?.spec) ||
      '';
    return {
      spec,
      implementationFiles: await collectImplementationFiles(ctx, wt.worktreePath),
    };
  },

  llm: {
    requiredCapabilities: ['tool_use'],
    timeoutMs: AUDIT_TIMEOUT_MS,
    buildPrompt: (args) => {
      const d = args.detected as CodeAuditDetect;
      return [
        ...AUDIT_RULES,
        '',
        d.implementationFiles.length > 0
          ? `Changed files to review (read each in full):\n- ${d.implementationFiles.join('\n- ')}`
          : 'Determine the recently-changed files from the workspace and read each in full.',
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

  async apply(_ctx, args): Promise<CodeAuditApply> {
    return { audited: true, findings: parseCodeAuditFindings(args.llmOutput ?? null) };
  },
};
