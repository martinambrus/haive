import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type {
  StepContext,
  StepDefinition,
  AgentMiningDispatch,
  AgentMiningResult,
} from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { retrievalGuidanceLines } from '../_retrieval-guidance.js';
import { parseJsonLoose } from '../_fenced-json.js';
import { QA_LENS_NUMBERED } from '../_qa-lenses.js';
import { collectImplementationFiles } from './_impl-changes.js';
import { INSIGHTS_INSTRUCTION } from './08e-insights-triage.js';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_KEYS, configService } from '@haive/shared';
import { coerceReviewSeverity, isBlockingSeverity } from '@haive/shared/review';
import type { ReviewSeverity } from '@haive/shared/review';
import { recordReviewFindings } from './_review-findings.js';

// Phase 6 — Code review (legacy phase6-code-review.md). After test management
// and before gate 2, two reviewers run IN PARALLEL via agent mining: a
// peer-reviewer (correctness/maintainability/conventions) and a
// security-code-reviewer (injection/access-control/secrets). Both defer to the
// repo's onboarded agent definition when present, else follow the embedded
// condensed persona.
//
// There is no IN-STEP fixer (parallel mining can't cleanly pair with a role-based
// fixer). Instead, blocking peer/security findings drive the cross-step fixLoop
// below: they route back to implementation (round-bumped, capped by max_fix_rounds
// with an escalation gate at the cap) and the whole post-implementation chain
// re-runs. Non-blocking findings surface at gate 2; a developer reject at gate 2 is
// the separate, uncapped human restart path. Mandatory for workflow tasks; formless.

const REVIEW_TIMEOUT_MS = 30 * 60 * 1000;

type QaLevel = 'none' | 'poc' | 'standard' | 'enterprise';

interface CodeReviewDetect {
  spec: string;
  implementationFiles: string[];
  debtBlock: string;
  /** Task adversarial-QA level, reused to gate the extra review lenses. */
  level: QaLevel;
  /** Condensed spec for the review fan-out, set only when REVIEW_FANOUT_DISTILL is on
   *  and the spec was actually trimmed; reviewers fall back to the full `spec`. */
  specForReview?: string;
}

interface PeerFinding {
  severity: ReviewSeverity;
  path?: string;
  lines?: string;
  issue: string;
  snippet?: string;
  fix?: string;
}
interface SecurityFinding {
  severity: ReviewSeverity;
  in_scope?: string;
  path?: string;
  line?: string | number;
  cwe?: string;
  issue: string;
  snippet?: string;
  attack?: string;
  fix?: string;
}

interface ReviewLensResult {
  id: string;
  title: string;
  verdict: string;
  findings: PeerFinding[];
}

interface CodeReviewApply {
  reviewed: boolean;
  peer: { verdict: string; findings: PeerFinding[]; positives: string[] };
  security: { verdict: string; findings: SecurityFinding[] };
  /** Level-gated extra review lenses (operational, performance). Empty for none/poc. */
  extraLenses: ReviewLensResult[];
  blocking: boolean;
  counts: { peer: number; securityCriticalHigh: number };
}

// Severity is coerced, not enum-validated: a repo's checked-in reviewer persona may
// still specify a pre-ladder vocabulary, and a strict enum would fail the whole
// finding rather than the one field. Unknown values land on the fallback.
const peerSchema = z.object({
  verdict: z.enum(['APPROVE', 'REQUEST_CHANGES', 'DISCUSS']).optional(),
  findings: z
    .array(
      z.object({
        severity: z
          .unknown()
          .optional()
          .transform((v) => coerceReviewSeverity(v, 'low')),
        path: z.string().optional(),
        lines: z.string().optional(),
        issue: z.string(),
        snippet: z.string().optional(),
        fix: z.string().optional(),
      }),
    )
    .default([]),
  positives: z.array(z.string()).default([]),
});

const securitySchema = z.object({
  verdict: z.enum(['SECURE', 'NEEDS_FIXES', 'VULNERABLE']).optional(),
  findings: z
    .array(
      z.object({
        severity: z
          .unknown()
          .optional()
          .transform((v) => coerceReviewSeverity(v, 'low')),
        in_scope: z.string().optional(),
        path: z.string().optional(),
        line: z.union([z.string(), z.number()]).optional(),
        cwe: z.string().optional(),
        issue: z.string(),
        snippet: z.string().optional(),
        attack: z.string().optional(),
        fix: z.string().optional(),
      }),
    )
    .default([]),
});

// Extra review lenses reuse the peer finding shape (verdict + findings, no
// positives), so one schema/parser covers operational and performance both.
const reviewLensSchema = z.object({
  verdict: z.enum(['APPROVE', 'REQUEST_CHANGES', 'DISCUSS']).optional(),
  findings: z
    .array(
      z.object({
        severity: z
          .unknown()
          .optional()
          .transform((v) => coerceReviewSeverity(v, 'low')),
        path: z.string().optional(),
        lines: z.string().optional(),
        issue: z.string(),
        snippet: z.string().optional(),
        fix: z.string().optional(),
      }),
    )
    .default([]),
});

function fencedCandidate(raw: unknown): unknown {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  // parseJsonLoose extracts the fenced/balanced JSON and runs a jsonrepair salvage
  // pass, so a truncated/malformed reviewer turn is recovered instead of dropped.
  return parseJsonLoose(raw);
}

/** Parse the peer-reviewer JSON; null when unparseable. */
export function parsePeerReview(
  raw: unknown,
): { verdict: string; findings: PeerFinding[]; positives: string[] } | null {
  const parsed = peerSchema.safeParse(fencedCandidate(raw));
  if (!parsed.success) return null;
  return {
    verdict: parsed.data.verdict ?? 'DISCUSS',
    findings: parsed.data.findings,
    positives: parsed.data.positives,
  };
}

/** Parse the security-code-reviewer JSON; null when unparseable. */
export function parseSecurityReview(
  raw: unknown,
): { verdict: string; findings: SecurityFinding[] } | null {
  const parsed = securitySchema.safeParse(fencedCandidate(raw));
  if (!parsed.success) return null;
  return { verdict: parsed.data.verdict ?? 'NEEDS_FIXES', findings: parsed.data.findings };
}

/** Parse one extra review-lens (operational/performance) JSON; null when unparseable. */
export function parseReviewLens(raw: unknown): { verdict: string; findings: PeerFinding[] } | null {
  const parsed = reviewLensSchema.safeParse(fencedCandidate(raw));
  if (!parsed.success) return null;
  return { verdict: parsed.data.verdict ?? 'DISCUSS', findings: parsed.data.findings };
}

/** A review result is blocking when peer requests changes, security is vulnerable,
 *  or ANY reviewer raised a critical/high finding.
 *
 *  Blocking costs a fix round, so it keys on the severity ladder rather than on a
 *  reviewer's summary verdict. Two consequences, both deliberate:
 *  - a peer `critical` finding blocks on its own, even under an APPROVE/DISCUSS
 *    verdict (it previously did not);
 *  - an extra lens (operational/performance/simplicity) no longer blocks on its
 *    verdict alone — a lens that requests changes over `medium`/`low` findings
 *    surfaces as advisory at gate 2 instead of burning a fix round.
 */
export function computeBlocking(
  peer: { verdict: string; findings?: { severity: ReviewSeverity }[] } | null,
  security: { verdict: string; findings: { severity: ReviewSeverity }[] } | null,
  lenses: { verdict: string; findings?: { severity: ReviewSeverity }[] }[] = [],
): boolean {
  if (peer?.verdict === 'REQUEST_CHANGES') return true;
  if (security?.verdict === 'VULNERABLE') return true;
  const findings = [
    ...(peer?.findings ?? []),
    ...(security?.findings ?? []),
    ...lenses.flatMap((l) => l.findings ?? []),
  ];
  return findings.some((f) => isBlockingSeverity(f.severity));
}

const SEARCH_LADDER = [
  'When you need conventions or context, search in this order:',
  ...retrievalGuidanceLines(),
] as const;

// Reviewers pick the severity; severity picks whether the change goes back to the
// implementer. Say so, so critical/high stay a judgement about impact rather than a
// way to add emphasis.
const SEVERITY_GUIDANCE = [
  'Severity decides what happens next: a "critical" or "high" finding sends the change back to be',
  'reimplemented, while "medium" and "low" surface to the developer as advisory. Reserve',
  'critical/high for a defect that would break behaviour, lose data, or expose a vulnerability —',
  'not for emphasis. When a finding is real but the code would still work, it is medium or low.',
].join('\n');

const PEER_PERSONA = [
  'You are the Peer Reviewer. Catch bugs and improve quality before merge while keeping feedback',
  'constructive — name what is wrong with a concrete fix, name what was done well, and NEVER',
  'rewrite the code (the author owns it).',
  'Review each changed file in FULL for: correctness (does it do what the spec says, edge/error',
  'cases), maintainability (duplication, oversized functions, unnecessary coupling), and',
  'convention adherence (existing repo patterns + knowledge base). Then score the change AS WRITTEN',
  'against all 14 review dimensions — not only what the spec promised — Security, Maintainability,',
  'Testability, Usability, Stability, Performance (N+1 queries, missing indexes on new WHERE/ORDER BY',
  'columns, hot-path blocking IO), Observability, Operational Readiness, Data Integrity, Developer',
  'Experience, Accessibility, Internationalization, Backward Compatibility, Privacy/Compliance; raise',
  'any weak or missing dimension as a finding with the dimension named in the issue. Acknowledge',
  'genuine strengths.',
  'Then run the failure, replay and safeguard pass — beyond whether the change is correct on the',
  'happy path, ask these four questions of the diff and raise anything it fails as a finding:',
  QA_LENS_NUMBERED,
  'Every finding needs a file + line, the offending code snippet, and a concrete fix (with a code',
  'example where it helps); mark critical issues critical (never soften to low). Report',
  'EVERY finding in full — never just counts. Do NOT edit code and do NOT run git (it is',
  'unavailable here — work from the changed-files list and read them directly).',
] as const;

const SECURITY_PERSONA = [
  'You are the Security Code Reviewer. Think like an attacker: trace every untrusted input from',
  'entry (param, header, cookie, body, upload) to every sink (database, output, file, shell) and',
  'verify sanitization at each step. Check injection (SQL/NoSQL/XSS/command/template),',
  'access-control on every privileged path, secret handling, and data exposure. Report EVERY',
  'finding in full — including pre-existing, low-severity, and dead-code ones — each with',
  'file:line, the offending code snippet, an attack scenario, and a fix, so the author can decide',
  'with full information. Report EVERY finding in full — never just counts. Do NOT edit code and do',
  'NOT run git (it is unavailable here — work from the changed-files list and read them directly).',
] as const;

const OPERATIONAL_PERSONA = [
  'You are the Operational Reviewer. Review the change AS WRITTEN for the operational and lifecycle',
  'dimensions a feature-focused review tends to under-weight, and NEVER rewrite the code (the author',
  'owns it). Raise every weak or missing aspect as a finding with the dimension named in the issue:',
  '- Observability: can a new code path be debugged in production from its own logs/metrics/traces',
  '  alone? Flag silent failures, swallowed errors, and new branches with no structured logging.',
  '- Operational readiness: timeouts and retries on external calls, graceful degradation on failure,',
  '  resource limits and cleanup, and config / feature-flag handling for the new behavior.',
  '- Migration safety: any DB or schema migration is present, idempotent, reversible, and',
  '  forward-compatible (old code tolerates the new schema during a rolling deploy).',
  '- Backward compatibility: does the change break existing callers, API consumers, persisted data,',
  '  or serialized formats? Check the call sites of anything whose signature or shape changed.',
  '- Rollback: can this change be undone safely? Flag one-way doors and destructive steps with no',
  '  documented undo path.',
  '- Documentation: are READMEs, inline comments, and developer docs updated for the new behavior?',
  'Do NOT review test coverage (a separate step owns it) or security (a separate reviewer owns it).',
  'Every finding needs a file + line, the offending snippet, and a concrete fix. Report EVERY finding',
  'in full — never just counts. Do NOT edit code and do NOT run git (it is unavailable here — work',
  'from the changed-files list and read them directly).',
] as const;

const PERFORMANCE_PERSONA = [
  'You are the Performance Reviewer. Review the change AS WRITTEN for performance and data-access',
  'efficiency, and NEVER rewrite the code (the author owns it). Raise every issue as a finding with',
  'the concern named in the issue:',
  '- Query efficiency: N+1 query patterns, queries issued inside loops, and missing indexes on new',
  '  columns used in WHERE / ORDER BY / JOIN clauses.',
  '- Unbounded work: list endpoints or queries with no pagination or limit, and operations whose',
  '  cost grows with unbounded input.',
  '- Hot-path blocking: synchronous or blocking IO, heavy CPU, or external calls on a request or',
  '  event hot path that should be async, cached, or moved off the critical path.',
  '- Data integrity under concurrency: writes that need a transaction, a unique constraint, or an',
  '  idempotency guard to stay correct under retries and concurrent requests.',
  '- Memory and payload: large payloads read fully into memory, unbounded buffers, and missing',
  '  streaming where the data set can be large.',
  'Every finding needs a file + line, the offending snippet, and a concrete fix. Report EVERY finding',
  'in full — never just counts. Do NOT edit code and do NOT run git (it is unavailable here — work',
  'from the changed-files list and read them directly).',
] as const;

const SIMPLICITY_PERSONA = [
  'You are the Simplicity Reviewer. Review the change AS WRITTEN for over-engineering and missed',
  'reuse — the bloat angle a feature-focused review under-weights — and NEVER rewrite the code (the',
  'author owns it). Raise every issue as a finding with the concern named in the issue:',
  '- Reuse missed: new code that re-implements a helper, util, or pattern already in the repo, or',
  '  that the language standard library or an already-installed dependency already provides. Name the',
  '  existing thing the change should have used.',
  '- Needless dependency: a newly added dependency that the standard library or a dependency already',
  '  in the project already covers.',
  '- Needless abstraction: an interface, layer, generic, or configurability added for a single',
  '  current caller with no requested second use.',
  '- YAGNI: code for a requirement that was not asked for — speculative options, unreached branches,',
  '  dead parameters.',
  'Do NOT flag validation, error handling, security, or accessibility as bloat — those are never',
  'over-engineering (a separate reviewer owns them). Do NOT re-report plain code duplication the peer',
  'reviewer already covers; focus on reuse-of-existing and unnecessary-new. Every finding needs a',
  'file + line, the offending snippet, and a concrete fix (name the simpler existing path). Report',
  'EVERY finding in full — never just counts. Do NOT edit code and do NOT run git (it is unavailable',
  'here — work from the changed-files list and read them directly).',
] as const;

interface ReviewLensDef {
  id: string;
  title: string;
  persona: readonly string[];
}

// Extra review lenses layered on peer + security, gated by the task's adversarial-QA
// level. They cover quality dimensions the single peer-reviewer blob under-serves and
// that no 08d adversary re-derives (observability, operational readiness,
// migration/rollback safety, backward compat, documentation; data-access performance;
// and missed reuse / over-engineering) — so a miss there is otherwise final. Order
// matters: lensesForLevel slices this cumulatively.
const REVIEW_LENSES: ReviewLensDef[] = [
  { id: 'operational-reviewer', title: 'Operational Reviewer', persona: OPERATIONAL_PERSONA },
  { id: 'performance-reviewer', title: 'Performance Reviewer', persona: PERFORMANCE_PERSONA },
  { id: 'simplicity-reviewer', title: 'Simplicity Reviewer', persona: SIMPLICITY_PERSONA },
];

/** Cumulative roster by level: none/poc add nothing, standard adds operational,
 *  enterprise adds operational + performance + simplicity. Exported for the unit test. */
export function lensesForLevel(level: QaLevel): ReviewLensDef[] {
  if (level === 'standard') return REVIEW_LENSES.slice(0, 1);
  if (level === 'enterprise') return REVIEW_LENSES.slice(0, 3);
  return [];
}

const REVIEW_SPEC_RELPATH = '.haive/review-context/spec.md';
// Body lines kept under each heading before the section tail is dropped.
const REVIEW_SPEC_HEAD_LINES = 8;

// Condense a markdown spec for the review fan-out: keep every heading plus a bounded
// lead of each section, drop the verbose tail. Deterministic, no LLM. Returns
// dropped:false (spec unchanged) when nothing was trimmed, so the caller skips the
// on-disk artifact + pointer. When trimmed, the full spec is written to disk and a
// pointer to REVIEW_SPEC_RELPATH is appended so reviewers can Read any omitted section.
function condenseSpecForReview(spec: string): { text: string; dropped: boolean } {
  const out: string[] = [];
  let bodyKept = 0;
  let dropped = false;
  for (const line of spec.split('\n')) {
    if (/^#{1,6}\s/.test(line)) {
      out.push(line);
      bodyKept = 0;
    } else if (bodyKept < REVIEW_SPEC_HEAD_LINES) {
      out.push(line);
      bodyKept++;
    } else {
      dropped = true;
    }
  }
  if (!dropped) return { text: spec, dropped: false };
  return {
    text: `${out.join('\n').trim()}\n\n[Spec condensed for review. Full spec on disk — Read \`${REVIEW_SPEC_RELPATH}\` for any omitted section.]`,
    dropped: true,
  };
}

function reviewAssignment(d: CodeReviewDetect): string {
  return [
    d.implementationFiles.length > 0
      ? `Changed files to review (read each in full):\n- ${d.implementationFiles.join('\n- ')}`
      : 'Determine the recently-changed files from the workspace and read each in full.',
    d.debtBlock ? `\n${d.debtBlock}` : '',
    '',
    ...SEARCH_LADDER,
    '',
    '=== Spec (what the change must deliver) ===',
    d.specForReview || d.spec || '(no spec recorded)',
    '',
    INSIGHTS_INSTRUCTION,
  ]
    .filter(Boolean)
    .join('\n');
}

function buildPeerPrompt(d: CodeReviewDetect): string {
  return [
    'If a `.claude/agents/peer-reviewer.md` agent definition exists in the repo, follow it;',
    'otherwise follow the protocol below.',
    ...PEER_PERSONA,
    '',
    reviewAssignment(d),
    '',
    'When finished emit ONE JSON object inside a ```json fenced code block with EXACTLY this shape:',
    '{ "verdict": "APPROVE|REQUEST_CHANGES|DISCUSS", "findings": [{ "severity": "critical|high|medium|low", "path": "file", "lines": "start-end", "issue": "...", "snippet": "<offending code>", "fix": "..." }], "positives": ["..."] }',
    SEVERITY_GUIDANCE,
  ].join('\n');
}

function buildSecurityPrompt(d: CodeReviewDetect): string {
  return [
    'If a `.claude/agents/security-code-reviewer.md` agent definition exists in the repo, follow',
    'it; otherwise follow the protocol below.',
    ...SECURITY_PERSONA,
    '',
    reviewAssignment(d),
    '',
    'When finished emit ONE JSON object inside a ```json fenced code block with EXACTLY this shape:',
    '{ "verdict": "SECURE|NEEDS_FIXES|VULNERABLE", "findings": [{ "severity": "critical|high|medium|low", "in_scope": "yes|no", "path": "file", "line": 0, "cwe": "id or n/a", "issue": "...", "snippet": "<vulnerable code>", "attack": "...", "fix": "..." }] }',
    SEVERITY_GUIDANCE,
  ].join('\n');
}

function buildLensPrompt(lens: ReviewLensDef, d: CodeReviewDetect): string {
  return [
    `If a \`.claude/agents/${lens.id}.md\` agent definition exists in the repo, follow it;`,
    'otherwise follow the protocol below.',
    ...lens.persona,
    '',
    reviewAssignment(d),
    '',
    'When finished emit ONE JSON object inside a ```json fenced code block with EXACTLY this shape:',
    '{ "verdict": "APPROVE|REQUEST_CHANGES|DISCUSS", "findings": [{ "severity": "critical|high|medium|low", "path": "file", "lines": "start-end", "issue": "...", "snippet": "<offending code>", "fix": "..." }] }',
    SEVERITY_GUIDANCE,
  ].join('\n');
}

function miningResult(results: AgentMiningResult[], agentId: string): unknown {
  const r = results.find((m) => m.agentId === agentId && m.status === 'done');
  return r ? (r.output ?? r.rawOutput) : null;
}

export const codeReviewStep: StepDefinition<CodeReviewDetect, CodeReviewApply> = {
  metadata: {
    id: '08c-code-review',
    workflowType: 'workflow',
    index: 8.8,
    title: 'Phase 6: Code review',
    description:
      'A peer reviewer and a security reviewer review the change in parallel; findings surface at gate 2.',
    requiresCli: false,
  },

  // Fix-loop: blocking peer/security review findings route back to implementation.
  fixLoop: {
    evaluate: (out) => {
      if (!out.blocking) return null;
      const parts: string[] = [];
      if (out.peer.findings.length) {
        parts.push(
          '### Peer review\n' +
            out.peer.findings
              .map(
                (f) => `- [${f.severity}] ${f.path}: ${f.issue}${f.fix ? ` — fix: ${f.fix}` : ''}`,
              )
              .join('\n'),
        );
      }
      if (out.security.findings.length) {
        parts.push(
          '### Security\n' +
            out.security.findings
              .map(
                (f) => `- [${f.severity}] ${f.path}: ${f.issue}${f.fix ? ` — fix: ${f.fix}` : ''}`,
              )
              .join('\n'),
        );
      }
      for (const lens of out.extraLenses) {
        if (!lens.findings.length) continue;
        parts.push(
          `### ${lens.title}\n` +
            lens.findings
              .map(
                (f) =>
                  `- [${f.severity}] ${f.path ?? ''}: ${f.issue}${f.fix ? ` — fix: ${f.fix}` : ''}`,
              )
              .join('\n'),
        );
      }
      return { blocking: true, diagnosis: parts.join('\n\n') || 'Code review requested changes.' };
    },
  },

  async detect(ctx: StepContext): Promise<CodeReviewDetect> {
    const worktree = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-worktree-setup');
    const wt = worktree?.output as { worktreePath?: string } | null;
    if (!wt?.worktreePath) {
      throw new Error('08c-code-review requires 01-worktree-setup to have produced a worktree');
    }

    const plan = await loadPreviousStepOutput(ctx.db, ctx.taskId, '04-phase-0b-pre-planning');
    const quality = await loadPreviousStepOutput(ctx.db, ctx.taskId, '05-phase-0b5-spec-quality');
    const resolved = await loadPreviousStepOutput(ctx.db, ctx.taskId, '05a-resolve-spec-warnings');
    const spec =
      ((resolved?.output as { spec?: string } | null)?.spec ??
        (quality?.output as { spec?: string } | null)?.spec ??
        (plan?.output as { spec?: string } | null)?.spec) ||
      '';

    // Opt-in fan-out spec condensing (default off). The parallel reviewers each embed
    // the spec in their own prompt and prompt caching can't dedup it (separate
    // sessions), so when enabled we trim the spec for the prompt and drop the full spec
    // to a worktree artifact the reviewers can Read on demand.
    let specForReview: string | undefined;
    if (spec && (await configService.getBoolean(CONFIG_KEYS.REVIEW_FANOUT_DISTILL, false))) {
      const condensed = condenseSpecForReview(spec);
      if (condensed.dropped) {
        const dir = join(wt.worktreePath, '.haive', 'review-context');
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(join(dir, 'spec.md'), spec, 'utf8');
        specForReview = condensed.text;
      }
    }

    // DAG debt: documented compromises reviewers must not flag (07b pattern).
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
          'KNOWN TECHNICAL DEBT (documented compromises): review these with LOWER severity — they',
          'are known and accepted. Only flag if they introduce security vulnerabilities or cascading',
          'failures.',
          ...lines,
        ].join('\n');
      }
    }

    const task = await ctx.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, ctx.taskId),
      columns: { adversarialQaLevel: true },
    });
    const level = (task?.adversarialQaLevel ?? 'none') as QaLevel;

    return {
      spec,
      specForReview,
      implementationFiles: await collectImplementationFiles(ctx, wt.worktreePath),
      debtBlock,
      level,
    };
  },

  agentMining: {
    requiredCapabilities: ['tool_use'],
    timeoutMs: REVIEW_TIMEOUT_MS,
    async selectAgents({ detected }): Promise<AgentMiningDispatch[]> {
      // Mining has no bypass stub; under test bypass return [] so the smoke
      // doesn't enqueue real CLI jobs (mirrors 03-discovery's empty-persona path).
      if (process.env.HAIVE_TEST_BYPASS_LLM === '1') return [];
      const d = detected as CodeReviewDetect;
      return [
        { agentId: 'peer-reviewer', agentTitle: 'Peer Reviewer', prompt: buildPeerPrompt(d) },
        {
          agentId: 'security-code-reviewer',
          agentTitle: 'Security Code Reviewer',
          prompt: buildSecurityPrompt(d),
        },
        ...lensesForLevel(d.level).map((lens) => ({
          agentId: lens.id,
          agentTitle: lens.title,
          prompt: buildLensPrompt(lens, d),
        })),
      ];
    },
  },

  async apply(ctx, args): Promise<CodeReviewApply> {
    const results = args.agentMiningResults ?? [];
    const peerRaw = miningResult(results, 'peer-reviewer');
    const securityRaw = miningResult(results, 'security-code-reviewer');
    const peer = parsePeerReview(peerRaw);
    const security = parseSecurityReview(securityRaw);

    if (peerRaw == null && securityRaw == null) {
      // No reviewer produced output (test bypass, or both agents no-op'd). Nothing
      // was reviewed, so there is nothing to block on.
      ctx.logger.info('code review produced no agent output (bypass or no-op)');
      return {
        reviewed: false,
        peer: { verdict: 'APPROVE', findings: [], positives: [] },
        security: { verdict: 'SECURE', findings: [] },
        extraLenses: [],
        blocking: false,
        counts: { peer: 0, securityCriticalHigh: 0 },
      };
    }

    // A reviewer that RAN but whose output could not be parsed (even after the
    // jsonrepair salvage) must NOT be reported as APPROVE/SECURE — that would
    // advance unreviewed code. Surface a visible, non-approving finding at gate 2
    // instead (the Tier-3 reviewer retry, when added, re-rolls upstream of this).
    const peerUnparsed = peerRaw != null && peer == null;
    const securityUnparsed = securityRaw != null && security == null;
    if (peerUnparsed || securityUnparsed) {
      ctx.logger.warn(
        { peerUnparsed, securityUnparsed },
        'code review output unparseable — surfacing as non-approving, not silently approving',
      );
    }

    // The synthetic "did not complete" findings stay below the blocking tier on
    // purpose: a reviewer that failed to emit JSON is not evidence the CODE is
    // wrong, so it must not route the change back to the implementer. It is
    // non-approving, and the developer decides at gate 2.
    const peerOut: { verdict: string; findings: PeerFinding[]; positives: string[] } = peer ?? {
      verdict: peerUnparsed ? 'DISCUSS' : 'APPROVE',
      findings: peerUnparsed
        ? [
            {
              severity: 'medium',
              issue:
                'Peer review output was unparseable — review did not complete; re-run code review.',
            },
          ]
        : [],
      positives: [],
    };
    const securityOut: { verdict: string; findings: SecurityFinding[] } = security ?? {
      verdict: securityUnparsed ? 'NEEDS_FIXES' : 'SECURE',
      findings: securityUnparsed
        ? [
            {
              severity: 'medium',
              issue:
                'Security review output was unparseable — review did not complete; re-run code review.',
            },
          ]
        : [],
    };

    // Extra review lenses (operational/performance) — present only when the task
    // level enabled them. Mirror the peer/security de-silence rule: a lens that
    // RAN but whose output is unparseable surfaces as non-approving, never silent.
    const extraLenses: ReviewLensResult[] = [];
    for (const lens of REVIEW_LENSES) {
      const raw = miningResult(results, lens.id);
      if (raw == null) continue;
      const parsed = parseReviewLens(raw);
      if (parsed == null) {
        ctx.logger.warn(
          { lens: lens.id },
          'review lens output unparseable — surfacing as non-approving, not silently approving',
        );
        extraLenses.push({
          id: lens.id,
          title: lens.title,
          verdict: 'DISCUSS',
          findings: [
            {
              severity: 'medium',
              issue: `${lens.title} output was unparseable — review did not complete; re-run code review.`,
            },
          ],
        });
        continue;
      }
      extraLenses.push({
        id: lens.id,
        title: lens.title,
        verdict: parsed.verdict,
        findings: parsed.findings,
      });
    }

    // Block on what we REPORT, not on what parsed: peerOut/securityOut carry the
    // synthetic findings for an unparseable reviewer, so the blocking decision and
    // the gate-2 finding list can never disagree.
    const blocking = computeBlocking(peerOut, securityOut, extraLenses);

    await recordReviewFindings(ctx, '08c-code-review', [
      ...peerOut.findings.map((f) => ({
        reviewerId: 'peer-reviewer',
        severity: f.severity,
        issue: f.issue,
        path: f.path,
        lines: f.lines,
        fix: f.fix,
        blocking: isBlockingSeverity(f.severity),
        raw: f,
      })),
      ...securityOut.findings.map((f) => ({
        reviewerId: 'security-code-reviewer',
        severity: f.severity,
        issue: f.issue,
        path: f.path,
        lines: f.line,
        fix: f.fix,
        blocking: isBlockingSeverity(f.severity),
        raw: f,
      })),
      ...extraLenses.flatMap((lens) =>
        lens.findings.map((f) => ({
          reviewerId: lens.id,
          severity: f.severity,
          issue: f.issue,
          path: f.path,
          lines: f.lines,
          fix: f.fix,
          blocking: isBlockingSeverity(f.severity),
          raw: f,
        })),
      ),
    ]);

    const securityCriticalHigh = securityOut.findings.filter((f) =>
      isBlockingSeverity(f.severity),
    ).length;

    ctx.logger.info(
      {
        peerVerdict: peerOut.verdict,
        securityVerdict: securityOut.verdict,
        peerFindings: peerOut.findings.length,
        securityCriticalHigh,
        lenses: extraLenses.map((l) => `${l.id}:${l.verdict}`),
        blocking,
        peerUnparsed,
        securityUnparsed,
      },
      'code review complete',
    );

    return {
      reviewed: true,
      peer: peerOut,
      security: securityOut,
      extraLenses,
      blocking,
      counts: { peer: peerOut.findings.length, securityCriticalHigh },
    };
  },
};
