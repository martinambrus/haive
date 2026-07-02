import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { parseJsonLoose } from '../_fenced-json.js';
import { retrievalGuidanceLines } from '../_retrieval-guidance.js';
import { INSIGHTS_INSTRUCTION } from './08e-insights-triage.js';

// 04a — broad spec audit (report-only). A single one-shot reviewer reads the
// drafted spec as broadly as possible — not just the fixed dimensions the gating
// 05-phase-0b5 reviewer scores — and reports every discrepancy, error, ambiguity
// or omission that would stop an LLM implementing the feature from this spec
// alone. It FIXES nothing: its findings are MERGED into 05a-resolve-spec-warnings,
// whose existing validate-then-act corrector applies only the valid ones, and the
// amended spec flows to gate-1. Out-of-scope observations go to 08e via the
// `## INSIGHTS` channel. Gated by tasks.broad_audit (default on); runs in
// full_workflow and plan_tasklist. Single llm dispatch, no loop hooks.

interface SpecAuditDetect {
  spec: string;
}

interface AuditFinding {
  dimension?: string;
  severity?: string;
  comment?: string;
}

interface SpecAuditApply {
  findings: AuditFinding[];
}

interface PrePlanningOutput {
  summary?: string;
  spec?: string;
}

/** The drafted spec to audit: the 04 pre-planning body (summary fallback). */
async function loadDraftSpec(ctx: StepContext): Promise<string> {
  const plan = await loadPreviousStepOutput(ctx.db, ctx.taskId, '04-phase-0b-pre-planning');
  const out = (plan?.output as PrePlanningOutput | null) ?? {};
  return out.spec ?? out.summary ?? '';
}

const AUDIT_RULES = [
  'You are a broad, independent SPEC AUDITOR. A separate narrow reviewer already scored',
  'this spec on a fixed set of dimensions; your job is the opposite — read the WHOLE spec',
  'and surface ANYTHING that would stop an LLM from implementing the feature correctly from',
  'this specification ALONE. Report discrepancies, incorrect statements, errors, mistakes,',
  'contradictions, ambiguities, omissions, untestable acceptance criteria, missing',
  'decisions, and references to code that does not exist — not only the narrow dimensions',
  'the gating reviewer checks.',
  '',
  'Verify every code / file / "follow the pattern from X" claim against the actual codebase,',
  'in this order:',
  ...retrievalGuidanceLines(),
  'A reference to code that does not exist is an error finding.',
  '',
  'Blast radius — for every component, contract, schema, or shared state this change touches,',
  'use `rag_search` to find its callers and dependents and flag where the spec fails to account',
  'for an adverse downstream effect (a broken caller, a changed contract, a migration or',
  "backward-compatibility gap, an affected integration point). Stay scoped to the change's",
  'connections — do NOT audit unrelated parts of the system.',
  '',
  'You are REPORT-ONLY: do NOT edit the spec — a separate corrector validates and applies',
  'your findings. Emit IN-SCOPE problems (things wrong with THIS spec / this feature) as',
  'findings. Put VALID-but-OUT-OF-SCOPE observations (improvements unrelated to this task)',
  'in the `## INSIGHTS` section instead — never in findings.',
  '',
  'Emit ONE JSON object inside a ```json fenced code block with the shape:',
  '{ "findings": [ { "dimension": "<short area or \\"ambiguity\\">", "severity": "warn"|"error", "comment": "<the problem; cite the spec section>" } ] }',
  'Use "error" for a gap or mistake that would cause a wrong, incomplete, or blocked',
  'implementation; "warn" for a genuine but non-blocking gap. If the spec is clean, return',
  'an empty findings array.',
] as const;

/** Salvage a fenced-JSON object from the auditor output (object passes through). */
function fencedCandidate(raw: unknown): unknown {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  return parseJsonLoose(raw);
}

/** Parse the auditor findings into the same shape 05 emits so 05a consumes them
 *  unchanged (dimension / severity warn|error / comment). */
export function parseSpecAuditFindings(raw: unknown): AuditFinding[] {
  const obj = fencedCandidate(raw);
  if (!obj || typeof obj !== 'object') return [];
  const findings = (obj as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) return [];
  return findings
    .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
    .map((f) => ({
      dimension: typeof f.dimension === 'string' ? f.dimension : undefined,
      severity: f.severity === 'error' ? 'error' : 'warn',
      comment: typeof f.comment === 'string' ? f.comment : '',
    }));
}

export const specAuditStep: StepDefinition<SpecAuditDetect, SpecAuditApply> = {
  metadata: {
    id: '04a-spec-audit',
    workflowType: 'workflow',
    index: 4.6,
    title: 'Spec audit (broad)',
    description:
      'Broad, report-only audit of the drafted spec. Findings merge into the resolve-warnings step (05a) for validate-then-act correction before gate 1.',
    requiresCli: false,
  },

  // Skip when the task opted out of broad audits, or there is no drafted spec yet
  // (e.g. quick_bugfix, though path filtering already excludes this step there).
  async shouldRun(ctx: StepContext): Promise<boolean> {
    const task = await ctx.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, ctx.taskId),
      columns: { broadAudit: true },
    });
    if (task?.broadAudit === false) return false;
    const spec = await loadDraftSpec(ctx);
    return spec.trim().length > 0;
  },

  async detect(ctx: StepContext): Promise<SpecAuditDetect> {
    return { spec: await loadDraftSpec(ctx) };
  },

  llm: {
    requiredCapabilities: ['tool_use'],
    timeoutMs: 30 * 60 * 1000,
    buildPrompt: (args) => {
      const detected = args.detected as SpecAuditDetect;
      return [
        ...AUDIT_RULES,
        '',
        INSIGHTS_INSTRUCTION,
        '',
        '=== Spec to audit ===',
        detected.spec || '(empty)',
      ].join('\n');
    },
    // Smoke tests (HAIVE_TEST_BYPASS_LLM=1) get an empty audit.
    bypassStub: () => ({ findings: [] }),
  },

  async apply(_ctx, args): Promise<SpecAuditApply> {
    return { findings: parseSpecAuditFindings(args.llmOutput ?? null) };
  },
};
