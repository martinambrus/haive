/** The changed files a step was given, and how many there actually were.
 *
 *  `total` and `truncated` exist because the cap used to be applied silently: a
 *  reviewer was handed 100 of 150 changed files, read them all, and reported a
 *  clean verdict that gate 2 rendered over the 50 nobody looked at. A cap is
 *  disclosure, not failure — but only if it is disclosed.
 */
export interface ImplementationFileSet {
  /** Capped at MAX_LISTED_FILES; a name that spans lines or forges the fence is kept but never written onto a prompt line. */
  files: string[];
  /** How many changed files were found, before the cap. */
  total: number;
  /** Some changed files are NOT in `files`. Equivalent to `files.length < total`,
   *  kept explicit because this set is persisted to `task_steps.output` and read
   *  back by the gate. */
  truncated: boolean;
  /** Why the scan of the change contributed nothing, the dirty worktree or the committed
   *  half, when one failed outright; null when both ran. Optional because the shape is
   *  persisted and replayed: a row written before this field existed carries neither the
   *  flag nor its meaning, and absent must not read as "the scan ran cleanly". */
  scanError?: string | null;
  /** Which lines of each file this change actually wrote. Keyed by the same paths as
   *  `files`; a path with NO entry has none recorded, which is not the same as "the whole
   *  file changed" — the renderer and the scope fence both say so explicitly, and both
   *  resolve the unrecorded case to the wider (pre-existing) scope. */
  changedLines?: ChangedLineNotes;
  /** Checkout boundaries, never files whose contents the parent change wrote. Optional on old rows. */
  nestedRepositories?: Record<string, 'unborn' | 'with commits'>;
}

/** Per-file note on the changed-file list: which lines this change wrote.
 *
 *  Values are display strings ('lines 12-18, 45', 'new file', 'deleted'). Nothing branches
 *  on them — they exist to tell a reviewer which part of a file it is looking at, which is
 *  the one thing a list of paths cannot say. Kept as strings rather than a structured shape
 *  because the set is persisted to `task_steps.output`, where a human reads it back. */
export type ChangedLineNotes = Record<string, string>;

/** What a step recorded about its own coverage, for a gate to read back out of
 *  `task_steps.output`. Separate from ImplementationFileSet because the gate needs
 *  the counts, never the file list. */
export interface FileCoverage {
  /** How many changed files the step's agents were actually given. */
  listed: number;
  /** How many there were. */
  total: number;
  /** listed < total: the step's verdict does not cover the whole change. */
  truncated: boolean;
  /** The scan of the change failed, so the list may lack files of it: the verdict does not cover those either. */
  scanFailed?: true;
}

export interface Insight {
  id: string;
  sourceStep: string;
  title: string;
  location: string;
  description: string;
}
