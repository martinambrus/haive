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

export type { FileCoverage } from '../step-engine/output-contracts.js';

export interface Insight {
  id: string;
  sourceStep: string;
  title: string;
  location: string;
  description: string;
}

export type InsightSourceRef =
  | {
      kind: 'invocation';
      invocationId: string;
      taskStepId: string;
      stepId: string;
      round: number;
      superseded: boolean;
    }
  | {
      kind: 'dag_withheld';
      issueId: string;
      stepId: '06c-dag-execute';
      severity: 'high' | 'medium' | 'low' | null;
    };

export interface InsightLoadOptions {
  /** Absent means unlimited. Must be a finite, safe, non-negative integer. */
  limit?: number;
  /** Include previously selected items, labelled picked; selection does not prove repair. */
  includePicked?: boolean;
}

export interface LoadedInsight extends Insight {
  /** Original parser position for compatibility with persisted gate snapshots, before pick filtering. */
  legacyId?: string;
  /** Physical sources, attached only by the inventory loader. */
  sourceRefs?: InsightSourceRef[];
  /** Stable versioned hash of the complete case-insensitive title/location pair. */
  id: string;
  /** findingIdentity over the full location/title, before presentation clipping. */
  identity: string;
  picked: boolean;
}

export interface InsightLoadResult {
  insights: LoadedInsight[];
  /** Eligible records cut by limit, after deliberately excluded picks are removed. */
  omitted: number;
}

/** Bounded deterministic display copy; complete source and attempts remain in invocation/event history. */
export interface InsightSummary {
  version: 1;
  automatic: boolean;
  roundsStarted: number;
  stopReason: 'disabled' | 'cap' | 'no_new_consequential' | 'incomplete';
  totals: { identities: number; occurrences: number; picked: number };
  offset: number;
  omitted: number;
  items: Array<{
    id: string;
    identity: string;
    title: string;
    location: string;
    description: string;
    occurrences: number;
    sourceRefs: InsightSourceRef[];
    sourceRefsOmitted: number;
    class: 'consequential' | 'minor' | 'nit' | 'unclassified';
    kind: string | null;
    reason: string;
    outcome: string;
    attempts: Array<{
      insightId: string;
      batchId: string;
      mode: string;
      invocationId: string | null;
      reportedOutcome: string;
    }>;
    attemptsOmitted: number;
  }>;
}
