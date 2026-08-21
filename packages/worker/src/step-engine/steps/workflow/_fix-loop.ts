import { and, desc, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import type { FormSchema } from '@haive/shared';
import type { StepContext } from '../../step-definition.js';
import { cleanText, contentFingerprint, loadLedgerEntries } from '../../task-ledger.js';

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

/** Optional free-text on the escalation gate: what the next fix round should actually do.
 *  Without it the gate's only "keep going" option is a blind re-run against the same diagnosis
 *  the loop has already failed on, so a loop stuck on a wrong premise can only be accepted
 *  (which stands down EVERY later fix check) or aborted. */
export const FIX_LOOP_INSTRUCTION_FIELD = 'fixLoopInstruction';

/** Pseudo-source for a diagnosis the USER wrote at the escalation gate. It is registered in both
 *  HUMAN_REJECT_SOURCES (so the implement step frames it as an authoritative directive rather
 *  than raw tool output to be filtered) and HONORED_CONSTRAINT_SOURCES (so it keeps applying in
 *  later rounds — a directive that evaporates after one round is the failure this gate exists
 *  to end). Not a step id; it never appears in the run list. */
export const FIX_LOOP_GATE_SOURCE = 'fix-loop-gate';

/** Field shared by both escalation gates. Shown only for Continue — Accept skips the
 *  implementation step entirely and Abort fails the task, so the text would be dead input. */
function instructionField(): FormSchema['fields'][number] {
  return {
    type: 'textarea',
    id: FIX_LOOP_INSTRUCTION_FIELD,
    label: 'Instructions for the next fix round (optional)',
    description:
      'Tell the implementation agent what to do — e.g. which of the two constraints is actually ' +
      'right, or a fact the loop keeps getting wrong. This is passed as an authoritative ' +
      'directive and is honored by later rounds too. Leave blank to retry unchanged.',
    rows: 4,
    visibleWhen: { field: FIX_LOOP_ACTION_FIELD, equals: 'continue' },
  };
}

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
      instructionField(),
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
      instructionField(),
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

/** Strip ANSI escape codes and normalise whitespace so raw tool output reads cleanly
 *  in a prompt. Deliberately does NOT try to recognise or remove tool banners / promo
 *  text: that copy changes shape over time, so pattern-matching it is brittle and
 *  risks eating the real error. Instead the fix-mode prompt instructs the agent to
 *  locate the actual error within the output (the LLM is the dynamic extractor).
 *  Keeps the tail when very long — CLI errors put the summary last. */
export function cleanDiagnosis(raw: string): string {
  return cleanText(raw, 6000);
}

/** Stable signature of a fix-loop diagnosis, namespaced by its source step. Two diagnoses
 *  from the SAME step that say the same thing (modulo ids, paths, and numbers) hash equal;
 *  diagnoses from different steps never collide (sourceStepId is part of the key). Lets
 *  detectFixLoopOscillation spot a step re-raising the same complaint across rounds. */
export function fixLoopFingerprint(sourceStepId: string, diagnosis: string): string {
  return contentFingerprint(sourceStepId, diagnosis);
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

/** Does this loop-back name a defect at all?
 *
 *  Two shapes do not: an empty diagnosis, and a validator parse-miss, whose summary carries the
 *  `UNPARSEABLE` verdict and — by construction in buildFindingsSummary — no findings. The verdict
 *  is a typed `ValidationVerdict` member, not display copy, so keying on the token is stable while
 *  keying on the markdown around it would not be. 07b no longer records a parse miss as a
 *  loop-back at all, but rows written before that fix are still in `task_events` and this
 *  function reads the whole history, so the filter has to survive them too.
 *
 *  Fails SAFE: a real diagnosis that happened to contain the word is merely judged
 *  non-actionable, which only means the oscillation gate does not trip early — the round cap
 *  still escalates, and with the correct single diagnosis rather than a bogus pairing. */
function isActionableDiagnosis(raw: string): boolean {
  const d = cleanDiagnosis(raw);
  if (d.length === 0) return false;
  return !/\bUNPARSEABLE\b/.test(d);
}

/** The diagnosis already recorded for `round` — the machine failure the escalation gate was
 *  raised on. Read back so a user directive can carry it along as context instead of replacing
 *  it outright. Empty string when nothing is recorded for that round. */
export async function loadRecordedDiagnosisForRound(
  db: Database,
  taskId: string,
  round: number,
): Promise<string> {
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
  for (const r of rows) {
    const p = r.payload as { diagnosis?: string; round?: number } | null;
    if (p?.round === round) return (p.diagnosis ?? '').trim();
  }
  return '';
}

/** Compose the next round's diagnosis when the user typed a directive at the escalation gate.
 *  Their instruction leads — it is the arbitration between two things the loop could not
 *  reconcile — and the machine failure follows as context rather than being discarded, since
 *  the directive usually tells the agent how to satisfy it, not to ignore it. */
export function buildGateDirectiveDiagnosis(instruction: string, priorDiagnosis: string): string {
  const head = [
    'The developer reviewed this stuck fix loop and gave a direct instruction. It OVERRIDES any',
    'conflicting guidance — the spec, review findings, and the diagnosis below included. Where',
    'they disagree, follow this and say in your notes what you overrode:',
    '',
    instruction.trim(),
  ].join('\n');
  const tail = priorDiagnosis.trim();
  return tail.length > 0
    ? `${head}\n\n--- The failure that stopped the loop (context, not an override) ---\n${tail}`
    : head;
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

  // A DIFFERENT source looped back between that repeat and now (the alternation) AND actually
  // asked for something. A loop-back that names no defect cannot be the half of a deadlock that
  // "reverses" anything, and presenting it as one produces a gate that demands a decision while
  // showing the user nothing to decide on — one task was asked to arbitrate against
  // "_No issues found — nothing to fix._".
  const between = prior
    .filter(
      (p) =>
        p.sourceStepId !== sourceStepId &&
        (p.round ?? 0) > (repeat.round ?? 0) &&
        (p.round ?? 0) < nextRound &&
        isActionableDiagnosis(p.diagnosis ?? ''),
    )
    .sort((a, b) => (b.round ?? 0) - (a.round ?? 0));
  if (between.length === 0) return { tripped: false };

  return {
    tripped: true,
    conflictingDiagnoses: [diagnosis, between[0]?.diagnosis ?? ''],
    conflictingStepId: between[0]?.sourceStepId ?? 'another step',
  };
}

/** Source steps whose fix-loop diagnosis is a HUMAN reviewer's directive — their hands-on
 *  findings at Gate 2, or the findings they explicitly selected (plus instructions) at the
 *  adversarial-QA gate. These are authoritative and complete: the developer saw the problem in
 *  the running app and is directing the fix. NOT raw machine tool output to be filtered for "the
 *  real error". The implement fix prompt frames the two differently (see 07-phase-2-implement).
 *  08a-browser-verify is intentionally absent: it runs only in automated (mcp) mode, so its
 *  loop-backs are machine console/network dumps, not a person's observations. */
const HUMAN_REJECT_SOURCES = new Set([
  '09-gate-2-verify-approval',
  '08d2-adversarial-qa-review',
  // Text the user typed at the escalation gate. Same standing as a hands-on reject: they are
  // looking at both sides of a stuck loop and directing the fix.
  FIX_LOOP_GATE_SOURCE,
]);

/** The diagnosis the implementation step should fix on this round, with whether it came from a
 *  human reject gate (authoritative, every item required) vs a machine check. Null on the
 *  original pass (round 0) or when no recorded request matches the current round. */
export async function loadFixLoopDiagnosis(
  ctx: StepContext,
): Promise<{ diagnosis: string; humanSourced: boolean } | null> {
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
    const p = r.payload as { diagnosis?: string; round?: number; sourceStepId?: string } | null;
    if (p?.round === ctx.round) {
      const d = cleanDiagnosis((p.diagnosis ?? '').trim());
      if (d.length === 0) return null;
      return { diagnosis: d, humanSourced: HUMAN_REJECT_SOURCES.has(p.sourceStepId ?? '') };
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
  FIX_LOOP_GATE_SOURCE,
]);

/** Constraints that outrank an agent's opinion, most authoritative first: what the USER decided
 *  at the escalation gate, then what a guard or runtime actually MEASURED. Emitted ahead of the
 *  rest so that when the budget is tight the text surviving intact is the arbitration or the
 *  verified fact, never the opinion. A task lost twelve days to the inverse: a code-audit
 *  finding that contradicted 07c's DDEV build guard rode in at the top of this block (inside a
 *  gate-2 reject) while 07c's own constraint fell off the end of a single head-slice, so every
 *  later round was told to re-add the exact line the guard rejects. */
const PRIORITY_CONSTRAINT_SOURCES = [
  FIX_LOOP_GATE_SOURCE,
  '07c-ddev-reconcile',
  '08-phase-5-verify',
];

/** Whole-block target, and the room each surviving source is guaranteed. The floor WINS when
 *  the two conflict: a block a few hundred chars over target costs tokens, while a dropped
 *  source silently deletes a "do not revert this" that the implementation is currently shaped
 *  by — and deletes it invisibly, which is what made the failure above so hard to see. */
const HONORED_BLOCK_TARGET = 3000;
const HONORED_ENTRY_MIN = 400;

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
  // Priority sources first; everything else keeps its newest-first order (sort is stable, so
  // equal ranks do not reshuffle). Ordering matters only because the budget below can truncate.
  const rank = (src: string): number => {
    const i = PRIORITY_CONSTRAINT_SOURCES.indexOf(src);
    return i >= 0 ? i : PRIORITY_CONSTRAINT_SOURCES.length;
  };
  const ordered = [...latestPerSource.entries()]
    .filter(([, d]) => d.length > 0)
    .sort(([a], [b]) => rank(a) - rank(b));
  if (ordered.length === 0) return '';
  const header = [
    'HONORED CONSTRAINTS — the current code is shaped to satisfy these prior verification/',
    'runtime failures. They were DELIBERATE fixes, not defects. Do NOT recommend reverting them',
    'or flag them under Developer Experience / naming / style. In particular, the DDEV project',
    'name in .ddev/config.yaml is harness-owned and registered with the running environment —',
    'do not flag it. You MAY still flag genuine breakage (the code no longer works), but any fix',
    'you propose MUST preserve these constraints rather than undo them:',
  ].join('\n');
  // Budget PER ENTRY rather than head-slicing the joined block. One slice over the whole string
  // truncates by position, so a single long diagnosis evicts every source after it outright —
  // the block then reads as a complete list while silently missing constraints.
  const perEntry = Math.max(
    HONORED_ENTRY_MIN,
    Math.floor((HONORED_BLOCK_TARGET - header.length) / ordered.length),
  );
  const entries = ordered.map(([src, d]) => {
    const label = `- ${src}: `;
    const room = Math.max(HONORED_ENTRY_MIN, perEntry - label.length);
    // Head-slice: a constraint states its rule up front (cleanDiagnosis already kept the tail
    // of raw tool output, which is where those put their summary).
    return d.length > room ? `${label}${d.slice(0, room)}…` : `${label}${d}`;
  });
  return [header, ...entries].join('\n');
}

/** Background ledger for the implementation fix pass: what earlier fix rounds already
 *  changed, what the prior agents recorded as established/ruled out, and the defects
 *  earlier rounds were asked to fix. Each fix round is a fresh CLI process with no memory
 *  of prior rounds, so without this it re-derives the same discoveries (e.g. probing for a
 *  tool that is not in the sandbox). Returns '' on the original pass (round 0). Distinct
 *  from loadHonoredConstraints (a "do not revert" guard for the validator); this is
 *  "already done / already ruled out" context for the implementer. */
export async function loadPriorFixContext(ctx: StepContext): Promise<string> {
  if (ctx.round <= 0) return '';

  // What earlier rounds established, read from the task ledger rather than from
  // prior-round `task_steps.output`: _step-reset.ts nulls that column, so a task that
  // was reset once lost every prior finding here. task_events survive the reset.
  // Unchanged when no reset happened; strictly better after one.
  const findingLines: string[] = [];
  const changeLines: string[] = [];
  for (const e of await loadLedgerEntries(ctx.db, ctx.taskId)) {
    if (e.round >= ctx.round) continue;
    const line = `- round ${e.round} (${e.stepId}): ${e.text}`;
    if (e.kind === 'change') changeLines.push(line);
    else findingLines.push(line);
  }

  // Prior diagnoses (the defects earlier rounds were asked to fix), deduped by fingerprint
  // so a recurring complaint shows once. Earlier rounds only — the current round's defect
  // is shown separately via loadFixLoopDiagnosis.
  const evtRows = await ctx.db
    .select()
    .from(schema.taskEvents)
    .where(
      and(
        eq(schema.taskEvents.taskId, ctx.taskId),
        eq(schema.taskEvents.eventType, FIX_LOOP_REQUESTED),
      ),
    )
    .orderBy(desc(schema.taskEvents.createdAt));
  const seenFp = new Set<string>();
  const diagnosisLines: string[] = [];
  for (const r of evtRows) {
    const p = r.payload as {
      diagnosis?: string;
      sourceStepId?: string;
      round?: number;
      fingerprint?: string;
    } | null;
    if (!p || typeof p.round !== 'number' || p.round >= ctx.round) continue;
    const diag = cleanDiagnosis((p.diagnosis ?? '').trim());
    if (diag.length === 0) continue;
    const fp = p.fingerprint ?? fixLoopFingerprint(p.sourceStepId ?? '', p.diagnosis ?? '');
    if (seenFp.has(fp)) continue;
    seenFp.add(fp);
    const short = diag.length > 400 ? diag.slice(-400) : diag;
    diagnosisLines.push(`- ${p.sourceStepId ?? 'downstream'} (round ${p.round}): ${short}`);
  }

  if (changeLines.length === 0 && findingLines.length === 0 && diagnosisLines.length === 0) {
    return '';
  }

  const block = [
    'WHAT EARLIER FIX ROUNDS ALREADY DID / RULED OUT (background only — the current defect to',
    'fix is stated above; do not repeat this discovery work, build on it):',
    changeLines.length > 0 ? ['Changes already made:', ...changeLines].join('\n') : '',
    findingLines.length > 0
      ? ['Environment / investigation already established:', ...findingLines].join('\n')
      : '',
    diagnosisLines.length > 0
      ? ['Defects addressed in earlier rounds:', ...diagnosisLines].join('\n')
      : '',
  ]
    .filter((s) => s.length > 0)
    .join('\n\n');

  return block.length > 4000 ? block.slice(0, 4000) : block;
}
