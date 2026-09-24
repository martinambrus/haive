import {
  chmodNoFollow,
  chownNoFollow,
  lstatNoFollow,
  removeNoFollow,
  writeFileNoFollow,
} from '@haive/shared/fs-safe';
import { PLAN_INPUTS_INDEX_NAME, splitAttachmentStoredPath, taskUploadsRel } from '@haive/shared';
import path from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import { schema, withTaskAttachmentsLock } from '@haive/database';
import { ensureArchivesExpanded } from '../../../attachments/expand-archives.js';
import { SANDBOX_WORKDIR } from '../../../sandbox/sandbox-runner.js';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { isSingleLine, safeNote } from '../_untrusted-repo.js';
import {
  classifyPlanInput,
  extractPlanInput,
  needsExtraction,
  sidecarName,
  uploadsInputRel,
  type PlanInputKind,
} from './_plan-inputs.js';

/**
 * Verify and normalise a plan build's inputs, before anything is spent.
 *
 * A plan build can be handed a brief, a Word requirements document, a
 * spreadsheet, a PDF and a wireframe at once. Three things then have to be true
 * before the first agent runs, and none of them was:
 *
 *  - every attachment row actually has its file on disk. A build that decomposes
 *    a document that is not there produces a plausible plan of the wrong project.
 *  - every binary document has a readable form. The sandbox mounts the originals,
 *    but a `.docx` is a zip an agent cannot usefully open, and the coverage check
 *    downstream needs text it can scan.
 *  - a greenfield build has SOMETHING to decompose. With no brief and no files,
 *    dispatching spends a CLI invocation inventing a project nobody described.
 *
 * Deterministic, no form, no CLI. It writes sidecars beside the originals and an
 * index (`_PLAN_INPUTS.md`) naming which is which; the originals are never
 * touched and stay listed in the task's Attachments tab.
 *
 * The uploads dir is the same one the sandbox already binds read-only
 * (`resolveTaskUploadsMount`), so a sidecar written here needs no new mount — but
 * it does need the ownership dance the api does, because the worker runs as root
 * and the sandbox user is uid 1000.
 */

const NODE_UID = 1000;
const NODE_GID = 1000;
export const PLAN_INPUTS_INDEX = PLAN_INPUTS_INDEX_NAME;

/** Documents given an extracted text sidecar. Each one is a subprocess
 *  (`pdftotext`, `unzip`), which is fine for the handful this step was built for
 *  and is not fine for an attached folder of 300 PDFs. Past the cap the original
 *  is still mounted and the index says plainly that no text was pulled from it. */
const PLAN_INPUT_EXTRACTION_LIMIT = 50;

export interface PlanInputRow {
  filename: string;
  kind: PlanInputKind;
  bytes: number;
  description: string | null;
  /** Sidecar basename, when this kind is only readable through one. */
  sidecar: string | null;
  /** Set when this document WOULD have been extracted but the step had already
   *  spent its extraction budget. Distinct from `hasText: false`, which is a
   *  finding about the document: this one means nobody looked, and a vision
   *  requirement must not be inferred from it. */
  extractionSkipped?: boolean;
  /** Whether this input has ANY readable text — the original for a text kind, a
   *  non-empty sidecar for a binary document, and never for an image.
   *
   *  Structural, deliberately not inferred from `note`: `note` is display copy,
   *  and the vision requirement below turns on this. A rewording of a message
   *  must not be able to change whether a wireframe reaches a model that can see
   *  it. */
  hasText: boolean;
  /** Why the sidecar is missing or empty. Display copy only — nothing branches on
   *  it. Null when there is nothing to say. */
  note: string | null;
  /** The attachment row this was prepared from. A file deleted and re-uploaded under the same
   *  name is a different document, which nothing extracted, so a later reader matches by this.
   *  Optional: a row recorded before it existed is matched by name. */
  id?: string;
}

export interface PlanInputsDetect {
  /** Whether this task is a greenfield build; only that mode requires an input. */
  greenfield: boolean;
  briefLength: number;
  uploadsDir: string | null;
  attachments: {
    /** The row, for the checks made under the attachments lock. Optional: a detect payload
     *  persisted before it was recorded has none, and is checked by filename instead. */
    id?: string;
    filename: string;
    storedPath: string;
    contentType: string | null;
    description: string | null;
  }[];
  /** Rows whose file is not on disk. Non-empty fails the step. */
  missing: string[];
  /** Archives that expanded to less than they hold, or not at all. Reported to
   *  the user; never fatal, because the archive itself is still mounted.
   *  Optional: a step parked before this field existed replays a detect payload
   *  that has no such key. */
  archiveNotes?: { filename: string; note: string }[];
}

export interface PlanInputsApply {
  inputs: PlanInputRow[];
  extracted: number;
  unreadable: string[];
  hasImageInputs: boolean;
  hasPdfInputs: boolean;
  /** Inputs whose only readable form is VISUAL: a document that needed extraction
   *  and yielded no usable text. A wireframe PDF is the ordinary case — it is
   *  large because of its pictures, and `pdftotext` finds a handful of labels or
   *  nothing at all. Tracked separately from `hasPdfInputs` because the two ask
   *  for different things: a PDF with text is a preference (a blind model can
   *  still read the sidecar), a PDF without any is a REQUIREMENT, since there is
   *  no fallback left and a model that cannot see it would plan around it. */
  visualOnly: string[];
  /** Sandbox path of the index, or null when there were no attachments. */
  indexPath: string | null;
  /** Archives that could not be fully expanded, carried through so the step's
   *  output records it and the index can say so. */
  archiveNotes: { filename: string; note: string }[];
}

/** The row an input was read from: by id, and by name only for a detect payload persisted before
 *  ids were recorded. */
function attachmentRow(taskId: string, a: { id?: string; filename: string }) {
  return a.id
    ? eq(schema.taskAttachments.id, a.id)
    : and(
        eq(schema.taskAttachments.taskId, taskId),
        eq(schema.taskAttachments.filename, a.filename),
      );
}

/** Whether an attachment whose file is not on disk is still on the task, asked under the task's
 *  attachments lock. A delete removes the files before the rows, both inside one section under that
 *  lock, so a file found gone outside it can belong to a row that is about to go — and a deleted
 *  attachment is not a missing one. A row still there once the lock is held really has lost its
 *  file. A lookup that fails answers yes, which is what the step concluded before it asked. */
async function stillAttachedUnderLock(
  ctx: StepContext,
  a: { id?: string; filename: string },
): Promise<boolean> {
  try {
    return await withTaskAttachmentsLock(ctx.db, ctx.taskId, async (tx) => {
      const row = await tx.query.taskAttachments.findFirst({
        where: attachmentRow(ctx.taskId, a),
        columns: { id: true },
      });
      return row !== undefined;
    });
  } catch (err) {
    ctx.logger.warn({ err, file: a.filename }, 'plan inputs: could not recheck an attachment');
    return true;
  }
}

type SidecarOutcome = 'stored' | 'deleted' | 'refused';

/**
 * Store a document's extracted text beside it, under the task's attachments lock and only while its
 * row is still there. A delete removes the sidecar path together with the rows in one section under
 * the same lock, so the two cannot interleave: whichever holds the lock second sees what the first
 * did, and the text never outlives its document.
 *
 * `refused` covers everything that left no text stored: something that is not a file stands at the
 * name, the lock could not be had in time, or the section failed. A section can fail AFTER the write
 * landed (a connection lost at COMMIT); the text is then taken back, so what is on disk agrees with
 * the note the step reports.
 */
async function storeSidecar(
  ctx: StepContext,
  attachment: { id?: string; filename: string },
  sidecarRel: string,
  body: string,
): Promise<SidecarOutcome> {
  let write = null as Promise<boolean> | null;
  try {
    return await withTaskAttachmentsLock<SidecarOutcome>(ctx.db, ctx.taskId, async (tx) => {
      const row = await tx.query.taskAttachments.findFirst({
        where: attachmentRow(ctx.taskId, attachment),
        columns: { id: true },
      });
      if (row === undefined) return 'deleted';
      // Ownership stays with `harmonizeOwnership`, which catches: it is best-effort here, and
      // passing it to the primitive would make a non-root worker fail the whole step.
      write = writeFileNoFollow(ctx.repoPath, sidecarRel, body, {
        fileMode: 0o644,
        replaceLeafLink: true,
      }).then(
        () => true,
        (err: unknown) => {
          ctx.logger.warn(
            { err, file: attachment.filename },
            'plan inputs: could not store the extracted text',
          );
          return false;
        },
      );
      return (await write) ? 'stored' : 'refused';
    });
  } catch (err) {
    ctx.logger.warn(
      { err, file: attachment.filename },
      'plan inputs: could not store the extracted text',
    );
    if (write !== null && (await write)) {
      await removeNoFollow(ctx.repoPath, sidecarRel).catch(() => {});
    }
    return 'refused';
  }
}

/** Best-effort: the api chowns what it writes for the same reason, and a failure
 *  there is non-fatal because 0644 is world-readable anyway. */
async function harmonizeOwnership(anchor: string, rel: string): Promise<void> {
  await chownNoFollow(anchor, rel, { uid: NODE_UID, gid: NODE_GID }).catch(() => {});
  await chmodNoFollow(anchor, rel, 0o644).catch(() => {});
}

/** What preparing one attachment came to. `missing` is a row whose file is gone while the row is
 *  still there; `deleted` is one removed while it was being prepared, which is no input at all. */
export type PreparedPlanInput =
  | { status: 'prepared'; row: PlanInputRow; extracted: boolean; unreadable: boolean }
  | { status: 'missing' }
  | { status: 'deleted' };

/** Prepare one attachment: its kind and size and, for a document no CLI can open, a sidecar of its
 *  text. `canExtract` is false once the extraction budget is spent. Shared by this step's apply and
 *  by a build's dispatch, which prepares what was attached since. */
export async function preparePlanInput(
  ctx: StepContext,
  attachment: {
    id?: string;
    filename: string;
    storedPath: string;
    contentType: string | null;
    description: string | null;
  },
  canExtract: boolean,
): Promise<PreparedPlanInput> {
  const kind = classifyPlanInput(attachment.filename, attachment.contentType);
  const split = splitAttachmentStoredPath(attachment, ctx.taskId);
  const info = split === null ? null : await lstatNoFollow(split.anchor, split.rel);
  if (info === null || info.kind !== 'file') {
    return (await stillAttachedUnderLock(ctx, attachment))
      ? { status: 'missing' }
      : { status: 'deleted' };
  }
  const row: PlanInputRow = {
    id: attachment.id,
    filename: attachment.filename,
    kind,
    bytes: info.stats.size,
    description: attachment.description,
    sidecar: null,
    // A text kind is readable as it stands; everything else has to earn it.
    hasText: kind === 'text',
    note: null,
  };
  if (!needsExtraction(kind))
    return { status: 'prepared', row, extracted: false, unreadable: false };
  if (!canExtract) {
    row.extractionSkipped = true;
    row.note = `not extracted: this plan already has ${PLAN_INPUT_EXTRACTION_LIMIT} extracted documents`;
    return { status: 'prepared', row, extracted: false, unreadable: false };
  }
  await ctx.emitProgress(`Extracting text from ${attachment.filename}...`);
  // Still the absolute path: the extractors are `unzip`/`pdftotext` subprocesses,
  // which resolve a path of their own by name, so containing them is a separate
  // change from anchoring this module's own reads.
  const result = await extractPlanInput(kind, attachment.storedPath);
  if (result.error) {
    // Reported, not thrown. The original is still mounted, so an agent that
    // can open it is not blocked by our inability to read it.
    row.note = `could not be extracted: ${result.error}`;
    ctx.logger.warn(
      { file: attachment.filename, kind, err: result.error },
      'plan input extraction failed',
    );
    return { status: 'prepared', row, extracted: false, unreadable: true };
  }
  const name = sidecarName(attachment.filename);
  // The name is a DATABASE column, so it becomes a rel walked under the repository
  // root a component at a time rather than a path joined onto the uploads dir and
  // checked afterwards. A name that cannot address a file inside it is a per-item
  // skip, like an extraction that failed: one bad row must not discard the sidecars
  // written beside it.
  const sidecarRel = uploadsInputRel(ctx.taskId, name);
  if (sidecarRel === null) {
    row.note = `extracted text could not be stored: "${name}" does not name a file inside the uploads directory`;
    ctx.logger.warn(
      { file: attachment.filename, sidecar: name },
      'plan inputs: refusing a sidecar name that leaves the uploads directory',
    );
    return { status: 'prepared', row, extracted: false, unreadable: true };
  }
  const body =
    result.markdown.length > 0
      ? `# ${attachment.filename}\n\n${result.markdown}\n`
      : `# ${attachment.filename}\n\n_(no text could be read from this file)_\n`;
  const outcome = await storeSidecar(ctx, attachment, sidecarRel, body);
  // Deleted while it was being extracted: it is no longer an input at all.
  if (outcome === 'deleted') return { status: 'deleted' };
  // A refused write is a per-item skip, like an extraction that failed: the original is
  // still mounted, and one bad name must not discard the sidecars written beside it.
  if (outcome === 'refused') {
    row.note = 'extracted text could not be stored beside it';
    return { status: 'prepared', row, extracted: false, unreadable: true };
  }
  await harmonizeOwnership(ctx.repoPath, sidecarRel);
  row.sidecar = name;
  // The extractor's own verdict on its INPUT, never a test on the string
  // it rendered — that string carries page rules and sheet headings this
  // module added, and a document that says nothing still produces them.
  row.hasText = result.hasContent;
  // An empty extraction is a fact about the DOCUMENT, not a failure of
  // the extractor, and the two must not read the same downstream.
  if (!row.hasText) row.note = 'contains no readable text';
  return { status: 'prepared', row, extracted: true, unreadable: false };
}

/** Needed extraction and got nothing usable out of it — either the extractor failed or the document
 *  genuinely carries no text. Both leave the file readable only by looking at it.
 *  `extractionSkipped` is excluded on purpose. Visual-only is a HARD vision requirement on the
 *  dispatch, and it must rest on a measurement: "the extractor found no text" is one, "the extractor
 *  never ran" is not. */
function isVisualOnly(input: PlanInputRow): boolean {
  return needsExtraction(input.kind) && !input.hasText && !input.extractionSkipped;
}

/** Write the index for these inputs and return the path an agent sees it at. Rewritten at a build's
 *  dispatch too, once what is attached has changed. A link planted at the name is replaced as a link:
 *  no attachment may hold that name, so whatever stands there is not a person's file, and refusing it
 *  would fail every later write. */
async function writePlanInputsIndex(
  repoPath: string,
  taskId: string,
  inputs: PlanInputRow[],
  archiveNotes: { filename: string; note: string }[],
): Promise<string> {
  const indexRel = `${taskUploadsRel(taskId)}/${PLAN_INPUTS_INDEX}`;
  await writeFileNoFollow(repoPath, indexRel, renderIndex(taskId, inputs, archiveNotes), {
    fileMode: 0o644,
    replaceLeafLink: true,
  });
  await harmonizeOwnership(repoPath, indexRel);
  return `${SANDBOX_WORKDIR}/.haive/task-uploads/${taskId}/${PLAN_INPUTS_INDEX}`;
}

/** Remove the index, once nothing it would list is still attached. */
async function removePlanInputsIndex(repoPath: string, taskId: string): Promise<void> {
  await removeNoFollow(repoPath, `${taskUploadsRel(taskId)}/${PLAN_INPUTS_INDEX}`).catch(() => {});
}

/** This step's row and what it recorded, or null when it did not run for the task (the onboarding
 *  wrapper registers no such step). Never throws: a build must not fail because the lookup did. */
async function loadPlanInputsRow(
  ctx: StepContext,
): Promise<{ id: string; output: PlanInputsApply } | null> {
  try {
    const [row] = await ctx.db
      .select({ id: schema.taskSteps.id, output: schema.taskSteps.output })
      .from(schema.taskSteps)
      .where(
        and(eq(schema.taskSteps.taskId, ctx.taskId), eq(schema.taskSteps.stepId, '00-plan-inputs')),
      )
      .limit(1);
    return row?.output ? { id: row.id, output: row.output as PlanInputsApply } : null;
  } catch (err) {
    ctx.logger.warn({ err }, 'could not read prepared plan inputs');
    return null;
  }
}

/** What this step recorded, or null when it did not run for the task. */
export async function loadPlanInputsOutput(ctx: StepContext): Promise<PlanInputsApply | null> {
  return (await loadPlanInputsRow(ctx))?.output ?? null;
}

export interface LiveAttachmentRow {
  id: string;
  filename: string;
  contentType: string | null;
  storedPath: string;
  description: string | null;
  expandedAt: Date | null;
  expansionNote: string | null;
}

/** What is attached to the task right now: the rows, their ids, and the names they carry. */
export interface LiveAttachments {
  rows: readonly LiveAttachmentRow[];
  ids: ReadonlySet<string>;
  names: ReadonlySet<string>;
}

/** The task's attachments as they stand, or null when they cannot be read. An archive attached late
 *  is expanded first, so what a dispatch requires is chosen from its members — a wireframe inside a
 *  `.zip` — and not from one opaque `binary` file. */
export async function loadLiveAttachments(ctx: StepContext): Promise<LiveAttachments | null> {
  await ensureArchivesExpanded(ctx.db, ctx.taskId);
  try {
    const rows = await ctx.db
      .select({
        id: schema.taskAttachments.id,
        filename: schema.taskAttachments.filename,
        contentType: schema.taskAttachments.contentType,
        storedPath: schema.taskAttachments.storedPath,
        description: schema.taskAttachments.description,
        expandedAt: schema.taskAttachments.expandedAt,
        expansionNote: schema.taskAttachments.expansionNote,
      })
      .from(schema.taskAttachments)
      .where(eq(schema.taskAttachments.taskId, ctx.taskId))
      .orderBy(asc(schema.taskAttachments.createdAt));
    return {
      rows,
      ids: new Set(rows.map((r) => r.id)),
      names: new Set(rows.map((r) => r.filename)),
    };
  } catch (err) {
    ctx.logger.warn({ err }, 'plan inputs: could not read the task attachments');
    return null;
  }
}

/** Whether a recorded input is still attached: by ROW, since a same-named replacement is a
 *  different document, and by name only for a row recorded before ids were. */
export function stillAttachedInput(
  input: { id?: string; filename: string },
  live: Pick<LiveAttachments, 'ids' | 'names'>,
): boolean {
  return input.id ? live.ids.has(input.id) : live.names.has(input.filename);
}

/** Live attachments no recorded input accounts for: attached after this step ran, or re-uploaded
 *  under a recorded name. Nothing prepared them, yet the attachments notice lists every live row,
 *  so a dispatch still has to account for what they are. */
function unpreparedAttachments(
  prepared: PlanInputsApply,
  live: LiveAttachments,
): LiveAttachmentRow[] {
  const ids = new Set(prepared.inputs.flatMap((i) => (i.id ? [i.id] : [])));
  const legacyNames = new Set(prepared.inputs.filter((i) => !i.id).map((i) => i.filename));
  return live.rows.filter((r) => !ids.has(r.id) && !legacyNames.has(r.filename));
}

/** What this step recorded, less any attachment deleted since. Membership is the only thing that
 *  changes: a verdict stays as it was measured (a document that yielded no text stays visual-only),
 *  and a file attached after this step ran is not added, since nothing extracted it. The two
 *  kind flags are recomputed from what remains. */
export function livePlanInputs(
  prepared: PlanInputsApply,
  live: Pick<LiveAttachments, 'ids' | 'names'>,
): { output: PlanInputsApply; changed: boolean } {
  const visualOnlyBefore = prepared.visualOnly ?? [];
  const archiveNotesBefore = prepared.archiveNotes ?? [];
  const inputs = prepared.inputs.filter((i) => stillAttachedInput(i, live));
  // The lists below name inputs, so they follow the rows that were kept rather than the live
  // names, which a same-named replacement would still carry.
  const kept = new Set(inputs.map((i) => i.filename));
  const visualOnly = visualOnlyBefore.filter((f) => kept.has(f));
  const unreadable = prepared.unreadable.filter((f) => kept.has(f));
  const archiveNotes = archiveNotesBefore.filter((n) => kept.has(n.filename));
  const changed =
    inputs.length !== prepared.inputs.length ||
    visualOnly.length !== visualOnlyBefore.length ||
    unreadable.length !== prepared.unreadable.length ||
    archiveNotes.length !== archiveNotesBefore.length;
  if (!changed) return { output: prepared, changed: false };
  return {
    changed: true,
    output: {
      ...prepared,
      inputs,
      visualOnly,
      unreadable,
      archiveNotes,
      hasImageInputs: inputs.some((i) => i.kind === 'image'),
      hasPdfInputs: inputs.some((i) => i.kind === 'pdf'),
    },
  };
}

/** The plan inputs as they stand now, and the attachments nothing could prepare. */
export interface CurrentPlanInputs {
  output: PlanInputsApply;
  /** Live attachments whose file could not be read, so only their kind counts. */
  unprepared: LiveAttachmentRow[];
}

/**
 * What this step recorded, brought up to what is attached NOW. An attachment deleted since is dropped
 * by row, with every verdict it carried; one attached since is prepared exactly as this step would
 * have prepared it, within the same extraction budget, and the note of an archive expanded since is
 * added. When anything changed the index is rewritten, or removed once nothing is left, and the result
 * is recorded over the output it was computed from, so the next dispatch neither extracts the same
 * document again nor loses what it found.
 *
 * Null when this step did not run for the task or the attachments cannot be read, which leaves a build
 * on the fields it had. `attachments` is a snapshot the caller already read; without one this reads
 * its own.
 */
export async function currentPlanInputs(
  ctx: StepContext,
  attachments?: LiveAttachments | null,
): Promise<CurrentPlanInputs | null> {
  const recorded = await loadPlanInputsRow(ctx);
  if (!recorded) return null;
  const live = attachments === undefined ? await loadLiveAttachments(ctx) : attachments;
  if (!live) return null;

  const pruned = livePlanInputs(recorded.output, live);
  let changed = pruned.changed;
  const inputs = [...pruned.output.inputs];
  const unreadable = [...pruned.output.unreadable];
  const visualOnly = [...(pruned.output.visualOnly ?? [])];
  const archiveNotes = [...(pruned.output.archiveNotes ?? [])];
  let extracted = pruned.output.extracted;
  const unprepared: LiveAttachmentRow[] = [];
  for (const attachment of unpreparedAttachments(recorded.output, live)) {
    const prepared = await preparePlanInput(
      ctx,
      attachment,
      extracted < PLAN_INPUT_EXTRACTION_LIMIT,
    );
    if (prepared.status === 'deleted') continue;
    if (prepared.status === 'missing') {
      unprepared.push(attachment);
      continue;
    }
    changed = true;
    inputs.push(prepared.row);
    if (prepared.extracted) extracted += 1;
    if (prepared.unreadable) unreadable.push(attachment.filename);
    if (isVisualOnly(prepared.row)) visualOnly.push(attachment.filename);
  }
  // Only for an archive that is an input: the notes follow the inputs, and `livePlanInputs` drops
  // any other, so adding one here would rewrite the index on every dispatch.
  const ids = new Set(inputs.flatMap((i) => (i.id ? [i.id] : [])));
  const noted = new Set(archiveNotes.map((n) => n.filename));
  for (const row of live.rows) {
    if (row.expandedAt === null || !row.expansionNote) continue;
    if (!ids.has(row.id) || noted.has(row.filename)) continue;
    archiveNotes.push({ filename: row.filename, note: row.expansionNote });
    changed = true;
  }
  if (!changed) return { output: recorded.output, unprepared };

  const output: PlanInputsApply = {
    ...pruned.output,
    inputs,
    extracted,
    unreadable,
    visualOnly,
    archiveNotes,
    hasImageInputs: inputs.some((i) => i.kind === 'image'),
    hasPdfInputs: inputs.some((i) => i.kind === 'pdf'),
    indexPath: await rewritePlanInputsIndex(ctx, inputs, archiveNotes),
  };
  await recordPlanInputs(ctx, recorded, output);
  return { output, unprepared };
}

/** Rewrite the index for these inputs, or remove it once there are none, and answer the path a prompt
 *  may name. A write that fails answers null, since the file on disk no longer lists what is attached. */
async function rewritePlanInputsIndex(
  ctx: StepContext,
  inputs: PlanInputRow[],
  archiveNotes: { filename: string; note: string }[],
): Promise<string | null> {
  try {
    if (inputs.length > 0) {
      return await writePlanInputsIndex(ctx.repoPath, ctx.taskId, inputs, archiveNotes);
    }
    await removePlanInputsIndex(ctx.repoPath, ctx.taskId);
    return null;
  } catch (err) {
    ctx.logger.warn({ err }, 'plan inputs: could not rewrite the index');
    return null;
  }
}

/** Record `next` only over the output it was computed from. A retry of this step resets that output,
 *  and what the retry writes is newer than anything computed here, so the write then matches nothing. */
async function recordPlanInputs(
  ctx: StepContext,
  recorded: { id: string; output: PlanInputsApply },
  next: PlanInputsApply,
): Promise<void> {
  try {
    await ctx.db
      .update(schema.taskSteps)
      .set({ output: next })
      .where(
        and(eq(schema.taskSteps.id, recorded.id), eq(schema.taskSteps.output, recorded.output)),
      );
  } catch (err) {
    ctx.logger.warn({ err }, 'plan inputs: could not record the inputs attached since');
  }
}

/** The index the greenfield root prompt tells its agent to read FIRST, so every value it names is
 *  held to the prompt-line rule here, at render time — a stored note from before this rule
 *  existed is reduced too. Notes are prose built around archive member names and extractor
 *  errors, so they are collapsed and capped; an archive name that cannot be a single line is left
 *  out rather than rewritten, since the agent has to be able to find that file. */
export function renderIndex(
  taskId: string,
  rows: PlanInputRow[],
  archiveNotes: { filename: string; note: string }[],
): string {
  const dir = `${SANDBOX_WORKDIR}/.haive/task-uploads/${taskId}`;
  const lines = [
    '# Plan inputs',
    '',
    'Everything the user attached for this plan, and where to read it.',
    `All paths are under \`${dir}/\`.`,
    '',
    '| File | Kind | Read this |',
    '| --- | --- | --- |',
  ];
  for (const row of rows) {
    const read = row.extractionSkipped
      ? `\`${row.filename}\` — not converted to text (limit reached); OPEN THE FILE ITSELF`
      : // No text came out of it, so the file itself is the only copy of what it
        // says. Told plainly, because "open it if you like" reads as optional.
        needsExtraction(row.kind) && !row.hasText
        ? `\`${row.filename}\` — no text could be read from it; OPEN THE FILE ITSELF`
        : row.sidecar && row.kind === 'pdf'
          ? `\`${row.filename}\` directly if you can read PDFs, otherwise \`${row.sidecar}\``
          : row.sidecar
            ? `\`${row.sidecar}\` (extracted text)`
            : row.kind === 'image'
              ? `\`${row.filename}\` — open the image itself`
              : `\`${row.filename}\``;
    lines.push(`| \`${row.filename}\` | ${row.kind} | ${read} |`);
  }
  lines.push('');
  for (const row of rows) {
    if (!row.description && !row.note) continue;
    lines.push(
      `- \`${row.filename}\`${row.description ? ` — ${row.description}` : ''}${
        row.note ? ` _(${safeNote(row.note)})_` : ''
      }`,
    );
  }
  const shownNotes = archiveNotes.filter((n) => isSingleLine(n.filename));
  if (shownNotes.length > 0) {
    lines.push(
      '',
      'Some attached archives were not fully expanded. What they contain is NOT in the',
      'list above; treat the plan as missing whatever they hold and say so.',
      ...shownNotes.map((n) => `- \`${n.filename}\` — ${safeNote(n.note)}`),
    );
  }
  const visual = rows.filter((r) => r.kind === 'image' || isVisualOnly(r));
  if (visual.length > 0) {
    lines.push(
      '',
      `${visual.length} input(s) can only be understood by LOOKING at them: ${visual
        .map((r) => `\`${r.filename}\``)
        .join(', ')}.`,
      'They are part of the specification, not decoration: open them and decompose what they',
      'show. If you cannot read one, stop and say so rather than planning around it.',
    );
  }
  lines.push('');
  return lines.join('\n');
}

export const planInputsStep: StepDefinition<PlanInputsDetect, PlanInputsApply> = {
  metadata: {
    // Negative because `01-plan-build` shipped at index 0 and `02-plan-coverage`
    // at 1. Renumbering those would strand every in-flight row, and the registry
    // only ever sorts on this value.
    id: '00-plan-inputs',
    workflowType: 'plan_build',
    index: -1,
    title: 'Prepare the inputs',
    description:
      'Verifies every attached file and writes a readable form of the ones no CLI can open directly, plus an index the plan agents read first.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<PlanInputsDetect> {
    const [task] = await ctx.db
      .select({
        description: schema.tasks.description,
        metadata: schema.tasks.metadata,
        repositoryId: schema.tasks.repositoryId,
      })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, ctx.taskId))
      .limit(1);

    const meta = (task?.metadata ?? {}) as { planBuildMode?: string };
    // Before the rows are read, not after: an archive the user attached has to
    // already be the tree it contains, or every file inside it is invisible to
    // the classification, the sidecars and the coverage scan below.
    const expansion = await ensureArchivesExpanded(ctx.db, ctx.taskId);
    if (expansion.filesAdded > 0) {
      await ctx.emitProgress(
        `Expanded ${expansion.expanded} archive(s) into ${expansion.filesAdded} file(s).`,
      );
    }
    const rows = await ctx.db
      .select({
        id: schema.taskAttachments.id,
        filename: schema.taskAttachments.filename,
        storedPath: schema.taskAttachments.storedPath,
        contentType: schema.taskAttachments.contentType,
        description: schema.taskAttachments.description,
        expandedAt: schema.taskAttachments.expandedAt,
        expansionNote: schema.taskAttachments.expansionNote,
      })
      .from(schema.taskAttachments)
      .where(eq(schema.taskAttachments.taskId, ctx.taskId))
      .orderBy(asc(schema.taskAttachments.createdAt));

    // From the column, not only from this call: the call reports just the archives IT expanded, so
    // a retry — which runs after the expansion was stamped — would rewrite the index without them.
    // This call's own notes are still merged in, for an archive whose stamp failed to land.
    const archiveNotes = rows
      .filter((r) => r.expandedAt !== null && Boolean(r.expansionNote))
      .map((r) => ({ filename: r.filename, note: r.expansionNote as string }));
    for (const n of expansion.notes) {
      if (!archiveNotes.some((a) => a.filename === n.filename)) archiveNotes.push(n);
    }

    await ctx.emitProgress(
      rows.length === 0 ? 'No attached files.' : `Checking ${rows.length} attached file(s)...`,
    );

    const missing: string[] = [];
    const deleted = new Set<string>();
    for (const row of rows) {
      // The repository root is RECOVERED from the row rather than trusted: the stored
      // path names the uploads dir, which is under `.haive/` and mounted read-write into
      // the sandbox, so it can be neither the anchor nor a prefix. A row that is not
      // where the api writes cannot be checked and counts as missing — re-attaching it,
      // which is what the apply-side error asks for, is the fix for both.
      const split = splitAttachmentStoredPath(row, ctx.taskId);
      if (split === null) {
        ctx.logger.warn(
          { file: row.filename },
          'plan inputs: attachment row is not stored under the task uploads directory',
        );
      }
      // Lenient: absent and refused both mean there is nothing to plan from, which is
      // what the `catch` this replaced folded them into. A link now reads as a link
      // rather than as whatever it points at.
      const info = split === null ? null : await lstatNoFollow(split.anchor, split.rel);
      if (info?.kind === 'file') continue;
      if (await stillAttachedUnderLock(ctx, row)) missing.push(row.filename);
      else deleted.add(row.id);
    }
    const kept = rows.filter((r) => !deleted.has(r.id));
    const keptNames = new Set(kept.map((r) => r.filename));

    return {
      greenfield: meta.planBuildMode === 'greenfield',
      briefLength: (task?.description ?? '').trim().length,
      uploadsDir:
        task?.repositoryId && kept.length > 0
          ? path.join(ctx.repoPath, '.haive', 'task-uploads', ctx.taskId)
          : null,
      // The two expansion columns are read, not carried in the persisted detect payload.
      attachments: kept.map(({ id, filename, storedPath, contentType, description }) => ({
        id,
        filename,
        storedPath,
        contentType,
        description,
      })),
      missing,
      archiveNotes: archiveNotes.filter((n) => keptNames.has(n.filename)),
    };
  },

  async apply(ctx, args): Promise<PlanInputsApply> {
    const d = args.detected;

    // An attachment row whose file is gone is not a degraded input, it is a
    // different plan. Fail loudly and name it: the fix is to re-attach and retry,
    // which this step is safe to do because it only ever rewrites its own output.
    if (d.missing.length > 0) {
      throw new Error(
        `${d.missing.length} attached file(s) are missing from the task workspace: ${d.missing.join(', ')}. Re-attach them and retry this step.`,
      );
    }

    // The other half of the request-level rule. The API accepts a greenfield
    // build with no brief when files are ON THEIR WAY; this is where both facts
    // are finally known.
    if (d.greenfield && d.briefLength === 0 && d.attachments.length === 0) {
      throw new Error(
        'This plan has nothing to build from: no description was written and no files were attached. Add either (the task Attachments tab accepts files) and retry this step.',
      );
    }

    const inputs: PlanInputRow[] = [];
    const archiveNotes = d.archiveNotes ?? [];
    const unreadable: string[] = [];
    let extracted = 0;
    const uploadsDir = d.uploadsDir;

    for (const attachment of d.attachments) {
      const prepared = await preparePlanInput(
        ctx,
        attachment,
        extracted < PLAN_INPUT_EXTRACTION_LIMIT,
      );
      // detect() proved every row had a real file; one that cannot be read now changed between the
      // two phases. Deleted meanwhile, it is simply no longer an input; still attached, it is the
      // same fact — and the same fix — as a row missing then.
      if (prepared.status === 'deleted') continue;
      if (prepared.status === 'missing') {
        throw new Error(
          `Attached file "${attachment.filename}" is no longer readable in the task workspace. Re-attach it and retry this step.`,
        );
      }
      inputs.push(prepared.row);
      if (prepared.extracted) extracted += 1;
      if (prepared.unreadable) unreadable.push(attachment.filename);
    }

    let indexPath: string | null = null;
    if (inputs.length > 0 && uploadsDir) {
      // Without the index the prompt simply does not send the agent to it: the attachments notice
      // still names every file, so a refused write is no reason to fail the build.
      indexPath = await writePlanInputsIndex(ctx.repoPath, ctx.taskId, inputs, archiveNotes).catch(
        (err: unknown) => {
          ctx.logger.warn({ err }, 'plan inputs: could not write the index');
          return null;
        },
      );
    }

    return {
      inputs,
      extracted,
      unreadable,
      hasImageInputs: inputs.some((i) => i.kind === 'image'),
      hasPdfInputs: inputs.some((i) => i.kind === 'pdf'),
      visualOnly: inputs.filter(isVisualOnly).map((i) => i.filename),
      indexPath,
      archiveNotes,
    };
  },
};
