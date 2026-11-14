import type { ChangedLineNotes } from './review-types.js';

/** How many line ranges are listed for one file before the rest are reported as a count.
 *  A prompt-size cap, and — like MAX_LISTED_FILES — one that states what it cut. */
export const MAX_RANGES_PER_FILE = 20;

/** A raw new-side hunk; host plumbing, not part of the module contract. */
export interface DiffHunk {
  start: number;
  count: number;
}

/** A raw diff file; host plumbing, not part of the module contract. */
export interface DiffFile {
  deleted: boolean;
  hunks: DiffHunk[];
}

/**
 * This is host plumbing, not part of the module contract.
 * Every path of a `git diff --unified=0` output with its hunks, uncapped, in diff order.
 *
 * Line numbers are taken from the `+` side of each hunk header, so they address the file
 * AS THE AGENT WILL READ IT rather than some pre-change numbering.
 *
 * The path is read from the `+++ b/<path>` line rather than the `diff --git a/… b/…` header,
 * which is ambiguous for a path containing a space. A path git chose to QUOTE (control
 * characters, an embedded quote) is not unquoted here: it then matches no file in the set,
 * so the file is simply left unannotated — the same "not recorded" state that resolves to
 * whole-file scope. Failing to the wider scope is the only safe direction.
 */
export function parseDiffHunks(diff: string): Map<string, DiffFile> {
  const files = new Map<string, DiffFile>();
  let path: string | null = null;
  let deleted = false;
  let hunks: DiffHunk[] = [];
  // A removed `-- x` reads `--- x`, so only the lines before a file's first `@@` are header.
  let inHeader = false;

  const flush = (): void => {
    if (path) files.set(path, { deleted, hunks });
    path = null;
    deleted = false;
    hunks = [];
  };

  const strip = (side: string, prefix: string): string =>
    side.startsWith(prefix) ? side.slice(prefix.length) : side;

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      inHeader = true;
      continue;
    }
    // `---` always precedes `+++`, so the old side is recorded first and used only when the
    // new side turns out to be /dev/null — a deleted file names its path nowhere else.
    if (inHeader && line.startsWith('--- ')) {
      const source = line.slice(4).trim();
      if (source !== '/dev/null') path = strip(source, 'a/');
      continue;
    }
    if (inHeader && line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      if (target === '/dev/null') deleted = true;
      else path = strip(target, 'b/');
      continue;
    }
    if (!line.startsWith('@@')) continue;
    inHeader = false;
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const start = Number.parseInt(m[1]!, 10);
    const count = m[2] === undefined ? 1 : Number.parseInt(m[2], 10);
    if (!Number.isFinite(start)) continue;
    hunks.push({ start, count });
  }
  flush();
  return files;
}

const hunkLabel = ({ start, count }: DiffHunk): string =>
  count <= 1 ? String(start) : `${start}-${start + count - 1}`;

/**
 * Which lines each file's diff wrote, from `git diff --unified=0` output.
 *
 * A `+c,0` hunk is a pure deletion and has no new-side span; it is recorded as the single
 * line `c` (where the removal sits) and the legend says a bare number can mean that.
 */
export function formatChangedLineRanges(
  diff: string,
  maxRangesPerFile = MAX_RANGES_PER_FILE,
): ChangedLineNotes {
  const notes: ChangedLineNotes = {};
  for (const [path, { deleted, hunks }] of parseDiffHunks(diff)) {
    if (deleted) notes[path] = 'deleted';
    else if (hunks.length > 0) {
      const dropped = hunks.length - maxRangesPerFile;
      notes[path] =
        `lines ${hunks.slice(0, maxRangesPerFile).map(hunkLabel).join(', ')}` +
        (dropped > 0 ? ` (+${dropped} more ranges)` : '');
    } else {
      // A diff entry with no hunks: a mode change, or a rename with no edits. Saying so
      // beats leaving it indistinguishable from a file nothing measured.
      notes[path] = 'no line changes (mode or rename only)';
    }
  }
  return notes;
}
