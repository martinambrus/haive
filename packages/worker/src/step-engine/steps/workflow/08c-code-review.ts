import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { MiningRetryError, MiningWaveError } from '../../step-definition.js';
import type {
  StepContext,
  StepDefinition,
  AgentMiningDispatch,
  AgentMiningResult,
} from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { agentDefinitionGuidance, retrievalGuidanceLines } from '../_retrieval-guidance.js';
import { QA_LENS_NUMBERED } from '../_qa-lenses.js';
import { hasAnyKey, parseAgentJson, parseReviewJson } from './_agent-json.js';
import { collectImplementationFiles } from './_impl-changes.js';
import { INSIGHTS_INSTRUCTION } from './08e-insights-triage.js';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_KEYS, configService } from '@haive/shared';
import { coerceReviewSeverity, isBlockingSeverity, severityRank } from '@haive/shared/review';
import type { ReviewSeverity } from '@haive/shared/review';
import {
  findingFingerprint,
  hasFileLineEvidence,
  recordReviewFindings,
} from './_review-findings.js';

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
  /** Set by the refutation pass: a refuter disproved this finding with a cited
   *  file:line. It stops blocking and stops reaching the implementer, but stays
   *  visible at gate 2 as advisory. Never set by a reviewer. */
  refuted?: boolean;
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
  refuted?: boolean;
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
  /** A reviewer RAN but its output stayed unreadable after its re-rolls were spent, so
   *  part of the change went unreviewed. Distinct from `blocking`: the reviewer failed,
   *  not the code, so it must not spend a fix round — but gate 2 must not report OK. */
  reviewIncomplete: boolean;
  /** A reviewer requested changes without a critical/high finding to point at. Does not
   *  block (no fix round, nothing to refute), but holds gate 2 off its approve default. */
  advisoryVerdict: boolean;
  /** Blocking findings a refuter disproved. 0 when the pass is off or nothing blocked. */
  refutedCount: number;
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

/** Parse the peer-reviewer JSON; null when unparseable. */
export function parsePeerReview(
  raw: unknown,
): { verdict: string; findings: PeerFinding[]; positives: string[] } | null {
  return parseReviewJson(raw, (candidate) => {
    const parsed = peerSchema.safeParse(candidate);
    if (!parsed.success) return null;
    return {
      verdict: parsed.data.verdict ?? 'DISCUSS',
      findings: parsed.data.findings,
      positives: parsed.data.positives,
    };
  });
}

/** Parse the security-code-reviewer JSON; null when unparseable. */
export function parseSecurityReview(
  raw: unknown,
): { verdict: string; findings: SecurityFinding[] } | null {
  return parseReviewJson(raw, (candidate) => {
    const parsed = securitySchema.safeParse(candidate);
    if (!parsed.success) return null;
    return { verdict: parsed.data.verdict ?? 'NEEDS_FIXES', findings: parsed.data.findings };
  });
}

/** Parse one extra review-lens (operational/performance) JSON; null when unparseable. */
export function parseReviewLens(raw: unknown): { verdict: string; findings: PeerFinding[] } | null {
  return parseReviewJson(raw, (candidate) => {
    const parsed = reviewLensSchema.safeParse(candidate);
    if (!parsed.success) return null;
    return { verdict: parsed.data.verdict ?? 'DISCUSS', findings: parsed.data.findings };
  });
}

/** A review result is blocking when ANY reviewer raised a critical/high finding.
 *
 *  Blocking costs a fix round, so it keys on the severity ladder and on nothing else —
 *  never on a reviewer's summary verdict. SEVERITY_GUIDANCE tells every reviewer exactly
 *  that ("critical/high sends the change back; medium/low surface as advisory"), and the
 *  code has to mean it. Three consequences, all deliberate:
 *  - a peer `critical` finding blocks on its own, even under an APPROVE/DISCUSS verdict;
 *  - an extra lens no longer blocks on its verdict alone;
 *  - a bare `REQUEST_CHANGES`/`VULNERABLE` over nothing worse than `medium` no longer
 *    blocks either. Measured on 36 real historical reviews, that was 7 of 25 blocking
 *    rounds — fix rounds spent on an assertion the reviewer never grounded in a finding,
 *    and which no refuter can disprove because there is no claim to read.
 *
 *  Those verdicts are not ignored: `hasNonApprovingVerdict` keeps them off the gate-2
 *  approve default. The cost moves from an automatic reimplementation to a human glance.
 */
export function computeBlocking(
  peer: { findings?: { severity: ReviewSeverity }[] } | null,
  security: { findings: { severity: ReviewSeverity }[] } | null,
  lenses: { findings?: { severity: ReviewSeverity }[] }[] = [],
): boolean {
  const findings = [
    ...(peer?.findings ?? []),
    ...(security?.findings ?? []),
    ...lenses.flatMap((l) => l.findings ?? []),
  ];
  return findings.some((f) => isBlockingSeverity(f.severity));
}

/** A reviewer asked for changes without grounding it in a critical/high finding.
 *
 *  It must not spend a fix round (nothing to fix, nothing to refute), and it must not let
 *  gate 2 default to approve either — a collapsed green "OK" next to `peer
 *  REQUEST_CHANGES` is the same silent approval an unparseable review used to produce.
 *  Only these two verdicts count: `NEEDS_FIXES` is what parseSecurityReview substitutes
 *  for an ABSENT verdict, so it carries no assertion at all. */
export function hasNonApprovingVerdict(
  peer: { verdict: string } | null,
  security: { verdict: string } | null,
): boolean {
  return peer?.verdict === 'REQUEST_CHANGES' || security?.verdict === 'VULNERABLE';
}

/* ------------------------------------------------------------------ */
/* Refutation pass (CONFIG_KEYS.REVIEW_REFUTE_ENABLED, default on).     */
/*                                                                     */
/* A blocking finding routes the change back through implementation and */
/* spends one of the capped fix rounds. 08d already makes its adversaries*/
/* prove an exploit with a non-destructive PoC before it counts; this is */
/* the same evidence bar, applied to 08c. One refuter per blocking       */
/* finding, dispatched as a second mining wave once the reviewers have   */
/* spoken (see MiningWaveError).                                        */
/*                                                                     */
/* Fail CLOSED, deliberately, and against the plan this came from. A    */
/* refuter dismisses a finding ONLY on positive evidence, cited at a    */
/* file and line, that the finding is wrong. "Uncertain" leaves it      */
/* blocking, and so does an unreadable or failed refuter. Dismissing on */
/* uncertainty would be right if a false positive only cost attention   */
/* (DoorDash's case: an engineer ignores the bot). Here gate 2 defaults */
/* to APPROVE when nothing blocks, so a wrongly-dismissed critical is a */
/* security bug one click from shipping, while a wrongly-KEPT finding   */
/* costs one fix round. The asymmetry decides the default.              */
/* ------------------------------------------------------------------ */

const REFUTER_PREFIX = 'refute-';

/** One sandboxed CLI invocation per refuter, so the fan-out is bounded. A round with more
 *  blocking findings than this is going back to the implementer regardless of how many we
 *  disprove; the overflow stands unrefuted (fail closed) and is logged. */
const MAX_REFUTERS = 10;

/** One blocking finding, paired with the refuter that will try to disprove it. */
export interface RefutableFinding {
  reviewerId: string;
  fingerprint: string;
  agentId: string;
  severity: ReviewSeverity;
  path: string;
  lines: string;
  issue: string;
  fix: string;
}

/** Deterministic, so the agent id is the same on the apply() that dispatches the wave
 *  and on the apply() that reads its results. */
function refuterAgentId(fingerprint: string): string {
  return `${REFUTER_PREFIX}${fingerprint.slice(0, 16)}`;
}

/** Human terminal label for a refuter. Every refuter used to render as the identical
 *  "Refuter (<reviewer>)", so a fan-out of N distinct findings looked like N duplicate
 *  terminals. Include the position (i/total), the severity, and the finding's location +
 *  issue so each terminal names the specific finding it is trying to disprove. */
export function refuterTitle(
  f: Pick<RefutableFinding, 'severity' | 'path' | 'lines' | 'issue'>,
  index: number,
  total: number,
): string {
  const loc = [f.path, f.lines].filter(Boolean).join(':');
  const issue = f.issue.replace(/\s+/g, ' ').trim();
  const head = `Refuter ${index + 1}/${total} — ${f.severity}${loc ? ` ${loc}` : ''}`;
  return issue ? `${head} · ${issue.slice(0, 80)}` : head;
}

/** Every critical/high finding across all reviewers — exactly the ones that cost a fix
 *  round. Medium/low are advisory already and are never refuted: the invocation would
 *  buy nothing. */
export function collectRefutable(
  peer: { findings: PeerFinding[] },
  security: { findings: SecurityFinding[] },
  lenses: ReviewLensResult[],
): RefutableFinding[] {
  const rows: { reviewerId: string; f: PeerFinding | SecurityFinding }[] = [
    ...peer.findings.map((f) => ({ reviewerId: 'peer-reviewer', f: f as PeerFinding })),
    ...security.findings.map((f) => ({ reviewerId: 'security-code-reviewer', f })),
    ...lenses.flatMap((l) => l.findings.map((f) => ({ reviewerId: l.id, f: f as PeerFinding }))),
  ];
  const out: RefutableFinding[] = [];
  const seen = new Set<string>();
  for (const { reviewerId, f } of rows) {
    if (!isBlockingSeverity(f.severity)) continue;
    const path = f.path ?? '';
    const fingerprint = findingFingerprint(reviewerId, path, f.issue);
    if (seen.has(fingerprint)) continue; // one refuter per distinct finding
    seen.add(fingerprint);
    const lines = 'lines' in f ? (f.lines ?? '') : String((f as SecurityFinding).line ?? '');
    out.push({
      reviewerId,
      fingerprint,
      agentId: refuterAgentId(fingerprint),
      severity: f.severity,
      path,
      lines,
      issue: f.issue,
      fix: f.fix ?? '',
    });
  }
  return out;
}

const refutationSchema = z.object({
  refuted: z.boolean(),
  reason: z.string().optional(),
  evidence: z.string().optional(),
});

/** A finding is dismissed only when the refuter says so AND cites a file:line for why.
 *  Anything else — no verdict, no citation, unreadable output — leaves it standing. */
export function isRefuted(raw: unknown): boolean {
  const parsed = parseAgentJson(raw, (candidate) => {
    if (!hasAnyKey(candidate, ['refuted'])) return null;
    const r = refutationSchema.safeParse(candidate);
    return r.success ? r.data : null;
  });
  if (!parsed?.refuted) return false;
  // `evidence` only, never `reason`: a refuter that merely restates the finding's own
  // location in its prose has cited nothing it read.
  return hasFileLineEvidence(parsed.evidence);
}

function buildRefutePrompt(d: CodeReviewDetect, f: RefutableFinding): string {
  return [
    'You are a REFUTER. A code reviewer raised the finding below against a change, and',
    'acting on it will send the whole change back to be reimplemented. Your job is to try',
    'to DISPROVE it by reading the actual code — not to agree with it, and not to fix it.',
    '',
    'Refute the finding ONLY if you can show it is wrong. It is wrong when the code path is',
    'unreachable, the value cannot take the state described, the case is already handled',
    'elsewhere, the cited code does not exist or does not say what the reviewer claims, or',
    'the finding is out of scope for this change.',
    '',
    'If you cannot show that — if the finding might be right, if you are unsure, or if you',
    'cannot find the code — then it STANDS. Say refuted: false. An uncertain refutation is',
    'a wrong one: a real defect dismissed here reaches the developer marked as disproved.',
    '',
    `Finding (from ${f.reviewerId}, severity ${f.severity}):`,
    `  location: ${f.path || '(unspecified)'}${f.lines ? `:${f.lines}` : ''}`,
    `  issue: ${f.issue}`,
    f.fix ? `  proposed fix: ${f.fix}` : '',
    '',
    'Do NOT edit code and do NOT run git.',
    ...SEARCH_LADDER,
    '',
    'Emit ONE JSON object inside a ```json fenced code block with EXACTLY this shape:',
    '{ "refuted": true|false, "reason": "<why the finding is wrong, or why it stands>", "evidence": "<path/to/file.ext:LINE you read that proves it>" }',
    'A `refuted: true` with no `evidence` citing a real path/to/file.ext:LINE is IGNORED and',
    'the finding stands. Cite the line you actually read.',
    '',
    '=== Spec (the intended behavior) ===',
    d.specForReview || d.spec || '(no spec recorded)',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Downgrade a reviewer's verdict when every blocking finding behind it was refuted: the
 *  verdict was a summary of those findings, and nothing is left to summarise. A reviewer
 *  that raised no blocking finding keeps its verdict — there was nothing to refute, so a
 *  bare REQUEST_CHANGES/VULNERABLE still holds gate 2 off its approve default. */
function adjustVerdict<T extends { severity: ReviewSeverity; refuted?: boolean }>(
  verdict: string,
  findings: T[],
  fallback: string,
): string {
  const blockingFindings = findings.filter((f) => isBlockingSeverity(f.severity));
  if (blockingFindings.length === 0) return verdict;
  return blockingFindings.every((f) => f.refuted) ? fallback : verdict;
}

/** Mark every blocking finding its refuter disproved, and downgrade the verdicts that
 *  rested entirely on those findings. Mutates in place; returns how many were dismissed. */
export function applyRefutations(
  results: AgentMiningResult[],
  peer: { verdict: string; findings: PeerFinding[] },
  security: { verdict: string; findings: SecurityFinding[] },
  lenses: ReviewLensResult[],
): number {
  const dismissed = new Set<string>();
  for (const f of collectRefutable(peer, security, lenses)) {
    if (isRefuted(miningResult(results, f.agentId))) dismissed.add(f.fingerprint);
  }
  if (dismissed.size === 0) return 0;

  let count = 0;
  const mark = (reviewerId: string, findings: (PeerFinding | SecurityFinding)[]): void => {
    for (const f of findings) {
      if (!isBlockingSeverity(f.severity)) continue;
      if (!dismissed.has(findingFingerprint(reviewerId, f.path ?? '', f.issue))) continue;
      f.refuted = true;
      count++;
    }
  };
  mark('peer-reviewer', peer.findings);
  mark('security-code-reviewer', security.findings);
  for (const lens of lenses) mark(lens.id, lens.findings);

  peer.verdict = adjustVerdict(peer.verdict, peer.findings, 'DISCUSS');
  security.verdict = adjustVerdict(security.verdict, security.findings, 'NEEDS_FIXES');
  for (const lens of lenses) lens.verdict = adjustVerdict(lens.verdict, lens.findings, 'DISCUSS');
  return count;
}

/** The findings that still stand. Refuted ones surface at gate 2 but never block, never
 *  reach the implementer, and never enter the task-history digest. */
function live<T extends { refuted?: boolean }>(findings: T[]): T[] {
  return findings.filter((f) => !f.refuted);
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
    agentDefinitionGuidance(
      'peer-reviewer',
      [
        'If a `.claude/agents/peer-reviewer.md` agent definition exists in the repo, follow it;',
        'otherwise follow the protocol below.',
      ].join('\n'),
    ),
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
    agentDefinitionGuidance(
      'security-code-reviewer',
      [
        'If a `.claude/agents/security-code-reviewer.md` agent definition exists in the repo, follow',
        'it; otherwise follow the protocol below.',
      ].join('\n'),
    ),
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
    agentDefinitionGuidance(
      lens.id,
      [
        `If a \`.claude/agents/${lens.id}.md\` agent definition exists in the repo, follow it;`,
        'otherwise follow the protocol below.',
      ].join('\n'),
    ),
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

// Preamble to the fix-loop diagnosis. Every other finding path in the workflow hands
// the implementer a licence to reject a wrong finding — 05's CORRECT_RULES, 05a's
// FIX_RULES, gate-2's formatRejectDiagnosis for the broad audit — and 08c was the
// exception, so an unverified reviewer claim was acted on directly, at the cost of
// one of five capped fix rounds.
//
// Note the deliberate asymmetry with gate-2: a DEVELOPER's findings there are
// authoritative and must not be dismissed. These are a REVIEWER's, and a reviewer
// can be wrong.
const VALIDATE_THEN_ACT = [
  'Automated code review requested changes. These are REVIEWER findings, not observations from a',
  'developer using the running app.',
  '',
  'Do NOT blindly trust the reviewer. For EACH finding, FIRST validate it yourself against the',
  'actual code: confirm the issue is real, correctly described, and in scope for this change.',
  'Fix ONLY the findings you validated as real and in scope. Ignore any that are wrong, already',
  'handled, or out of scope — and say which ones you ignored, and why, in your summary. A',
  'speculative edit made to satisfy a bogus finding is worse than the finding.',
  '',
  'Findings marked [critical] or [high] are what blocked the review; [medium] and [low] are',
  'advisory — fix them only if they are real and cheap.',
].join('\n');

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
      // Refuted findings are dropped, not annotated: the implementer must not spend a
      // capped fix round arguing with a claim a refuter already disproved. They stay
      // visible at gate 2, where a human can disagree.
      const peerFindings = live(out.peer.findings);
      const securityFindings = live(out.security.findings);
      // One element: `parts` is joined with a blank line, so the preamble must arrive
      // as a single block rather than one paragraph per line.
      const parts: string[] = [VALIDATE_THEN_ACT];
      if (peerFindings.length) {
        parts.push(
          '### Peer review\n' +
            peerFindings
              .map(
                (f) => `- [${f.severity}] ${f.path}: ${f.issue}${f.fix ? ` — fix: ${f.fix}` : ''}`,
              )
              .join('\n'),
        );
      }
      if (securityFindings.length) {
        parts.push(
          '### Security\n' +
            securityFindings
              .map(
                (f) => `- [${f.severity}] ${f.path}: ${f.issue}${f.fix ? ` — fix: ${f.fix}` : ''}`,
              )
              .join('\n'),
        );
      }
      for (const lens of out.extraLenses) {
        const lensFindings = live(lens.findings);
        if (!lensFindings.length) continue;
        parts.push(
          `### ${lens.title}\n` +
            lensFindings
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
    // A reviewer SIGKILLed at 30 minutes loses every finding it made. Steer it to bank
    // the verified ones first. Safe here because a reviewer only reads and reports.
    softTimeout: true,
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
    // One re-roll per reviewer. parseJsonLoose already salvages a truncated or
    // malformed turn via a balanced-brace scan and a jsonrepair pass, so a reviewer
    // that still yields nothing usually emitted prose — a fresh roll fixes that far
    // more cheaply than a fix round or a developer reject. Two, not three: the
    // failure is rare, and the degrade path below is a safe floor.
    retry: { maxAttempts: 2 },
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
        reviewIncomplete: false,
        advisoryVerdict: false,
        refutedCount: 0,
        counts: { peer: 0, securityCriticalHigh: 0 },
      };
    }

    // A reviewer that RAN but whose output could not be parsed (even after the
    // jsonrepair salvage) must NOT be reported as APPROVE/SECURE — that would
    // advance unreviewed code. While the agent still has a re-roll left, throw so
    // the runner re-dispatches just that reviewer; once its budget is spent, degrade
    // to a visible, non-approving finding and flag the review as incomplete.
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
    const unparsedLensIds: string[] = [];
    for (const lens of REVIEW_LENSES) {
      const raw = miningResult(results, lens.id);
      if (raw == null) continue;
      const parsed = parseReviewLens(raw);
      if (parsed == null) {
        unparsedLensIds.push(lens.id);
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

    // Re-roll the reviewers whose output could not be read, while any of them still
    // has budget. The runner re-dispatches only these; the other agents' completed
    // rows are untouched, and apply() runs again once they finish.
    const unreadable = [
      ...(peerUnparsed ? ['peer-reviewer'] : []),
      ...(securityUnparsed ? ['security-code-reviewer'] : []),
      ...unparsedLensIds,
    ];
    if (unreadable.length > 0 && args.isFinalMiningAttempt === false) {
      throw new MiningRetryError(unreadable);
    }

    // Budget spent (or no retry configured): the review did not complete. This is NOT
    // blocking — the reviewer failed, not the code, and routing the change back to the
    // implementer for that would burn a fix round on nothing. It must still not read as
    // OK at gate 2, which is what reviewIncomplete carries.
    const reviewIncomplete = unreadable.length > 0;

    // Block on what we REPORT, not on what parsed: peerOut/securityOut carry the
    // synthetic findings for an unparseable reviewer, so the blocking decision and
    // the gate-2 finding list can never disagree.
    let blocking = computeBlocking(peerOut, securityOut, extraLenses);

    // Refutation, in two passes over the same apply(). The first throws to dispatch one
    // refuter per blocking finding (apply cannot fan out itself — see MiningWaveError);
    // the second reads their verdicts back and recomputes what still blocks.
    //
    // Only blocking findings are refuted, and collectRefutable enforces that: they are
    // the only ones that cost a fix round. An empty list therefore means nothing blocks
    // and there is no claim to disprove.
    const waveRan = results.some((r) => r.agentId.startsWith(REFUTER_PREFIX));
    let refutedCount = 0;
    if (waveRan) {
      refutedCount = applyRefutations(results, peerOut, securityOut, extraLenses);
      blocking = computeBlocking(
        { findings: live(peerOut.findings) },
        { findings: live(securityOut.findings) },
        extraLenses.map((l) => ({ findings: live(l.findings) })),
      );
    } else if (args.miningWaveExhausted !== true) {
      const refutable = collectRefutable(peerOut, securityOut, extraLenses);
      if (
        refutable.length > 0 &&
        (await configService.getBoolean(CONFIG_KEYS.REVIEW_REFUTE_ENABLED, true))
      ) {
        // Worst first (severityRank: lower is more severe), so a capped wave spends its
        // invocations on the findings that hurt most if they are wrong.
        const wave = [...refutable]
          .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
          .slice(0, MAX_REFUTERS);
        if (wave.length < refutable.length) {
          ctx.logger.warn(
            { total: refutable.length, refuting: wave.length },
            'more blocking findings than refuters; the overflow stands unrefuted',
          );
        }
        ctx.logger.info({ count: wave.length }, 'dispatching refuters for blocking findings');
        throw new MiningWaveError(
          wave.map((f, i) => ({
            agentId: f.agentId,
            agentTitle: refuterTitle(f, i, wave.length),
            prompt: buildRefutePrompt(args.detected, f),
          })),
        );
      }
    }

    await recordReviewFindings(ctx, '08c-code-review', [
      ...peerOut.findings.map((f) => ({
        reviewerId: 'peer-reviewer',
        severity: f.severity,
        issue: f.issue,
        path: f.path,
        lines: f.lines,
        fix: f.fix,
        blocking: isBlockingSeverity(f.severity) && !f.refuted,
        disposition: f.refuted ? ('dismissed_refuted' as const) : ('open' as const),
        dispositionSource: f.refuted ? 'refuter' : undefined,
        raw: f,
      })),
      ...securityOut.findings.map((f) => ({
        reviewerId: 'security-code-reviewer',
        severity: f.severity,
        issue: f.issue,
        path: f.path,
        lines: f.line,
        fix: f.fix,
        blocking: isBlockingSeverity(f.severity) && !f.refuted,
        disposition: f.refuted ? ('dismissed_refuted' as const) : ('open' as const),
        dispositionSource: f.refuted ? 'refuter' : undefined,
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
          blocking: isBlockingSeverity(f.severity) && !f.refuted,
          disposition: f.refuted ? ('dismissed_refuted' as const) : ('open' as const),
          dispositionSource: f.refuted ? 'refuter' : undefined,
          raw: f,
        })),
      ),
    ]);

    const securityCriticalHigh = live(securityOut.findings).filter((f) =>
      isBlockingSeverity(f.severity),
    ).length;
    // After applyRefutations, so a verdict its refuted findings no longer support has
    // already been downgraded and does not hold the gate.
    const advisoryVerdict = !blocking && hasNonApprovingVerdict(peerOut, securityOut);

    ctx.logger.info(
      {
        peerVerdict: peerOut.verdict,
        securityVerdict: securityOut.verdict,
        peerFindings: peerOut.findings.length,
        securityCriticalHigh,
        lenses: extraLenses.map((l) => `${l.id}:${l.verdict}`),
        blocking,
        advisoryVerdict,
        refutedCount,
        reviewIncomplete,
        unreadable,
      },
      'code review complete',
    );

    return {
      reviewed: true,
      peer: peerOut,
      security: securityOut,
      extraLenses,
      blocking,
      reviewIncomplete,
      advisoryVerdict,
      refutedCount,
      counts: { peer: peerOut.findings.length, securityCriticalHigh },
    };
  },
};
