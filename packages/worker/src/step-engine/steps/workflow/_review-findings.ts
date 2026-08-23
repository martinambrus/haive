import { createHash } from 'node:crypto';
import { and, eq, inArray, lt } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { Database } from '@haive/database';
import { logger } from '@haive/shared';
import { isCredentialCwe } from '@haive/shared/review';
import type { ReviewSeverity } from '@haive/shared/review';
import type { StepContext } from '../../step-definition.js';

/** For the one writer below whose caller runs outside a step and so has no ctx.logger. */
const log = logger.child({ module: 'review-findings' });

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
    // Loaded here rather than asked of every caller, so 07b / 08c / 08c2 / 08d all count
    // recurrence without each re-deriving it. One SELECT beside a step that just spent CLI
    // invocations is not a cost worth optimising.
    const recurrence = await loadFindingRecurrence(ctx, ctx.round);
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
        recurrenceCount: recurrence.get(recurrenceKey(f.reviewerId, path))?.length ?? 0,
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

/** Mark findings a HUMAN looked at and chose not to act on this round.
 *
 *  Same best-effort contract as recordReviewFindings: never throws, because a telemetry
 *  write must not fail the gate that produced it.
 *
 *  Two guards, each load-bearing:
 *
 *  - `disposition = 'open'`, so a row a refuter already disproved keeps `dismissed_refuted`.
 *    A human declining to fix something is a weaker statement than a PoC that would not run,
 *    and the stronger verdict is the one worth keeping.
 *  - `round = ctx.round`. The same fingerprint recurs on its OWN row every round, so an
 *    unscoped update would rewrite the history of rounds the developer never saw.
 */
export async function dispositionReviewFindings(
  ctx: StepContext,
  fingerprints: string[],
  disposition: 'dismissed_human',
  source: string,
): Promise<void> {
  const unique = [...new Set(fingerprints.filter((f) => f.length > 0))];
  if (unique.length === 0) return;
  try {
    await ctx.db
      .update(schema.reviewFindings)
      .set({ disposition, dispositionAt: new Date(), dispositionSource: source })
      .where(
        and(
          eq(schema.reviewFindings.taskId, ctx.taskId),
          eq(schema.reviewFindings.round, ctx.round),
          eq(schema.reviewFindings.disposition, 'open'),
          inArray(schema.reviewFindings.fingerprint, unique),
        ),
      );
  } catch (err) {
    ctx.logger.warn(
      { err, source, count: unique.length },
      'failed to disposition review findings (telemetry only; the gate decision stands)',
    );
  }
}

/** Mark everything still outstanding as knowingly shipped, when the developer accepts the
 *  remainder at the fix-loop escalation gate.
 *
 *  That gate is reached only at the round cap (or a detected oscillation), and accepting
 *  there stands down EVERY later fix-loop check for the task — so the findings of the round
 *  it was raised in are not merely unfixed, they are shipped on a decision. `accepted_risk`
 *  is that decision; `open` would keep claiming they are still being worked.
 *
 *  Scoped to `round`, like dispositionReviewFindings and for a second reason on top of its
 *  one: nothing ever writes `fixed`, so an earlier round's rows are still `open` whether they
 *  were fixed or recurred. Only the round the gate was raised in describes what is actually
 *  outstanding at the moment of acceptance — a recurring finding is re-raised into it anyway.
 *
 *  Covers the whole round rather than the gate's own step, because acceptance stands the loop
 *  down for every check, not just the one that tripped. `disposition = 'open'` still guards,
 *  so a refuter's `dismissed_refuted` and a gate-1.5 `dismissed_human` both keep the more
 *  specific verdict.
 *
 *  Takes a db rather than a StepContext because its caller is the queue's gate resolver,
 *  which runs outside any step. Best-effort in the same way: never throws. */
export async function acceptRemainingReviewFindings(
  db: Database,
  taskId: string,
  round: number,
  source: string,
): Promise<void> {
  try {
    await db
      .update(schema.reviewFindings)
      .set({
        disposition: 'accepted_risk',
        dispositionAt: new Date(),
        dispositionSource: source,
      })
      .where(
        and(
          eq(schema.reviewFindings.taskId, taskId),
          eq(schema.reviewFindings.round, round),
          eq(schema.reviewFindings.disposition, 'open'),
        ),
      );
  } catch (err) {
    log.warn(
      { err, taskId, round, source },
      'failed to accept remaining review findings (telemetry only; the gate decision stands)',
    );
  }
}

/** The key recurrence is measured on: one reviewer, one file, within one task.
 *
 *  Deliberately NOT `findingFingerprint`. That hashes the ISSUE TEXT, so it identifies a
 *  PHRASING rather than a defect — two rounds' descriptions of one problem are different
 *  sentences and hash apart. MEASURED across 9,750 findings in 68 multi-round tasks: the
 *  fingerprint matches across rounds 5 times (0.05%), while (reviewer, path) matches 1,408
 *  times out of 3,294 (42.7%), and reading the rows confirms those really are one complaint
 *  re-raised — one of them across 19 rounds.
 *
 *  The cost of the coarser key is that two DISTINCT defects a reviewer found in one file
 *  count as a repeat. That is why everything built on this says "this reviewer already
 *  flagged this file", never "the same defect" — the key cannot support the stronger claim.
 *
 *  Path normalisation matches findingFingerprint's, so the two agree on what one file is. */
export function recurrenceKey(reviewerId: string, path: string | null | undefined): string {
  return `${reviewerId}\0${(path ?? '').trim().toLowerCase()}`;
}

/** Earlier rounds in which each (reviewer, file) was already raised for this task.
 *
 *  Rounds STRICTLY BELOW `beforeRound`, so a step reading this during its own round counts
 *  only history and never itself. Distinct and ascending.
 *
 *  Degrades to an empty map on any failure — a recurrence tag is context for a human and a
 *  hint for the next fixer, and neither is worth failing a gate over. */
export async function loadFindingRecurrence(
  ctx: StepContext,
  beforeRound: number,
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (beforeRound <= 0) return out;
  try {
    const rows = await ctx.db
      .select({
        reviewerId: schema.reviewFindings.reviewerId,
        path: schema.reviewFindings.path,
        round: schema.reviewFindings.round,
      })
      .from(schema.reviewFindings)
      .where(
        and(
          eq(schema.reviewFindings.taskId, ctx.taskId),
          lt(schema.reviewFindings.round, beforeRound),
        ),
      );
    for (const r of rows) {
      const key = recurrenceKey(r.reviewerId, r.path);
      const seen = out.get(key);
      if (!seen) out.set(key, [r.round]);
      else if (!seen.includes(r.round)) seen.push(r.round);
    }
    for (const rounds of out.values()) rounds.sort((a, b) => a - b);
  } catch (err) {
    ctx.logger.warn({ err, beforeRound }, 'failed to load finding recurrence; continuing without');
    return new Map();
  }
  return out;
}
