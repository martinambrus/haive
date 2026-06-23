import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import type { FormSchema } from '@haive/shared';
import type { StepContext } from '../../step-definition.js';

// Durable channel for the fix-loop diagnosis. When a downstream step finds a blocking
// defect it returns `loop_back`; handleResult records the diagnosis here and re-enters
// at the implementation step at round N. The round-N implement reads the request for
// its own round and runs in fix mode. task_events are append-only and survive step-row
// materialization, and the `round` in the payload disambiguates which request belongs
// to which fix round (mirrors _biz-req-feedback.ts).

/** The step every fix round re-enters at: the implementation phase re-runs in fix
 *  mode, then the whole post-implementation chain re-runs as new round-N rows. */
export const FIX_LOOP_TARGET_STEP_ID = '07-phase-2-implement';
/** Fallback cap when a task predates tasks.max_fix_rounds (set on the Gate-1 form). */
export const DEFAULT_MAX_FIX_ROUNDS = 5;
const FIX_LOOP_REQUESTED = 'fix_loop.requested';
const FIX_LOOP_ACCEPTED = 'fix_loop.accepted';
/** Radio field id on the escalation gate form — its presence in a submitted form
 *  marks the submission as a gate decision (not a normal step re-run). */
export const FIX_LOOP_ACTION_FIELD = 'fixLoopAction';

/** The escalation gate shown when the fix loop hits the round cap: the diagnosis +
 *  Continue / Accept / Abort. Parked on the source step (the one that found the
 *  defect); resolved by handleAdvanceStep on submit. Mirrors the revise-loop review
 *  gate (a parked form whose submitted choice drives the routing). */
export function buildFixLoopEscalationSchema(
  sourceStepId: string,
  diagnosis: string,
  cap: number,
): FormSchema {
  return {
    title: `Fix loop reached the ${cap}-round limit`,
    description:
      `The automatic fix loop ran ${cap} round${cap === 1 ? '' : 's'} without resolving the issue ` +
      `${sourceStepId} found. Decide how to proceed.`,
    infoSections: [
      {
        title: 'Latest diagnosis',
        body: diagnosis || '(no diagnosis recorded)',
        defaultOpen: true,
      },
    ],
    fields: [
      {
        type: 'radio',
        id: FIX_LOOP_ACTION_FIELD,
        label: 'How would you like to proceed?',
        options: [
          { value: 'continue', label: 'Continue fixing — run one more fix round' },
          { value: 'accept', label: 'Accept the remaining issues and proceed to verification' },
          { value: 'abort', label: 'Abort the task' },
        ],
        default: 'continue',
      },
    ],
    submitLabel: 'Apply decision',
  };
}

/** Escalation gate for a DETECTED OSCILLATION (two checks with contradictory criteria).
 *  Same Continue/Accept/Abort decision as buildFixLoopEscalationSchema — and reuses
 *  FIX_LOOP_ACTION_FIELD so the existing gate resolver handles the submission unchanged —
 *  but surfaces BOTH conflicting diagnoses so the user can see why the loop is stuck. */
export function buildOscillationEscalationSchema(
  stepA: string,
  stepB: string,
  diagA: string,
  diagB: string,
): FormSchema {
  const tail = (s: string): string => (s.length > 1500 ? s.slice(-1500) : s);
  return {
    title: `Fix loop is oscillating between ${stepA} and ${stepB}`,
    description:
      `Two checks disagree and the fix loop cannot satisfy both: ${stepA} keeps re-raising ` +
      `an issue that ${stepB}'s change reverses, and vice versa, so the loop will not ` +
      `converge on its own. Decide how to proceed.`,
    infoSections: [
      {
        title: `Constraint from ${stepA}`,
        body: tail(diagA) || '(no diagnosis recorded)',
        defaultOpen: true,
      },
      {
        title: `Conflicting change from ${stepB}`,
        body: tail(diagB) || '(no diagnosis recorded)',
        defaultOpen: true,
      },
    ],
    fields: [
      {
        type: 'radio',
        id: FIX_LOOP_ACTION_FIELD,
        label: 'How would you like to proceed?',
        options: [
          { value: 'continue', label: 'Continue fixing — run one more fix round' },
          { value: 'accept', label: 'Accept the current state and proceed to verification' },
          { value: 'abort', label: 'Abort the task' },
        ],
        default: 'continue',
      },
    ],
    submitLabel: 'Apply decision',
  };
}

/** Record that the user accepted the remaining issues — every later fix-loop check is
 *  suppressed for this task so the run proceeds to gate 2 instead of looping again. */
export async function recordFixLoopAccepted(
  db: Database,
  taskId: string,
  sourceTaskStepId: string,
): Promise<void> {
  await db.insert(schema.taskEvents).values({
    taskId,
    taskStepId: sourceTaskStepId,
    eventType: FIX_LOOP_ACCEPTED,
    payload: {},
  });
}

/** True once the user accepted remaining issues at the escalation gate — downstream
 *  fix-loop checks stop routing back so the run finishes. */
export async function isFixLoopSuppressed(db: Database, taskId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.taskEvents.id })
    .from(schema.taskEvents)
    .where(
      and(eq(schema.taskEvents.taskId, taskId), eq(schema.taskEvents.eventType, FIX_LOOP_ACCEPTED)),
    )
    .limit(1);
  return rows.length > 0;
}

export interface FixLoopRequest {
  diagnosis: string;
  sourceStepId: string;
  round: number;
}

// ANSI escape sequences (terminal colour/cursor codes) — a stable, specified format
// (ECMA-48), safe to strip and pure noise in a text prompt.
const ANSI_RE = /\x1B\[[0-9;?]*[A-Za-z]/g;

/** Strip ANSI escape codes and normalise whitespace so raw tool output reads cleanly
 *  in a prompt. Deliberately does NOT try to recognise or remove tool banners / promo
 *  text: that copy changes shape over time, so pattern-matching it is brittle and
 *  risks eating the real error. Instead the fix-mode prompt instructs the agent to
 *  locate the actual error within the output (the LLM is the dynamic extractor).
 *  Keeps the tail when very long — CLI errors put the summary last. */
export function cleanDiagnosis(raw: string): string {
  const cleaned = raw
    .replace(ANSI_RE, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned.length > 6000 ? cleaned.slice(-6000) : cleaned;
}

// Volatile tokens that differ between otherwise-identical diagnoses and must be removed
// before fingerprinting: uuids (task ids, snapshot names), file paths, and bare numbers
// (line numbers, ports, php/db versions, round counters). Stripping them keeps the SAME
// recurring complaint stable while leaving genuinely different complaints distinct.
const FP_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const FP_PATH_RE = /[/\\][^\s'"]+/g;
const FP_DIGITS_RE = /\d+/g;

/** Stable signature of a fix-loop diagnosis, namespaced by its source step. Two diagnoses
 *  from the SAME step that say the same thing (modulo ids, paths, and numbers) hash equal;
 *  diagnoses from different steps never collide (sourceStepId is part of the key). Lets
 *  detectFixLoopOscillation spot a step re-raising the same complaint across rounds. */
export function fixLoopFingerprint(sourceStepId: string, diagnosis: string): string {
  const normalized = cleanDiagnosis(diagnosis)
    .toLowerCase()
    .replace(FP_UUID_RE, '')
    .replace(FP_PATH_RE, '')
    .replace(FP_DIGITS_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  return `${sourceStepId}:${hash}`;
}

/** Record a fix-loop request as a task_event so the round-N implement can read it. The
 *  diagnosis fingerprint is stored alongside so the oscillation guard compares rounds with
 *  a cheap equality check (it recomputes for legacy rows that predate the field). */
export async function recordFixLoopRequest(
  db: Database,
  taskId: string,
  sourceTaskStepId: string,
  req: FixLoopRequest,
): Promise<void> {
  await db.insert(schema.taskEvents).values({
    taskId,
    taskStepId: sourceTaskStepId,
    eventType: FIX_LOOP_REQUESTED,
    payload: { ...req, fingerprint: fixLoopFingerprint(req.sourceStepId, req.diagnosis) },
  });
}

export interface OscillationResult {
  tripped: boolean;
  /** [current diagnosis, the most recent OTHER-source diagnosis] — both sides of the
   *  deadlock, shown on the escalation gate. Set only when tripped. */
  conflictingDiagnoses?: [string, string];
  /** The other source step that alternated in (for the gate title + event). */
  conflictingStepId?: string;
}

/** Detect a non-converging fix loop: the SAME source step re-raising a fingerprint-equal
 *  diagnosis at least two rounds apart, AND a DIFFERENT source looping back in between —
 *  the signature of two checks with contradictory accept-criteria (e.g. 07c needs the DDEV
 *  project name pinned while 07b's validator keeps asking to rename it). Reads the
 *  append-only fix_loop.requested history; recomputes fingerprints for rows written before
 *  the stored field. Never trips before nextRound 3 (needs a prior round <= nextRound-2). */
export async function detectFixLoopOscillation(
  db: Database,
  taskId: string,
  sourceStepId: string,
  diagnosis: string,
  nextRound: number,
): Promise<OscillationResult> {
  if (nextRound < 3) return { tripped: false };
  const fpNow = fixLoopFingerprint(sourceStepId, diagnosis);
  const rows = await db
    .select()
    .from(schema.taskEvents)
    .where(
      and(
        eq(schema.taskEvents.taskId, taskId),
        eq(schema.taskEvents.eventType, FIX_LOOP_REQUESTED),
      ),
    )
    .orderBy(desc(schema.taskEvents.createdAt));
  type Payload = {
    diagnosis?: string;
    sourceStepId?: string;
    round?: number;
    fingerprint?: string;
  };
  const prior = rows
    .map((r) => r.payload as Payload | null)
    .filter((p): p is Payload => !!p && typeof p.round === 'number');

  // Same source re-raising the same complaint, at least two rounds before this one.
  const repeat = prior.find(
    (p) =>
      p.sourceStepId === sourceStepId &&
      (p.round ?? 0) <= nextRound - 2 &&
      (p.fingerprint ?? fixLoopFingerprint(p.sourceStepId ?? '', p.diagnosis ?? '')) === fpNow,
  );
  if (!repeat) return { tripped: false };

  // A DIFFERENT source looped back between that repeat and now (the alternation).
  const between = prior
    .filter(
      (p) =>
        p.sourceStepId !== sourceStepId &&
        (p.round ?? 0) > (repeat.round ?? 0) &&
        (p.round ?? 0) < nextRound,
    )
    .sort((a, b) => (b.round ?? 0) - (a.round ?? 0));
  if (between.length === 0) return { tripped: false };

  return {
    tripped: true,
    conflictingDiagnoses: [diagnosis, between[0]?.diagnosis ?? ''],
    conflictingStepId: between[0]?.sourceStepId ?? 'another step',
  };
}

/** The diagnosis the implementation step should fix on this round, or null on the
 *  original pass (round 0) or when no recorded request matches the current round. */
export async function loadFixLoopDiagnosis(ctx: StepContext): Promise<string | null> {
  if (ctx.round <= 0) return null;
  const rows = await ctx.db
    .select()
    .from(schema.taskEvents)
    .where(
      and(
        eq(schema.taskEvents.taskId, ctx.taskId),
        eq(schema.taskEvents.eventType, FIX_LOOP_REQUESTED),
      ),
    )
    .orderBy(desc(schema.taskEvents.createdAt));
  for (const r of rows) {
    const p = r.payload as { diagnosis?: string; round?: number } | null;
    if (p?.round === ctx.round) {
      const d = cleanDiagnosis((p.diagnosis ?? '').trim());
      return d.length > 0 ? d : null;
    }
  }
  return null;
}

/** Source steps whose fix-loop diagnoses are OBJECTIVE/runtime failures the implementation
 *  had to satisfy (build, runtime, tests, code review, human verification) — NOT 07b's own
 *  validator findings, which it re-derives each pass. Their diagnoses become "honored
 *  constraints" the validator must not reverse. */
const HONORED_CONSTRAINT_SOURCES = new Set([
  '07c-ddev-reconcile',
  '08-phase-5-verify',
  '08a-browser-verify',
  '08c-code-review',
  '08d-adversarial-qa',
  '09-gate-2-verify-approval',
]);

/** Prior objective/runtime fix-loop diagnoses (from HONORED_CONSTRAINT_SOURCES, this round
 *  or earlier) formatted as a "these are deliberate fixes — do not revert them" block for the
 *  implementation validator (07b). Deduped to the latest per source, cleaned, length-capped.
 *  Excludes 07b's own findings (it re-checks those itself) so it never tells the validator to
 *  ignore the very work it is validating. Returns '' on the original pass or when none exist. */
export async function loadHonoredConstraints(ctx: StepContext): Promise<string> {
  if (ctx.round <= 0) return '';
  const rows = await ctx.db
    .select()
    .from(schema.taskEvents)
    .where(
      and(
        eq(schema.taskEvents.taskId, ctx.taskId),
        eq(schema.taskEvents.eventType, FIX_LOOP_REQUESTED),
      ),
    )
    .orderBy(desc(schema.taskEvents.createdAt));
  type Payload = { diagnosis?: string; sourceStepId?: string; round?: number };
  // rows are newest-first → the first diagnosis seen per source is its latest. Include the
  // current round (payload.round === ctx.round is the failure 07 just fixed this round, which
  // 07b is most likely to re-flag).
  const latestPerSource = new Map<string, string>();
  for (const r of rows) {
    const p = r.payload as Payload | null;
    if (!p?.sourceStepId || typeof p.round !== 'number') continue;
    if (p.round > ctx.round) continue;
    if (!HONORED_CONSTRAINT_SOURCES.has(p.sourceStepId)) continue;
    if (!latestPerSource.has(p.sourceStepId)) {
      latestPerSource.set(p.sourceStepId, cleanDiagnosis((p.diagnosis ?? '').trim()));
    }
  }
  const entries = [...latestPerSource.entries()]
    .filter(([, d]) => d.length > 0)
    .map(([src, d]) => `- ${src}: ${d}`);
  if (entries.length === 0) return '';
  const block = [
    'HONORED CONSTRAINTS — the current code is shaped to satisfy these prior verification/',
    'runtime failures. They were DELIBERATE fixes, not defects. Do NOT recommend reverting them',
    'or flag them under Developer Experience / naming / style. In particular, the DDEV project',
    'name in .ddev/config.yaml is harness-owned and registered with the running environment —',
    'do not flag it. You MAY still flag genuine breakage (the code no longer works), but any fix',
    'you propose MUST preserve these constraints rather than undo them:',
    ...entries,
  ].join('\n');
  return block.length > 3000 ? block.slice(0, 3000) : block;
}
