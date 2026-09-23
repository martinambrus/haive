import { ATTACHMENT_ARCHIVE_EXTENSIONS } from './archive.js';
import { ATTACHMENTS_MANIFEST_NAME } from './manifest.js';
import { PLAN_INPUT_SIDECAR_SUFFIX, PLAN_INPUTS_INDEX_NAME } from './plan-inputs.js';

/**
 * The names in a task's uploads dir that belong to Haive, not to the person uploading.
 *
 * Two writers make these: the api (the manifest, `_ATTACHMENTS.md`) and the worker's
 * `00-plan-inputs` (its index, `_PLAN_INPUTS.md`, and a `<doc>.extracted.md` beside each document
 * it extracts). An attachment allowed one of those names is overwritten the next time the file is
 * generated, with its row still pointing at it — or, as a FOLDER, blocks the generated file from
 * being written at all. So every place that makes a name applies the same rule: an upload, and an
 * archive member or expansion folder, which is why it lives here rather than in either writer.
 */

/** Names the uploads ROOT owns. Only the root: `docs/_ATTACHMENTS.md` blocks nothing. */
const ROOT_RESERVED_NAMES: ReadonlySet<string> = new Set([
  ATTACHMENTS_MANIFEST_NAME,
  PLAN_INPUTS_INDEX_NAME,
]);

/** Whether `name`, at the root of the uploads dir or below it, is one a generated file owns. A
 *  sidecar's name is owned at EVERY depth: the worker writes `<doc>.extracted.md` beside its
 *  document wherever that sits, and a delete of the document unlinks that path whether or not the
 *  sidecar exists yet. Exact, like the filesystem: `_attachments.md` is a different name. */
export function isReservedAttachmentName(name: string, atRoot: boolean): boolean {
  return (atRoot && ROOT_RESERVED_NAMES.has(name)) || name.endsWith(PLAN_INPUT_SIDECAR_SUFFIX);
}

/** A basename's stem and extension, for the ` (n)` de-dupe. An archive's two-part extension stays
 *  whole: the second `spec.tar.gz` has to be `spec (2).tar.gz`, because `spec.tar (2).gz` is a name
 *  no archive rule recognises, so it would never be expanded. A name with no dot past its first
 *  character has no extension. */
export function splitAttachmentExtension(base: string): { stem: string; ext: string } {
  const lower = base.toLowerCase();
  for (const [ext] of ATTACHMENT_ARCHIVE_EXTENSIONS) {
    const twoPart = ext.indexOf('.', 1) !== -1;
    if (twoPart && base.length > ext.length && lower.endsWith(ext)) {
      return { stem: base.slice(0, -ext.length), ext: base.slice(-ext.length) };
    }
  }
  const dot = base.lastIndexOf('.');
  return dot > 0 ? { stem: base.slice(0, dot), ext: base.slice(dot) } : { stem: base, ext: '' };
}

/**
 * `relPath` with every FOLDER a generated file would collide with renamed to `<name> (2)`.
 *
 * Deterministic rather than probed, because a folder upload arrives one file per request: every file
 * under `_ATTACHMENTS.md/` has to land in the same renamed folder, which a per-request probe for a
 * free name could not promise. Renamed rather than refused, because the panel uploads a folder in a
 * loop that stops at the first error, so a refusal would drop the rest of the folder. The LEAF is left
 * alone: whoever creates the file probes for a free name and skips a reserved one there.
 */
export function reserveAttachmentDirs(relPath: string): string {
  const segments = relPath.split('/');
  const leaf = segments.pop()!;
  if (segments.length === 0) return relPath;
  const dirs = segments.map((segment, index) =>
    isReservedAttachmentName(segment, index === 0) ? `${segment} (2)` : segment,
  );
  return [...dirs, leaf].join('/');
}
