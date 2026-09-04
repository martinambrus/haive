import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { StepContext } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';

const exec = promisify(execFile);

/** How many changed files a prompt lists. The cap is for prompt size; what matters
 *  is that a list cut down to it says so — see changedFilesBlock. */
const MAX_LISTED_FILES = 100;

/** The changed files a step was given, and how many there actually were.
 *
 *  `total` and `truncated` exist because the cap used to be applied silently: a
 *  reviewer was handed 100 of 150 changed files, read them all, and reported a
 *  clean verdict that gate 2 rendered over the 50 nobody looked at. A cap is
 *  disclosure, not failure — but only if it is disclosed.
 */
export interface ImplementationFileSet {
  /** The files listed in the prompt: `total` of them, capped at MAX_LISTED_FILES. */
  files: string[];
  /** How many changed files were found, before the cap. */
  total: number;
  /** Some changed files are NOT in `files`. Equivalent to `files.length < total`,
   *  kept explicit because this set is persisted to `task_steps.output` and read
   *  back by the gate. */
  truncated: boolean;
  /** Why the dirty-worktree scan contributed nothing, when it failed outright; null
   *  when it ran. Optional because the shape is persisted and replayed: a row written
   *  before this field existed carries neither the flag nor its meaning, and absent
   *  must not read as "the scan ran cleanly". */
  scanError?: string | null;
  /** Which lines of each file this change actually wrote. Keyed by the same paths as
   *  `files`; a path with NO entry has none recorded, which is not the same as "the whole
   *  file changed" — the renderer and the scope fence both say so explicitly, and both
   *  resolve the unrecorded case to the wider (pre-existing) scope. */
  changedLines?: ChangedLineNotes;
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
}

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
  return { listed: set.files.length, total: set.total, truncated: set.truncated === true };
}

/** How much of a failed scan's own error text is quoted back. */
const MAX_SCAN_ERROR_CHARS = 300;

/** What the dirty-worktree scan produced, and whether it ran at all.
 *
 *  It used to swallow its failure and answer `[]`, which made "git status could not run"
 *  and "nothing has changed" the same value. They are different facts and a human acts
 *  on them differently — a poisoned or half-repaired worktree (the state
 *  `git worktree repair` in removeWorktreeDir exists for) versus an implementation that
 *  wrote nothing — so the empty-set guard below has to be able to tell them apart. */
interface DirtyScan {
  files: string[];
  /** Paths git reports as untracked (`??`). They appear in no diff at all — there is no
   *  old side to diff against — so the line notes have to learn "new file" from here. */
  untracked: string[];
  /** The `git status` failure, or null when the scan ran (a clean tree is a RESULT). */
  error: string | null;
}

/** Currently-dirty paths in the worktree, as FILES.
 *
 *  `-uall` is load-bearing, not a tidy-up. Plain `--porcelain` collapses a wholly-untracked
 *  DIRECTORY into one entry — on a DDEV worktree, literally `?? .ddev/` — and git never
 *  descends into it, so the nested `.ddev/.gitignore` that excludes every generated artifact
 *  is never consulted. That directory then reached six steps as a changed "file", and five
 *  different reviewers independently opened it and reported the generated compose/build
 *  output inside. MEASURED before the fix: 474 recurring (reviewer, file) groups and 1,848
 *  finding rows, one of them re-raised across 19 rounds, none of them fixable — DDEV rewrites
 *  those files on every start.
 *
 *  Deferring to git's own ignore rules is the invariant; a hardcoded `.ddev` exclusion list
 *  would rot the moment DDEV renames an artifact, and would fix only DDEV. Any untracked
 *  directory had this bug.
 *
 *  Cost: a repo with a large un-gitignored untracked tree now enumerates it and can crowd
 *  `MAX_LISTED_FILES`. That cap already reports `truncated` rather than hiding the cut. */
async function dirtyWorktreeFiles(worktreePath: string): Promise<DirtyScan> {
  try {
    const { stdout } = await exec('git', ['status', '--porcelain', '-uall'], { cwd: worktreePath });
    const files: string[] = [];
    const untracked: string[] = [];
    for (const line of stdout.toString().split('\n')) {
      const name = line.slice(3).trim();
      if (!name) continue;
      // A rename record is `R  new -> old` in the non-`-z` format; the destination is the
      // path that exists on disk, which is the one a reviewer can open.
      const resolved = name.includes(' -> ') ? name.split(' -> ')[1]! : name;
      files.push(resolved);
      if (line.startsWith('??')) untracked.push(resolved);
    }
    return { files, untracked, error: null };
  } catch (err) {
    const detail = err as { stderr?: unknown; message?: unknown };
    const stderr = typeof detail.stderr === 'string' ? detail.stderr.trim() : '';
    const message = typeof detail.message === 'string' ? detail.message.trim() : String(err);
    const reason = stderr || message || 'git status failed';
    // The reason is quoted into a task-level error message, so it is bounded — and the
    // cut is stated, the same way the changed-file cap states its own.
    return {
      files: [],
      untracked: [],
      error:
        reason.length > MAX_SCAN_ERROR_CHARS
          ? `${reason.slice(0, MAX_SCAN_ERROR_CHARS)} (truncated)`
          : reason,
    };
  }
}

/** How many line ranges are listed for one file before the rest are reported as a count.
 *  A prompt-size cap, and — like MAX_LISTED_FILES — one that states what it cut. */
const MAX_RANGES_PER_FILE = 20;

/** Ceiling on the raw `git diff` output read for line ranges. `--unified=0` still prints
 *  every changed line, so a very large change is megabytes; execFile's 1 MB default would
 *  reject it and cost the notes entirely. Exceeding this is not fatal — no notes are
 *  recorded and the fence falls back to whole-file scope. */
const MAX_DIFF_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * Which lines each file's diff wrote, from `git diff --unified=0` output.
 *
 * Line numbers are taken from the `+` side of each hunk header, so they address the file
 * AS THE AGENT WILL READ IT rather than some pre-change numbering. A `+c,0` hunk is a pure
 * deletion and has no new-side span; it is recorded as the single line `c` (where the
 * removal sits) and the legend says a bare number can mean that.
 *
 * The path is read from the `+++ b/<path>` line rather than the `diff --git a/… b/…` header,
 * which is ambiguous for a path containing a space. A path git chose to QUOTE (control
 * characters, an embedded quote) is not unquoted here: it then matches no file in the set,
 * so the file is simply left unannotated — the same "not recorded" state that resolves to
 * whole-file scope. Failing to the wider scope is the only safe direction.
 */
export function parseChangedLineRanges(diff: string): ChangedLineNotes {
  const notes: ChangedLineNotes = {};
  let path: string | null = null;
  let deleted = false;
  let ranges: string[] = [];
  let dropped = 0;

  const flush = (): void => {
    if (path) {
      if (deleted) notes[path] = 'deleted';
      else if (ranges.length > 0) {
        notes[path] =
          `lines ${ranges.join(', ')}` + (dropped > 0 ? ` (+${dropped} more ranges)` : '');
      } else {
        // A diff entry with no hunks: a mode change, or a rename with no edits. Saying so
        // beats leaving it indistinguishable from a file nothing measured.
        notes[path] = 'no line changes (mode or rename only)';
      }
    }
    path = null;
    deleted = false;
    ranges = [];
    dropped = 0;
  };

  const strip = (side: string, prefix: string): string =>
    side.startsWith(prefix) ? side.slice(prefix.length) : side;

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      continue;
    }
    // `---` always precedes `+++`, so the old side is recorded first and used only when the
    // new side turns out to be /dev/null — a deleted file names its path nowhere else.
    if (line.startsWith('--- ')) {
      const source = line.slice(4).trim();
      if (source !== '/dev/null') path = strip(source, 'a/');
      continue;
    }
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      if (target === '/dev/null') deleted = true;
      else path = strip(target, 'b/');
      continue;
    }
    if (!line.startsWith('@@')) continue;
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const start = Number.parseInt(m[1]!, 10);
    const count = m[2] === undefined ? 1 : Number.parseInt(m[2], 10);
    if (!Number.isFinite(start)) continue;
    if (ranges.length >= MAX_RANGES_PER_FILE) {
      dropped += 1;
      continue;
    }
    ranges.push(count <= 1 ? String(start) : `${start}-${start + count - 1}`);
  }
  flush();
  return notes;
}

/**
 * The ref this task's change should be measured against.
 *
 * The merge-base, NOT `HEAD`: the two execution paths commit differently and only the fork
 * point covers both. Single-agent work is still uncommitted at review time, so `git diff
 * HEAD` is the change — and there merge-base(HEAD, base) IS HEAD, so nothing moves. DAG
 * execution commits every issue (dag-executor.ts) and merges them in, so at review time the
 * tree is CLEAN and `git diff HEAD` is empty; diffing the fork point recovers the whole
 * change. `git diff <ref>` compares the WORKING TREE to that ref, so one call covers
 * committed and uncommitted work together.
 *
 * Falls back to HEAD when the base branch is unknown or gone, and to null when even HEAD
 * does not resolve. Every failure ends in fewer notes, never wrong ones.
 */
async function resolveDiffBase(
  worktreePath: string,
  baseBranch: string | null,
): Promise<string | null> {
  if (baseBranch) {
    try {
      const { stdout } = await exec('git', ['merge-base', 'HEAD', baseBranch], {
        cwd: worktreePath,
      });
      const sha = stdout.toString().trim();
      if (sha) return sha;
    } catch {
      // base branch renamed, deleted, or unrelated history — fall through to HEAD
    }
  }
  try {
    await exec('git', ['rev-parse', '--verify', 'HEAD'], { cwd: worktreePath });
    return 'HEAD';
  } catch {
    return null;
  }
}

/** The per-file line notes for this worktree, or an empty map when the diff cannot be
 *  read. Empty is a legitimate answer and never an error: the renderer states that an
 *  unannotated file has no recorded range, and the scope fence treats it as wholly in
 *  scope, which is exactly the behaviour that existed before notes did. */
async function changedLineNotes(
  worktreePath: string,
  baseBranch: string | null,
): Promise<ChangedLineNotes> {
  const base = await resolveDiffBase(worktreePath, baseBranch);
  if (!base) return {};
  try {
    const { stdout } = await exec(
      'git',
      // quotePath=false keeps a non-ASCII path literal so it still matches the file set.
      // --no-renames keeps every path on its own diff entry, so a renamed file is annotated
      // under the name it now has on disk.
      ['-c', 'core.quotePath=false', 'diff', '--unified=0', '--no-color', '--no-renames', base],
      { cwd: worktreePath, maxBuffer: MAX_DIFF_BUFFER_BYTES },
    );
    return parseChangedLineRanges(stdout.toString());
  } catch {
    return {};
  }
}

/**
 * Files the implementation touched, for post-implementation steps (3.5
 * simplification, Phase 4 validation): the single-agent 07 output's
 * `filesTouched` when present, else the union of the DAG issues'
 * `filesModified`, plus currently-dirty worktree files (single-agent work is
 * still uncommitted at this point). Deduped, capped for prompt size — and the
 * cap is reported rather than applied silently.
 */
export async function collectImplementationFiles(
  ctx: StepContext,
  worktreePath: string,
): Promise<ImplementationFileSet> {
  const files = new Set<string>();
  const implement = await loadPreviousStepOutput(ctx.db, ctx.taskId, '07-phase-2-implement');
  const touched = (implement?.output as { filesTouched?: string[] } | null)?.filesTouched;
  for (const f of touched ?? []) files.add(f);
  if (files.size === 0) {
    const issues = await ctx.db
      .select({ filesModified: schema.taskDagIssues.filesModified })
      .from(schema.taskDagIssues)
      .where(eq(schema.taskDagIssues.taskId, ctx.taskId));
    for (const row of issues) {
      for (const f of (row.filesModified ?? []) as string[]) files.add(f);
    }
  }
  const scan = await dirtyWorktreeFiles(worktreePath);
  for (const f of scan.files) files.add(f);
  const all = [...files];
  const listed = all.slice(0, MAX_LISTED_FILES);

  // Which lines of each file the change wrote. Measured against the task's fork point, so
  // it covers committed (DAG) and uncommitted (single-agent) work alike — see
  // resolveDiffBase. An untracked file is in no diff at all, so it is named here.
  const worktree = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-worktree-setup');
  const baseBranch = (worktree?.output as { baseBranch?: string } | null)?.baseBranch ?? null;
  const measured = await changedLineNotes(worktreePath, baseBranch);
  for (const p of scan.untracked) measured[p] ??= 'new file';
  // Only the files the prompt will actually list, so the persisted set carries no notes for
  // files nobody was given.
  const changedLines: ChangedLineNotes = {};
  for (const f of listed) {
    const note = measured[f];
    if (note) changedLines[f] = note;
  }

  return {
    files: listed,
    total: all.length,
    truncated: listed.length < all.length,
    scanError: scan.error,
    changedLines,
  };
}

/**
 * The changed-file block a prompt carries: the caller's own header and its own
 * empty-set fallback, plus — when the list was capped — an explicit statement of
 * what the agent was NOT given.
 *
 * The notice is worded as an instruction to report the gap, not merely as a note:
 * an agent that silently reviews a partial list produces exactly the clean verdict
 * this exists to prevent.
 */
export function changedFilesBlock(value: MaybeFileSet, header: string, fallback: string): string {
  const set = asFileSet(value);
  // A replayed pre-coverage row still lists its files; it simply carries no notice,
  // which is byte-for-byte what it produced before this shipped.
  const files = set?.files ?? (Array.isArray(value) ? value : []);
  if (files.length === 0) return fallback;

  // The line note is what a list of paths alone cannot say: which part of a 5,000-line file
  // this change is. Without it a reviewer reads the whole file and cannot tell new code from
  // code that was already there, which is how pre-existing defects became blocking findings
  // against a three-line edit.
  const notes = set?.changedLines ?? {};
  const list = [
    `${header}:`,
    ...files.map((f) => (notes[f] ? `- ${f} — ${notes[f]}` : `- ${f}`)),
  ].join('\n');

  const parts = [list];
  if (Object.keys(notes).length > 0) {
    parts.push(
      '',
      'LINES: the note after a file is the part of it THIS change wrote, numbered as in the file',
      'you will read. A bare number can also mark where lines were deleted. Read the whole file',
      'for context — but a file listed with NO note has none recorded, so treat all of it as',
      'changed rather than assuming any of it is untouched.',
    );
  }
  if (set?.truncated) {
    const missing = set.total - files.length;
    parts.push(
      '',
      `COVERAGE: the list above is ${set.files.length} of ${set.total} changed files. The other`,
      `${missing} were NOT given to you and you cannot see them. Work from what is listed, and`,
      'state plainly in your output that the unlisted files were not covered — do NOT report a',
      'clean result as though it covered the whole change.',
    );
  }
  return parts.join('\n');
}

/** What a prompt says if an empty change set ever reaches it anyway.
 *
 *  `assertReviewableChange` fails the step before any of the four review steps render
 *  this, so it is a backstop and not a path. It exists because the text it replaced —
 *  "Determine the recently-changed files from the workspace and read each in full" —
 *  asked for something the agent cannot do and answered by guessing. */
export const NO_CHANGE_SET_FALLBACK = [
  'No changed-file list was recorded for this change.',
  'Do NOT try to work out what changed. git is unavailable here and the tree you can read is',
  'the whole project, so anything you infer is a guess. Say that you were given no change set,',
  'review nothing, and do NOT report a clean result.',
].join('\n');

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

/** Documentation file extensions. A change confined to these touches no executable
 *  code, which is what lets a reviewer swap its code dimensions for documentation
 *  ones (07b-phase-4-validate). */
const DOC_EXTENSIONS = ['.md', '.mdx', '.rst', '.adoc', '.txt'];

/**
 * Whether this change set is documentation only.
 *
 * Fails CLOSED — false is "not established", never "no docs". Three ways to get it:
 * a bare pre-coverage array or a missing set (no coverage was recorded, so nothing
 * can be concluded), a `truncated` set (the unlisted files are unknown, and calling a
 * partial list docs-only is exactly the silent-cap failure `changedFilesBlock`'s
 * coverage notice exists to prevent), and an empty list (a claim about no files).
 *
 * The cost of a wrong true is a code change reviewed by a documentation protocol, so
 * the bar is "every listed path is a doc AND the list is known to be complete".
 */
export function isDocsOnlyChange(value: MaybeFileSet): boolean {
  const set = asFileSet(value);
  if (!set || set.truncated) return false;
  if (set.files.length === 0) return false;
  return set.files.every((f) => {
    const lower = f.toLowerCase();
    return DOC_EXTENSIONS.some((ext) => lower.endsWith(ext));
  });
}
