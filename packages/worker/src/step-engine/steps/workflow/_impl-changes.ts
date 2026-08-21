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
}

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

async function dirtyWorktreeFiles(worktreePath: string): Promise<string[]> {
  try {
    const { stdout } = await exec('git', ['status', '--porcelain'], { cwd: worktreePath });
    return stdout
      .toString()
      .split('\n')
      .map((l) => l.slice(3).trim())
      .filter(Boolean)
      .map((name) => (name.includes(' -> ') ? name.split(' -> ')[1]! : name));
  } catch {
    return [];
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
  for (const f of await dirtyWorktreeFiles(worktreePath)) files.add(f);
  const all = [...files];
  const listed = all.slice(0, MAX_LISTED_FILES);
  return { files: listed, total: all.length, truncated: listed.length < all.length };
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
  const list = `${header}:\n- ${files.join('\n- ')}`;
  if (!set?.truncated) return list;
  const missing = set.total - files.length;
  return [
    list,
    '',
    `COVERAGE: the list above is ${set.files.length} of ${set.total} changed files. The other`,
    `${missing} were NOT given to you and you cannot see them. Work from what is listed, and`,
    'state plainly in your output that the unlisted files were not covered — do NOT report a',
    'clean result as though it covered the whole change.',
  ].join('\n');
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
