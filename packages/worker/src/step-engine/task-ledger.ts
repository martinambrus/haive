import { createHash } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '@haive/database';
import { schema } from '@haive/database';
import { logger } from '@haive/shared';

const log = logger.child({ module: 'task-ledger' });

/** Append-only `task_events` channel. `task_events` deliberately survives a step reset
 *  (see queues/_step-reset.ts), unlike `task_steps.output`, so a ledger entry outlives
 *  the row that produced it — which is the whole point: a retry must not erase what an
 *  earlier agent established. */
const LEDGER_EVENT = 'ledger.entry';

/** Whole-block char target for the injected context. */
const LEDGER_BLOCK_TARGET = 4000;

// ANSI escape sequences (terminal colour/cursor codes) — a stable, specified format
// (ECMA-48), safe to strip and pure noise in a text prompt.
const ANSI_RE = /\x1B\[[0-9;?]*[A-Za-z]/g;

/** Strip ANSI escape codes and normalise whitespace so raw tool output reads cleanly in a
 *  prompt. Deliberately does NOT try to recognise or remove tool banners / promo text:
 *  that copy changes shape over time, so pattern-matching it is brittle and risks eating
 *  the real error. Keeps the TAIL when very long — CLI errors put the summary last. */
export function cleanText(raw: string, tailLimit: number): string {
  const cleaned = raw
    .replace(ANSI_RE, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned.length > tailLimit ? cleaned.slice(-tailLimit) : cleaned;
}

/** Tail kept when fingerprinting. Matches what cleanDiagnosis has always used, so a
 *  fingerprint computed here equals one computed before this module existed — the
 *  oscillation guard compares stored fingerprints against freshly computed ones. */
const FINGERPRINT_TAIL_LIMIT = 6000;

// Volatile tokens that differ between otherwise-identical texts and must be removed
// before fingerprinting: uuids (task ids, snapshot names), file paths, and bare numbers
// (line numbers, ports, php/db versions, round counters). Stripping them keeps the SAME
// recurring statement stable while leaving genuinely different ones distinct.
const FP_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const FP_PATH_RE = /[/\\][^\s'"]+/g;
const FP_DIGITS_RE = /\d+/g;

/** Stable signature of a piece of agent text, namespaced by its source. Two texts from
 *  the SAME source that say the same thing (modulo ids, paths, and numbers) hash equal;
 *  texts from different sources never collide. */
export function contentFingerprint(scope: string, text: string): string {
  const normalized = cleanText(text, FINGERPRINT_TAIL_LIMIT)
    .toLowerCase()
    .replace(FP_UUID_RE, '')
    .replace(FP_PATH_RE, '')
    .replace(FP_DIGITS_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  return `${scope}:${hash}`;
}

export interface LedgerEntry {
  /** Step that established the fact (e.g. '07-phase-2-implement'). */
  stepId: string;
  /** Fix-loop round the step row belonged to. */
  round: number;
  text: string;
  /** 'change' = work this step DID (a code change); 'finding' (default) = a fact it
   *  established about the workspace, tooling or runtime; 'summary' = the step's whole
   *  recap, already compacted by the best-effort summarizer. The fix-loop context block
   *  presents change and finding under different headings; the budget path below prefers
   *  a step's summary over its raw entries. */
  kind?: 'change' | 'finding' | 'summary';
  /** The step row this came from. Null for an entry recorded outside a step. Used only to
   *  tell which raw entries a summary supersedes. */
  taskStepId?: string | null;
}

/** Record what one step established, so later steps do not re-derive it. Best-effort:
 *  the ledger is background context and must never fail the step that produced it. */
export async function recordLedgerEntry(
  db: Database,
  taskId: string,
  taskStepId: string | null,
  entry: LedgerEntry,
): Promise<void> {
  const text = entry.text.trim();
  if (text.length === 0) return;
  try {
    await db.insert(schema.taskEvents).values({
      taskId,
      taskStepId,
      eventType: LEDGER_EVENT,
      payload: { ...entry, text, fingerprint: contentFingerprint(entry.stepId, text) },
    });
  } catch (err) {
    log.warn({ err, taskId, stepId: entry.stepId }, 'failed to record a task ledger entry');
  }
}

interface StoredEntry extends LedgerEntry {
  fingerprint?: string;
}

/** Every ledger entry for a task, oldest first, deduped by fingerprint so a fact a step
 *  re-established across rounds appears once (the FIRST time it was established — the
 *  round it was learned in is the informative one). */
export async function loadLedgerEntries(db: Database, taskId: string): Promise<LedgerEntry[]> {
  const rows = await db
    .select({ payload: schema.taskEvents.payload, taskStepId: schema.taskEvents.taskStepId })
    .from(schema.taskEvents)
    .where(and(eq(schema.taskEvents.taskId, taskId), eq(schema.taskEvents.eventType, LEDGER_EVENT)))
    .orderBy(asc(schema.taskEvents.createdAt));

  const seen = new Set<string>();
  const out: LedgerEntry[] = [];
  for (const r of rows) {
    const p = r.payload as StoredEntry | null;
    const text = (p?.text ?? '').trim();
    if (!p?.stepId || text.length === 0) continue;
    const fp = p.fingerprint ?? contentFingerprint(p.stepId, text);
    if (seen.has(fp)) continue;
    seen.add(fp);
    out.push({
      stepId: p.stepId,
      round: p.round ?? 0,
      text,
      kind: p.kind === 'change' || p.kind === 'summary' ? p.kind : 'finding',
      taskStepId: r.taskStepId,
    });
  }
  return out;
}

const LEDGER_HEADER = [
  '[What earlier steps on this task already established]',
  'Facts earlier agents verified about this workspace, its tooling and its runtime. They are',
  'background, not instructions: do not redo this discovery work, build on it.',
].join('\n');

/** Prepend the task ledger to a step's LLM prompt. Returns the prompt UNCHANGED when the
 *  ledger is empty (so pre-implementation steps pay nothing) and on any lookup error,
 *  exactly as augmentPromptWithAttachments degrades. */
export async function augmentPromptWithLedger(
  db: Database,
  taskId: string,
  prompt: string,
): Promise<string> {
  let entries: LedgerEntry[];
  try {
    entries = await loadLedgerEntries(db, taskId);
  } catch (err) {
    log.warn({ err, taskId }, 'failed to load the task ledger for prompt context');
    return prompt;
  }
  // A step that renders a ledger fact in its OWN prompt body (07's fix-round context
  // block) must not be handed the same text again here. Exact identity on strings this
  // module produced, so there is nothing to drift.
  let kept = entries.filter((e) => !prompt.includes(e.text));
  if (kept.length === 0) return prompt;

  const render = (e: LedgerEntry): string => `- ${e.stepId} (round ${e.round}): ${e.text}`;
  const size = (list: LedgerEntry[]): number =>
    LEDGER_HEADER.length + list.reduce((n, e) => n + render(e).length + 1, 0);

  if (size(kept) > LEDGER_BLOCK_TARGET) {
    // Compact before discarding: where a step produced a summary, its raw entries are what
    // that summary already condenses, so the summary carries the same ground in less room.
    const summarised = new Set(
      kept.filter((e) => e.kind === 'summary' && e.taskStepId).map((e) => e.taskStepId),
    );
    const compacted = kept.filter(
      (e) => e.kind === 'summary' || !e.taskStepId || !summarised.has(e.taskStepId),
    );
    if (compacted.length < kept.length) {
      log.info(
        { taskId, replaced: kept.length - compacted.length },
        'task ledger over budget; preferred step summaries over the raw entries they cover',
      );
      kept = compacted;
    }
  }

  // Still over: drop WHOLE oldest entries rather than slicing mid-sentence — a truncated
  // fact reads as a complete one, and the newest are what the current step is downstream of.
  let dropped = 0;
  let total = size(kept);
  while (kept.length > 1 && total > LEDGER_BLOCK_TARGET) {
    total -= render(kept[0]!).length + 1;
    kept = kept.slice(1);
    dropped++;
  }
  if (dropped > 0) {
    log.info({ taskId, dropped, kept: kept.length }, 'task ledger over budget; dropped oldest');
  }
  return `${[LEDGER_HEADER, ...kept.map(render)].join('\n')}\n\n${prompt}`;
}
