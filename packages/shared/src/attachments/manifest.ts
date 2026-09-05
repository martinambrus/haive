import { splitAttachmentPath } from './paths.js';

/**
 * `_ATTACHMENTS.md` — the index every agent is told to read.
 *
 * Two writers now, so one renderer: the api rewrites it on upload and delete,
 * and the worker rewrites it after expanding an archive into its tree. A second
 * copy of this markup would drift, and the file it produces is the ONE thing
 * standing between the agent and a directory it was never told about.
 *
 * Deliberately UNCAPPED, unlike the prompt notice: this file is where the notice
 * sends a reader for the names it could not fit.
 */

export const ATTACHMENTS_MANIFEST_NAME = '_ATTACHMENTS.md';

export interface AttachmentManifestRow {
  /** Relative path under the uploads dir (`docs/api/spec.md`). */
  filename: string;
  description: string | null;
}

/** Full paths, grouped by directory so a tree is scannable. The path is repeated
 *  in full on every line rather than indented under its heading — an agent copies
 *  a line to open the file, and half a path does not open. */
export function renderAttachmentsManifest(rows: readonly AttachmentManifestRow[]): string | null {
  if (rows.length === 0) return null;

  const byDir = new Map<string, AttachmentManifestRow[]>();
  for (const row of rows) {
    const { dir } = splitAttachmentPath(row.filename);
    const bucket = byDir.get(dir);
    if (bucket) bucket.push(row);
    else byDir.set(dir, [row]);
  }

  const line = (row: AttachmentManifestRow): string =>
    `- \`${row.filename}\`${row.description ? ` — ${row.description}` : ''}`;

  const lines = [
    '# Attached files',
    '',
    'User-attached reference files for this task. Read any you need.',
    '',
  ];
  for (const row of byDir.get('') ?? []) lines.push(line(row));

  const dirs = [...byDir.keys()].filter((dir) => dir !== '').sort();
  for (const dir of dirs) {
    lines.push('', `## \`${dir}/\``, '');
    for (const row of byDir.get(dir) ?? []) lines.push(line(row));
  }
  lines.push('');
  return lines.join('\n');
}
