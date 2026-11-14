import { createHash } from 'node:crypto';
import { LINE_BREAK, fenceSafe } from './prompts.js';
import { formatChangedLineRanges } from './review-line-ranges.js';

import type { ImplementationFileSet, ChangedLineNotes, FileCoverage } from './review-types.js';

/** Raw diff parser; host plumbing, not part of the module contract. */
export { parseDiffHunks } from './review-line-ranges.js';
/** Raw diff shapes; host plumbing, not part of the module contract. */
export type { DiffHunk, DiffFile } from './review-line-ranges.js';

/** Whether a name survives a prompt line and fence unchanged;
 *  host plumbing, not part of the module contract. */
export const isListableName = (name: string): boolean =>
  !LINE_BREAK.test(name) && fenceSafe(name) === name;

/** What a step's `detected` may actually hold.
 *
 *  `string[]` is the pre-coverage shape and is NOT dead: `step-runner.ts` replays a
 *  step's stored `detect_output` and only re-runs detect() when it is null, so a task
 *  in flight when this shipped reaches apply() and buildPrompt() carrying a bare array.
 *  Both readers below take it rather than assuming the new shape.
 */
type MaybeFileSet = ImplementationFileSet | string[] | undefined;

/** `value` as the new shape, or null for anything else — a bare array included. */
function asFileSet(value: MaybeFileSet): ImplementationFileSet | null {
  if (!value || Array.isArray(value) || !Array.isArray(value.files)) return null;
  return value;
}

/**
 * The coverage a step recorded, or null when it has none.
 *
 * Null for a replayed pre-coverage row, deliberately: that row's cap was applied
 * silently and how much it cut is not recoverable, so the honest answer is "not
 * recorded". It must not be reported as full coverage — a claim nobody measured is
 * the exact failure this record exists to remove — and the gate reads null as the
 * (unstated) claim such a row already made.
 */
export function fileCoverage(value: MaybeFileSet): FileCoverage | null {
  const set = asFileSet(value);
  if (!set || typeof set.total !== 'number') return null;
  // A name changedFilesBlock leaves out was not given to the agents.
  const listed = set.files.filter(isListableName).length;
  return {
    listed,
    total: set.total,
    truncated: set.truncated === true || listed < set.total,
    ...(set.scanError ? { scanFailed: true } : {}),
  };
}

/** Which new-side lines each file's diff wrote, capped at the existing prompt limit. */
export function parseChangedLineRanges(diff: string): ChangedLineNotes {
  return formatChangedLineRanges(diff);
}

const SCAN_FAILED_NOTICE = [
  'COVERAGE: the change could not be read in full, so the list above may be missing files of it.',
  'Any it lacks were NOT given to you and you cannot see them. Work from what is listed, and',
  'state plainly in your output that coverage is incomplete — do NOT report a clean result as',
  'though it covered the whole change.',
].join('\n');

/**
 * The changed-file block a prompt carries: the caller's own header and its own
 * empty-set fallback, plus — when the list was capped, a name was left out or the scan
 * of the change failed — an explicit statement of what the agent was NOT given.
 *
 * The notice is worded as an instruction to report the gap, not merely as a note:
 * an agent that silently reviews a partial list produces exactly the clean verdict
 * this exists to prevent.
 */
export function changedFilesBlock(value: MaybeFileSet, header: string, fallback: string): string {
  const set = asFileSet(value);
  // A replayed pre-coverage row still lists its files; it simply carries no notice,
  // which is byte-for-byte what it produced before this shipped.
  const recorded = set?.files ?? (Array.isArray(value) ? value : []);
  if (recorded.length === 0) {
    return set?.scanError ? (fallback ? `${fallback}\n\n` : '') + SCAN_FAILED_NOTICE : fallback;
  }
  // A name that spans lines or forges the fence would open a line or be rewritten, so it is counted, never written.
  const files = recorded.filter(isListableName);
  const unlistable = recorded.length - files.length;

  // The line note is what a list of paths alone cannot say: which part of a 5,000-line file
  // this change is. Without it a reviewer reads the whole file and cannot tell new code from
  // code that was already there, which is how pre-existing defects became blocking findings
  // against a three-line edit.
  const notes = set?.changedLines ?? {};
  const list = [
    `${header}:`,
    ...files.map((f) => (Object.hasOwn(notes, f) && notes[f] ? `- ${f} — ${notes[f]}` : `- ${f}`)),
  ].join('\n');

  const parts = [list];
  if (Object.keys(set?.nestedRepositories ?? {}).some((p) => files.includes(p))) {
    parts.push(
      '',
      'NESTED REPOSITORIES: each such entry is a checkout boundary, not a file. Its note',
      'states whether it has a checked-out commit; it supplies no changed file contents or',
      'line ranges. Do not open it as a file or treat its contents as newly added. Review',
      'the boundary and integration; files inside it need their own listed changes or',
      'demonstrated blast radius to be in scope.',
    );
  }
  if (Object.keys(notes).length > 0) {
    parts.push(
      '',
      'LINES: line notes after files name the part THIS change wrote, numbered as in the file',
      'you will read. A bare number can also mark where lines were deleted. Read the whole file',
      'for context — but a file listed with NO note has none recorded, so treat all of it as',
      'changed rather than assuming any of it is untouched.',
    );
  }
  if (set?.truncated) {
    const missing = set.total - files.length;
    parts.push(
      '',
      `COVERAGE: the list above is ${files.length} of ${set.total} changed files. The other`,
      `${missing} were NOT given to you and you cannot see them. Work from what is listed, and`,
      'state plainly in your output that the unlisted files were not covered — do NOT report a',
      'clean result as though it covered the whole change.',
    );
  }
  if (unlistable > 0) {
    parts.push(
      '',
      `COVERAGE: ${unlistable} changed files have names that cannot be listed safely. They were`,
      'NOT given to you and you cannot see them. State plainly in your output that those files',
      'were not covered — do NOT report a clean result as though it covered the whole change.',
    );
  }
  if (set?.scanError) {
    parts.push('', SCAN_FAILED_NOTICE);
  }
  return parts.join('\n');
}

/**
 * Refuse to review a change nobody can name.
 *
 * An empty list used to fall through to a prompt fallback telling the agent to work the
 * change out from the workspace. It cannot: `worktreeGitfileMask` bind-mounts an empty
 * read-only file over the worktree's `.git` for every cli-exec invocation, so there is no
 * `git status` and no `git diff` inside the sandbox — only a tree that reads as the whole
 * project. What the agent actually did was guess, which is the repo-wide review the
 * changed-file list exists to prevent, and the verdict it returned covered nothing.
 *
 * So the step fails instead, before a CLI is dispatched and before any tokens are spent.
 * Loud, not silent: a skip here would reach gate 2 as a review with no findings, which is
 * indistinguishable from an approval — the same reason `incompleteReviewIssue` exists for a
 * reviewer killed at its budget.
 *
 * The two ways to get an empty set are reported as the different facts they are. A scan
 * that could not run says so and names git's own error; a scan that ran and found nothing
 * says the implementation changed no files. Calling the first "nothing changed" is the
 * wrong diagnosis, and the diagnosis is what the human acts on.
 *
 * A replayed pre-coverage bare array is checked the same way — it is a file list, and an
 * empty one is the same hole — but it carries no scan record, so it gets the neutral
 * wording rather than a claim about git that nothing here observed.
 */
export function assertReviewableChange(stepId: string, value: MaybeFileSet): void {
  const set = asFileSet(value);
  const files = set?.files ?? (Array.isArray(value) ? value : []);
  if (files.length > 0) return;
  const cause = set?.scanError
    ? `the worktree scan failed (git: ${set.scanError})`
    : 'the implementation changed no files';
  throw new Error(
    `${stepId} has no changed files to review: ${cause}. Refusing to run — an agent given no ` +
      `change set cannot find one (git is masked inside the sandbox) and would review the ` +
      `whole repository instead. Check that the implementation step actually wrote to the ` +
      `worktree, then retry.`,
  );
}

const FP_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const FP_DIGITS_RE = /\d+/g;

/** Stable signature of a finding, namespaced by the reviewer that raised it.
 *
 *  Unlike `fixLoopFingerprint`, this KEEPS the path: there, the path is incidental
 *  detail in a prose diagnosis; here it is half the finding's identity — "npe in
 *  a.ts" and "npe in b.ts" are two findings, not one. Line numbers and ids are
 *  stripped so the same defect still hashes equal after the file around it moves.
 */
export function findingFingerprint(reviewerId: string, path: string, issue: string): string {
  const normalized = issue
    .toLowerCase()
    .replace(FP_UUID_RE, '')
    .replace(FP_DIGITS_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256')
    .update(`${reviewerId}\0${path.trim().toLowerCase()}\0${normalized}`)
    .digest('hex')
    .slice(0, 64);
}
