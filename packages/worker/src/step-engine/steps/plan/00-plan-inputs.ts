import {
  chmodNoFollow,
  chownNoFollow,
  lstatNoFollow,
  writeFileNoFollow,
} from '@haive/shared/fs-safe';
import { splitAttachmentStoredPath, taskUploadsRel } from '@haive/shared';
import path from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
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
export const PLAN_INPUTS_INDEX = '_PLAN_INPUTS.md';

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
}

export interface PlanInputsDetect {
  /** Whether this task is a greenfield build; only that mode requires an input. */
  greenfield: boolean;
  briefLength: number;
  uploadsDir: string | null;
  attachments: {
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

/** Best-effort: the api chowns what it writes for the same reason, and a failure
 *  there is non-fatal because 0644 is world-readable anyway. */
async function harmonizeOwnership(anchor: string, rel: string): Promise<void> {
  await chownNoFollow(anchor, rel, { uid: NODE_UID, gid: NODE_GID }).catch(() => {});
  await chmodNoFollow(anchor, rel, 0o644).catch(() => {});
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
  const visual = rows.filter(
    (r) => r.kind === 'image' || (needsExtraction(r.kind) && !r.hasText && !r.extractionSkipped),
  );
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
        filename: schema.taskAttachments.filename,
        storedPath: schema.taskAttachments.storedPath,
        contentType: schema.taskAttachments.contentType,
        description: schema.taskAttachments.description,
      })
      .from(schema.taskAttachments)
      .where(eq(schema.taskAttachments.taskId, ctx.taskId))
      .orderBy(asc(schema.taskAttachments.createdAt));

    await ctx.emitProgress(
      rows.length === 0 ? 'No attached files.' : `Checking ${rows.length} attached file(s)...`,
    );

    const missing: string[] = [];
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
        missing.push(row.filename);
        continue;
      }
      // Lenient: absent and refused both mean there is nothing to plan from, which is
      // what the `catch` this replaced folded them into. A link now reads as a link
      // rather than as whatever it points at.
      const info = await lstatNoFollow(split.anchor, split.rel);
      if (info?.kind !== 'file') missing.push(row.filename);
    }

    return {
      greenfield: meta.planBuildMode === 'greenfield',
      briefLength: (task?.description ?? '').trim().length,
      uploadsDir:
        task?.repositoryId && rows.length > 0
          ? path.join(ctx.repoPath, '.haive', 'task-uploads', ctx.taskId)
          : null,
      attachments: rows,
      missing,
      archiveNotes: expansion.notes,
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
      const kind = classifyPlanInput(attachment.filename, attachment.contentType);
      // detect() proved every row had a real file; one that cannot be split or read now
      // changed between the two phases, which is the same fact — and the same fix — as a
      // row that was missing then.
      const split = splitAttachmentStoredPath(attachment, ctx.taskId);
      const info = split === null ? null : await lstatNoFollow(split.anchor, split.rel);
      if (info === null || info.kind !== 'file') {
        throw new Error(
          `Attached file "${attachment.filename}" is no longer readable in the task workspace. Re-attach it and retry this step.`,
        );
      }
      const row: PlanInputRow = {
        filename: attachment.filename,
        kind,
        bytes: info.stats.size,
        description: attachment.description,
        sidecar: null,
        // A text kind is readable as it stands; everything else has to earn it.
        hasText: kind === 'text',
        note: null,
      };

      if (needsExtraction(kind) && extracted >= PLAN_INPUT_EXTRACTION_LIMIT) {
        row.extractionSkipped = true;
        row.note = `not extracted: this plan already has ${PLAN_INPUT_EXTRACTION_LIMIT} extracted documents`;
      } else if (needsExtraction(kind)) {
        await ctx.emitProgress(`Extracting text from ${attachment.filename}...`);
        // Still the absolute path: the extractors are `unzip`/`pdftotext` subprocesses,
        // which resolve a path of their own by name, so containing them is a separate
        // change from anchoring this module's own reads.
        const result = await extractPlanInput(kind, attachment.storedPath);
        if (result.error) {
          // Reported, not thrown. The original is still mounted, so an agent that
          // can open it is not blocked by our inability to read it.
          row.note = `could not be extracted: ${result.error}`;
          unreadable.push(attachment.filename);
          ctx.logger.warn(
            { file: attachment.filename, kind, err: result.error },
            'plan input extraction failed',
          );
        } else {
          const name = sidecarName(attachment.filename);
          // A task with no uploads dir has nowhere to put a sidecar, and detect()
          // is what knows whether it has one. The PATH is not taken from this
          // value, nor from the row's stored path — it is built below as a rel.
          if (uploadsDir === null) {
            throw new Error(
              `Refusing to write a sidecar for "${attachment.filename}": the task has no uploads directory.`,
            );
          }
          // The name is a DATABASE column, so it becomes a rel walked under the repository
          // root a component at a time rather than a path joined onto the uploads dir and
          // checked afterwards. A name that cannot address a file inside it is a per-item
          // skip, like an extraction that failed: one bad row must not discard the sidecars
          // written beside it.
          const sidecarRel = uploadsInputRel(ctx.taskId, name);
          if (sidecarRel === null) {
            row.note = `extracted text could not be stored: "${name}" does not name a file inside the uploads directory`;
            unreadable.push(attachment.filename);
            ctx.logger.warn(
              { file: attachment.filename, sidecar: name },
              'plan inputs: refusing a sidecar name that leaves the uploads directory',
            );
          } else {
            const body =
              result.markdown.length > 0
                ? `# ${attachment.filename}\n\n${result.markdown}\n`
                : `# ${attachment.filename}\n\n_(no text could be read from this file)_\n`;
            // Ownership stays with `harmonizeOwnership`, which catches: it is best-effort here,
            // and passing it to the primitive would make a non-root worker fail the whole step.
            await writeFileNoFollow(ctx.repoPath, sidecarRel, body, { fileMode: 0o644 });
            await harmonizeOwnership(ctx.repoPath, sidecarRel);
            row.sidecar = name;
            // The extractor's own verdict on its INPUT, never a test on the string
            // it rendered — that string carries page rules and sheet headings this
            // module added, and a document that says nothing still produces them.
            row.hasText = result.hasContent;
            // An empty extraction is a fact about the DOCUMENT, not a failure of
            // the extractor, and the two must not read the same downstream.
            if (!row.hasText) row.note = 'contains no readable text';
            extracted += 1;
          }
        }
      }
      inputs.push(row);
    }

    let indexPath: string | null = null;
    if (inputs.length > 0 && uploadsDir) {
      const indexRel = `${taskUploadsRel(ctx.taskId)}/${PLAN_INPUTS_INDEX}`;
      await writeFileNoFollow(
        ctx.repoPath,
        indexRel,
        renderIndex(ctx.taskId, inputs, archiveNotes),
        { fileMode: 0o644 },
      );
      await harmonizeOwnership(ctx.repoPath, indexRel);
      indexPath = `${SANDBOX_WORKDIR}/.haive/task-uploads/${ctx.taskId}/${PLAN_INPUTS_INDEX}`;
    }

    return {
      inputs,
      extracted,
      unreadable,
      hasImageInputs: inputs.some((i) => i.kind === 'image'),
      hasPdfInputs: inputs.some((i) => i.kind === 'pdf'),
      // Needed extraction and got nothing usable out of it — either the extractor
      // failed or the document genuinely carries no text. Both leave the file
      // readable only by looking at it.
      visualOnly: inputs
        // `extractionSkipped` is excluded on purpose. Visual-only is a HARD
        // vision requirement on the dispatch, and it must rest on a measurement:
        // "the extractor found no text" is one, "the extractor never ran" is not.
        .filter((i) => needsExtraction(i.kind) && !i.hasText && !i.extractionSkipped)
        .map((i) => i.filename),
      indexPath,
      archiveNotes,
    };
  },
};
