import { createHash } from 'node:crypto';
import { schema } from '@haive/database';
import { isCredentialCwe } from '@haive/shared/review';
import type { ReviewSeverity } from '@haive/shared/review';
import type { StepContext } from '../../step-definition.js';

/* ------------------------------------------------------------------ */
/* Durable review findings. Findings otherwise live only in            */
/* task_steps.output jsonb, which a manual retry nulls, and nothing    */
/* records whether a finding was ever fixed. Persist them so a change  */
/* to the reviewers can be measured instead of assumed.                */
/*                                                                     */
/* Writes are BEST-EFFORT: recordReviewFindings never throws. Telemetry*/
/* must not be able to fail a review step.                             */
/* ------------------------------------------------------------------ */

const FP_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const FP_DIGITS_RE = /\d+/g;

/**
 * A concrete `path/to/file.ext:123` citation. The extension must start with a letter so
 * a version string (`1.2:30`) or a clock time (`12:30`) cannot pose as evidence.
 *
 * Used wherever an agent's claim is only admitted on proof it can point at: the KB
 * admission bar, and the refuter that must show WHY a finding is wrong before it is
 * allowed to dismiss one.
 */
const FILE_LINE_EVIDENCE_RE = /[\w./-]*\w\.[A-Za-z][A-Za-z0-9]{0,11}:\d+/;

/** Does any of these texts cite a file and a line? */
export function hasFileLineEvidence(...texts: (string | undefined | null)[]): boolean {
  return texts.some((t) => typeof t === 'string' && FILE_LINE_EVIDENCE_RE.test(t));
}

/** Stable signature of a finding, namespaced by the reviewer that raised it.
 *
 *  Unlike `fixLoopFingerprint`, this KEEPS the path: there, the path is incidental
 *  detail in a prose diagnosis; here it is half the finding's identity — "npe in
 *  a.ts" and "npe in b.ts" are two findings, not one. Line numbers and ids are
 *  stripped so the same defect still hashes equal after the file around it moves.
 */
export function findingFingerprint(reviewerId: string, path: string, issue: string): string {
  const normalized = issue
    .toLowerCase()
    .replace(FP_UUID_RE, '')
    .replace(FP_DIGITS_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256')
    .update(`${reviewerId}\0${path.trim().toLowerCase()}\0${normalized}`)
    .digest('hex')
    .slice(0, 64);
}

/** Split a reviewer's line reference into a start/end pair.
 *  Accepts "12", "12-18", 12, and "a.ts:12" style tails; null when absent. */
export function parseLineRange(lines: string | number | undefined | null): {
  start: number | null;
  end: number | null;
} {
  if (lines == null) return { start: null, end: null };
  if (typeof lines === 'number') {
    return Number.isFinite(lines) ? { start: lines, end: lines } : { start: null, end: null };
  }
  const matched = lines.match(/(\d+)(?:\s*[-–:]\s*(\d+))?/);
  if (!matched) return { start: null, end: null };
  const start = Number(matched[1]);
  const end = matched[2] != null ? Number(matched[2]) : start;
  return { start, end };
}

/** Split a `path:line` or `path:line:col` reference into its parts. Reviewers that
 *  carry no separate line field (07b's `file`, 08d's `location`) pack it in here.
 *  A location that is a URL rather than a file keeps its whole value as the path. */
export function splitLocation(location: string | undefined | null): {
  path: string;
  lines: string | null;
} {
  const raw = (location ?? '').trim();
  if (!raw || /^https?:\/\//i.test(raw)) return { path: raw, lines: null };
  const matched = raw.match(/^(.*?):(\d+(?:-\d+)?)(?::\d+)?$/);
  if (!matched?.[1]) return { path: raw, lines: null };
  return { path: matched[1], lines: matched[2] ?? null };
}

export interface RecordableFinding {
  /** Which reviewer raised it: 'peer-reviewer', an adversary id, 'validator', ... */
  reviewerId: string;
  /** The CLI invocation that produced it, when the caller can name one.
   *
   *  This is the only DURABLE link from a finding to the model that raised it. Per-seat
   *  attribution also exists on `task_step_agent_minings` (agent id + provider +
   *  invocation), but `resetStepAndDownstream` DELETES those rows on a retry while
   *  cli_invocations are merely superseded and review_findings is left untouched — so
   *  after one Retry that table can no longer answer the question and this column is
   *  what still can. Optional: a caller that genuinely cannot name one invocation (a
   *  finding merged from several agents) leaves it unset rather than guessing. */
  cliInvocationId?: string | null;
  severity: ReviewSeverity;
  issue: string;
  path?: string | null;
  lines?: string | number | null;
  fix?: string | null;
  /** Whether this finding contributed to the step's blocking decision. */
  blocking?: boolean;
  /** Set when the finding is already resolved by the time it is first written — a
   *  refuter disproved it. Written at insert rather than by a later UPDATE, because the
   *  insert happens on the FINAL apply() of the step, after refutation has run. */
  disposition?: 'open' | 'dismissed_refuted';
  /** What set a non-open disposition: 'refuter', a step id, 'fix_loop'. */
  dispositionSource?: string;
  /** The finding as emitted, for fields the table does not model (cwe, attack, poc). */
  raw?: unknown;
}

/** Reviewers whose every finding quotes a credential, whatever CWE they name.
 *
 *  The secret sweeper looks for nothing else, so its snippet is a secret by
 *  construction — which is what keeps the redaction below off the model's word. */
const CREDENTIAL_REVIEWERS = new Set(['secret-sweeper']);

/** `raw` as the table stores it: a credential finding's quoted line is dropped.
 *
 *  For a hard-coded-credential finding the line a reviewer quotes as evidence IS the
 *  credential, and `path` + `lineStart` locate the code perfectly well without it —
 *  so persisting the snippet only writes the secret into a second place. Nothing
 *  reads it: gate 2's renderer never prints a snippet and the task-history digest
 *  carries only cwe/issue/fix/path, so dropping it costs nothing.
 *
 *  `task_steps.output` deliberately keeps the snippet. It is ephemeral (a manual
 *  retry nulls it via resetStepAndDownstream) and the fix-loop diagnosis reads it,
 *  whereas a review_findings row is written to outlive the step by design. */
function withheldRaw(f: RecordableFinding): unknown {
  const raw = f.raw;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw ?? null;
  const record = raw as Record<string, unknown>;
  if (!('snippet' in record)) return raw;
  const credential = CREDENTIAL_REVIEWERS.has(f.reviewerId) || isCredentialCwe(record.cwe);
  return credential ? { ...record, snippet: '' } : raw;
}

/** Persist a review step's findings. Never throws — a failed insert is logged and
 *  swallowed, because a telemetry write must not fail the review that produced it. */
export async function recordReviewFindings(
  ctx: StepContext,
  stepId: string,
  findings: RecordableFinding[],
): Promise<void> {
  if (findings.length === 0) return;
  try {
    const rows = findings.map((f) => {
      const path = (f.path ?? '').trim();
      const { start, end } = parseLineRange(f.lines);
      const disposition = f.disposition ?? 'open';
      return {
        taskId: ctx.taskId,
        taskStepId: ctx.taskStepId,
        cliInvocationId: f.cliInvocationId ?? null,
        stepId,
        round: ctx.round,
        reviewerId: f.reviewerId,
        severity: f.severity,
        path: path || null,
        lineStart: start,
        lineEnd: end,
        issue: f.issue,
        fix: f.fix ?? null,
        fingerprint: findingFingerprint(f.reviewerId, path, f.issue),
        blocking: f.blocking ?? false,
        disposition,
        dispositionAt: disposition === 'open' ? null : new Date(),
        dispositionSource: disposition === 'open' ? null : (f.dispositionSource ?? null),
        raw: withheldRaw(f),
      };
    });
    // A step's apply() can run more than once per round (07b's validator/fixer loop,
    // and a mining retry re-running apply after re-rolling one agent), so the same
    // finding can be offered twice. The dedupe index collapses it.
    await ctx.db
      .insert(schema.reviewFindings)
      .values(rows)
      .onConflictDoNothing({
        target: [
          schema.reviewFindings.taskId,
          schema.reviewFindings.taskStepId,
          schema.reviewFindings.round,
          schema.reviewFindings.fingerprint,
        ],
      });
  } catch (err) {
    ctx.logger.warn(
      { err, stepId, count: findings.length },
      'failed to record review findings (telemetry only; review unaffected)',
    );
  }
}
