import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const loadPreviousStepOutput = vi.fn();
vi.mock('../onboarding/_helpers.js', () => ({
  loadPreviousStepOutput: (...args: unknown[]) => loadPreviousStepOutput(...args),
}));

const {
  assertReviewableChange,
  changedFilesBlock,
  collectImplementationFiles,
  fileCoverage,
  isDocsOnlyChange,
  NO_CHANGE_SET_FALLBACK,
  parseChangedLineRanges,
} = await import('./_impl-changes.js');
type StepContextLike = Parameters<typeof collectImplementationFiles>[0];

/** The helper only touches ctx.db when filesTouched is empty; every case here supplies
 *  files, and the worktree path is deliberately bogus so `git status` fails and the
 *  dirty-file union contributes nothing. */
function ctxWith(files: string[]): StepContextLike {
  loadPreviousStepOutput.mockResolvedValue({ output: { filesTouched: files } });
  return { db: {}, taskId: 'test-task' } as unknown as StepContextLike;
}

function names(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `src/file-${i}.ts`);
}

beforeEach(() => {
  loadPreviousStepOutput.mockReset();
});

describe('collectImplementationFiles', () => {
  it('reports the full count when nothing was cut', async () => {
    const set = await collectImplementationFiles(ctxWith(names(99)), '/nonexistent-worktree');
    expect(set.files).toHaveLength(99);
    expect(set.total).toBe(99);
    expect(set.truncated).toBe(false);
  });

  it('is not truncated exactly at the cap', async () => {
    const set = await collectImplementationFiles(ctxWith(names(100)), '/nonexistent-worktree');
    expect(set.files).toHaveLength(100);
    expect(set.total).toBe(100);
    expect(set.truncated).toBe(false);
  });

  it('reports the cap rather than applying it silently', async () => {
    const set = await collectImplementationFiles(ctxWith(names(150)), '/nonexistent-worktree');
    expect(set.files).toHaveLength(100);
    // The count that matters: the step now knows 50 files exist that it was not given.
    expect(set.total).toBe(150);
    expect(set.truncated).toBe(true);
  });
});

describe('fileCoverage', () => {
  it('carries the counts a gate reads back, not the file list', () => {
    expect(fileCoverage({ files: ['a.ts', 'b.ts'], total: 7, truncated: true })).toEqual({
      listed: 2,
      total: 7,
      truncated: true,
    });
  });

  it('answers null — not full coverage — for a replayed pre-coverage row', () => {
    // step-runner replays a stored detect_output and only re-runs detect() when it is
    // null, so a task in flight when this shipped reaches apply() with the bare array.
    // How much its silent cap removed is not recoverable, and reporting it as complete
    // would be the very claim this record exists to remove.
    expect(fileCoverage(['src/a.ts', 'src/b.ts'])).toBeNull();
    expect(fileCoverage(undefined)).toBeNull();
  });
});

describe('changedFilesBlock', () => {
  it('returns the caller fallback when there are no files', () => {
    const block = changedFilesBlock(
      { files: [], total: 0, truncated: false },
      'Changed files',
      'Work it out from the workspace.',
    );
    expect(block).toBe('Work it out from the workspace.');
  });

  it('lists the files under the caller header with no notice when complete', () => {
    const block = changedFilesBlock(
      { files: ['src/a.ts', 'src/b.ts'], total: 2, truncated: false },
      'Changed files to review (read each in full)',
      'fallback',
    );
    expect(block).toBe('Changed files to review (read each in full):\n- src/a.ts\n- src/b.ts');
    expect(block).not.toContain('COVERAGE');
  });

  it('states both counts and the shortfall when the list was capped', () => {
    const block = changedFilesBlock(
      { files: names(100), total: 150, truncated: true },
      'Changed files',
      'fallback',
    );
    expect(block).toContain('COVERAGE: the list above is 100 of 150 changed files');
    expect(block).toContain('50 were NOT given to you');
  });

  it('renders a replayed pre-coverage row exactly as it rendered before', () => {
    const block = changedFilesBlock(['src/a.ts', 'src/b.ts'], 'Changed files', 'fallback');
    expect(block).toBe('Changed files:\n- src/a.ts\n- src/b.ts');
    expect(block).not.toContain('COVERAGE');
  });

  it('instructs the agent to report the gap rather than only noting it', () => {
    // The whole point: an agent that silently reviews a partial list produces the clean
    // verdict this exists to prevent.
    const block = changedFilesBlock(
      { files: names(100), total: 101, truncated: true },
      'Changed files',
      'fallback',
    );
    expect(block).toContain('state plainly in your output that the unlisted files were not');
    expect(block).toContain('clean result');
  });
});

describe('isDocsOnlyChange', () => {
  const set = (files: string[], truncated = false) => ({
    files,
    total: truncated ? files.length + 1 : files.length,
    truncated,
  });

  it('is true when every listed file is documentation', () => {
    expect(isDocsOnlyChange(set(['README.md', 'docs/install.rst', 'NOTES.txt']))).toBe(true);
  });

  it('is false when any listed file is not documentation', () => {
    expect(isDocsOnlyChange(set(['README.md', 'index.php']))).toBe(false);
  });

  it('matches extensions case-insensitively', () => {
    expect(isDocsOnlyChange(set(['README.MD', 'Docs/Guide.AdOc']))).toBe(true);
  });

  it('is false for a truncated set even when every listed file is documentation', () => {
    // The unlisted files are unknown; calling this docs-only would hand a code change
    // the documentation protocol on the strength of a capped list.
    expect(isDocsOnlyChange(set(['README.md'], true))).toBe(false);
  });

  it('is false for an empty file list', () => {
    expect(isDocsOnlyChange(set([]))).toBe(false);
  });

  it('is false for a replayed pre-coverage bare array', () => {
    // No coverage was recorded, so completeness cannot be established.
    expect(isDocsOnlyChange(['README.md'])).toBe(false);
  });

  it('is false when there is no file set at all', () => {
    expect(isDocsOnlyChange(undefined)).toBe(false);
  });

  it('does not treat a file merely containing a doc extension as documentation', () => {
    expect(isDocsOnlyChange(set(['src/md.php']))).toBe(false);
    expect(isDocsOnlyChange(set(['app/readme.md.php']))).toBe(false);
  });
});

describe('collectImplementationFiles — untracked directories', () => {
  const exec = promisify(execFile);
  const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@haive.local',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@haive.local',
  };
  const git = (dir: string, args: string[]) => exec('git', args, { cwd: dir, env: GIT_ENV });

  /** ctx with no filesTouched and no DAG issues, so the dirty-worktree union is the only
   *  contributor and the assertion is about `git status` alone. */
  function ctxAt(): StepContextLike {
    loadPreviousStepOutput.mockResolvedValue({ output: { filesTouched: [] } });
    return {
      taskId: 't1',
      db: { select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }) },
    } as unknown as StepContextLike;
  }

  /** A repo whose `.ddev/` is wholly untracked and carries its own .gitignore — the exact
   *  shape DDEV leaves behind, and the one plain `--porcelain` reports as `?? .ddev/`. */
  async function setupUntrackedDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'impl-'));
    await git(dir, ['init', '-b', 'main']);
    await writeFile(path.join(dir, 'base.txt'), 'base\n', 'utf8');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'init']);
    await mkdir(path.join(dir, '.ddev'), { recursive: true });
    await writeFile(path.join(dir, '.ddev/.gitignore'), 'generated.yaml\n', 'utf8');
    await writeFile(path.join(dir, '.ddev/config.yaml'), 'name: x\n', 'utf8');
    await writeFile(path.join(dir, '.ddev/generated.yaml'), 'machine-specific\n', 'utf8');
    return dir;
  }

  it('lists the authored files inside an untracked directory, not the directory', async () => {
    // The regression this exists for: `git status --porcelain` collapses a wholly-untracked
    // directory to `?? .ddev/` and never descends, so the nested .gitignore is never applied
    // and reviewers were handed a DIRECTORY as a changed file. MEASURED: 1,848 finding rows
    // across 474 recurring (reviewer, file) groups, one re-raised across 19 rounds.
    const dir = await setupUntrackedDir();
    try {
      const out = await collectImplementationFiles(ctxAt(), dir);
      expect(out.files).toContain('.ddev/config.yaml');
      expect(out.files).not.toContain('.ddev/');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("honours the untracked directory's own .gitignore", async () => {
    // Deferring to git's ignore rules is the whole point — a hardcoded path list would rot
    // the moment DDEV renamed an artifact, and would fix only DDEV.
    const dir = await setupUntrackedDir();
    try {
      const out = await collectImplementationFiles(ctxAt(), dir);
      // Both halves, or this passes for the wrong reason: without -uall the whole set is
      // just `.ddev/`, which trivially "does not contain" the generated file.
      expect(out.files).toContain('.ddev/config.yaml');
      expect(out.files).not.toContain('.ddev/generated.yaml');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('collectImplementationFiles — scan provenance', () => {
  it('records why the dirty-worktree scan contributed nothing', async () => {
    // "git status could not run" and "nothing changed" used to be the same empty array.
    // assertReviewableChange reports them as different diagnoses, so the difference has
    // to survive collection.
    const set = await collectImplementationFiles(ctxWith(['src/a.ts']), '/nonexistent-worktree');
    expect(set.scanError).toBeTruthy();
  });

  it('records null when the scan ran, even on a clean tree', async () => {
    const exec2 = promisify(execFile);
    const dir = await mkdtemp(path.join(tmpdir(), 'impl-clean-'));
    try {
      await exec2('git', ['init', '-b', 'main'], { cwd: dir });
      const set = await collectImplementationFiles(ctxWith(['src/a.ts']), dir);
      // A clean tree is a RESULT. Reporting it as a failed scan would send a human
      // looking at git instead of at the implementation step.
      expect(set.scanError).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('assertReviewableChange', () => {
  it('passes a set that names at least one file', () => {
    expect(() =>
      assertReviewableChange('08c-code-review', {
        files: ['src/a.ts'],
        total: 1,
        truncated: false,
      }),
    ).not.toThrow();
  });

  it('passes a set with files even when the worktree scan failed', () => {
    // The other sources answered, so the step has a change set to review. A failed scan
    // is only fatal when it left nothing behind.
    expect(() =>
      assertReviewableChange('08c-code-review', {
        files: ['src/a.ts'],
        total: 1,
        truncated: false,
        scanError: 'fatal: not a git repository',
      }),
    ).not.toThrow();
  });

  it('refuses an empty set and says the implementation changed nothing', () => {
    // The hole this closes: an empty list used to render a prompt fallback telling the
    // agent to work the change out from the workspace. It cannot — git is masked inside
    // the sandbox — so it guessed, and reviewed the whole repository.
    expect(() =>
      assertReviewableChange('08c-code-review', {
        files: [],
        total: 0,
        truncated: false,
        scanError: null,
      }),
    ).toThrow(
      /08c-code-review has no changed files to review: the implementation changed no files/,
    );
  });

  it("names git's own error when the scan is why the set is empty", () => {
    // Two different facts, two different diagnoses: a poisoned worktree is not an
    // implementation that wrote nothing, and the diagnosis is what the human acts on.
    let message = '';
    try {
      assertReviewableChange('07b-phase-4-validate', {
        files: [],
        total: 0,
        truncated: false,
        scanError: 'fatal: not a git repository (or any parent up to mount point /)',
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('the worktree scan failed');
    expect(message).toContain('fatal: not a git repository');
    expect(message).not.toContain('changed no files');
  });

  it('refuses an empty replayed pre-coverage array with the neutral wording', () => {
    // A bare array is a file list too, and an empty one is the same hole. It carries no
    // scan record, so it must not claim anything about git that nothing observed.
    let message = '';
    try {
      assertReviewableChange('08d-adversarial-qa', []);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('the implementation changed no files');
    expect(message).not.toContain('worktree scan failed');
  });

  it('refuses a missing set outright', () => {
    expect(() => assertReviewableChange('08c2-code-audit', undefined)).toThrow(
      /no changed files to review/,
    );
  });
});

describe('NO_CHANGE_SET_FALLBACK', () => {
  it('never asks the agent to work the change out for itself', () => {
    // The exact instruction that was there before, and the reason this constant exists.
    expect(NO_CHANGE_SET_FALLBACK).not.toMatch(/determine the (recently-)?changed files/i);
    expect(NO_CHANGE_SET_FALLBACK).toContain('Do NOT try to work out what changed');
    // ...and it must not let the resulting review read as an approval.
    expect(NO_CHANGE_SET_FALLBACK).toContain('do NOT report a clean result');
  });
});

describe('parseChangedLineRanges', () => {
  const diff = (...lines: string[]) => lines.join('\n');

  it('reads the NEW-side span of each hunk, which is how the agent will read the file', () => {
    // The + side, not the - side: the reviewer opens the file as it is now, so pre-change
    // numbering would point at the wrong lines.
    const notes = parseChangedLineRanges(
      diff(
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -10,2 +12,5 @@',
        '+one',
        '@@ -40,0 +45,1 @@',
        '+two',
      ),
    );
    expect(notes['src/a.ts']).toBe('lines 12-16, 45');
  });

  it('treats an omitted hunk count as one line', () => {
    // `@@ -1 +1 @@` is git's shorthand for a single-line hunk.
    const notes = parseChangedLineRanges(
      diff('diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1 +7 @@', '+x'),
    );
    expect(notes['x']).toBe('lines 7');
  });

  it('records a pure deletion as the line it happened at', () => {
    // A `+c,0` hunk has no new-side span at all. The line is where the removal sits, and
    // the prompt legend says a bare number can mean this.
    const notes = parseChangedLineRanges(
      diff('diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -20,3 +19,0 @@', '-gone'),
    );
    expect(notes['x']).toBe('lines 19');
  });

  it('names a deleted file from its old side, which is the only side it has', () => {
    // git emits `--- a/x` BEFORE `+++ /dev/null`, so the old path has to be carried
    // forward rather than looked for after the fact.
    const notes = parseChangedLineRanges(
      diff(
        'diff --git a/gone.ts b/gone.ts',
        'deleted file mode 100644',
        '--- a/gone.ts',
        '+++ /dev/null',
        '@@ -1,3 +0,0 @@',
        '-a',
      ),
    );
    expect(notes['gone.ts']).toBe('deleted');
  });

  it('keeps each file separate across a multi-file diff', () => {
    const notes = parseChangedLineRanges(
      diff(
        'diff --git a/one.ts b/one.ts',
        '--- a/one.ts',
        '+++ b/one.ts',
        '@@ -1,1 +1,2 @@',
        '+a',
        'diff --git a/two.ts b/two.ts',
        '--- a/two.ts',
        '+++ b/two.ts',
        '@@ -9,0 +30,3 @@',
        '+b',
      ),
    );
    expect(notes).toEqual({ 'one.ts': 'lines 1-2', 'two.ts': 'lines 30-32' });
  });

  it('states the cut when a file has more ranges than the cap', () => {
    // A cap that hides how much it removed is the failure MAX_LISTED_FILES already exists
    // to avoid; this one reports it the same way.
    const hunks = Array.from({ length: 25 }, (_, i) => `@@ -1,0 +${i * 10 + 1},1 @@`);
    const notes = parseChangedLineRanges(
      diff('diff --git a/big.ts b/big.ts', '--- a/big.ts', '+++ b/big.ts', ...hunks),
    );
    expect(notes['big.ts']).toContain('(+5 more ranges)');
    expect(notes['big.ts']!.startsWith('lines 1, 11, 21')).toBe(true);
  });

  it('says so when a diff entry has no hunks at all', () => {
    // A mode change or a pure rename. Distinct from a file nothing measured, which carries
    // no note and is treated as wholly in scope.
    const notes = parseChangedLineRanges(
      diff('diff --git a/x b/x', 'old mode 100644', 'new mode 100755', '--- a/x', '+++ b/x'),
    );
    expect(notes['x']).toBe('no line changes (mode or rename only)');
  });

  it('returns nothing for output it cannot read', () => {
    expect(parseChangedLineRanges('')).toEqual({});
    expect(parseChangedLineRanges('fatal: bad revision')).toEqual({});
  });
});

describe('changedFilesBlock — line notes', () => {
  const set = (files: string[], changedLines: Record<string, string>) => ({
    files,
    total: files.length,
    truncated: false,
    changedLines,
  });

  it('annotates each path with the lines the change wrote', () => {
    const block = changedFilesBlock(
      set(['src/a.ts', 'src/b.ts'], { 'src/a.ts': 'lines 12-18', 'src/b.ts': 'new file' }),
      'Changed files',
      'fallback',
    );
    expect(block).toContain('- src/a.ts — lines 12-18');
    expect(block).toContain('- src/b.ts — new file');
  });

  it('leaves an unmeasured path bare and says what that means', () => {
    // The load-bearing half: absent must read as "not recorded", never as "unchanged".
    // A reviewer that read it the other way would skip a file nobody measured.
    const block = changedFilesBlock(
      set(['measured.ts', 'unmeasured.ts'], { 'measured.ts': 'lines 3' }),
      'Changed files',
      'fallback',
    );
    expect(block).toContain('- unmeasured.ts\n');
    expect(block).not.toContain('- unmeasured.ts —');
    expect(block).toContain('has none recorded, so treat all of it as');
  });

  it('omits the legend entirely when nothing was measured', () => {
    const block = changedFilesBlock(set(['a.ts'], {}), 'Changed files', 'fallback');
    expect(block).toBe('Changed files:\n- a.ts');
  });

  it('carries the coverage notice alongside the legend when the list was also capped', () => {
    const block = changedFilesBlock(
      {
        files: names(100),
        total: 150,
        truncated: true,
        changedLines: { 'src/file-0.ts': 'lines 4' },
      },
      'Changed files',
      'fallback',
    );
    expect(block).toContain('LINES:');
    expect(block).toContain('COVERAGE: the list above is 100 of 150 changed files');
  });

  it('renders a replayed row that predates line notes exactly as it did before', () => {
    expect(changedFilesBlock(['a.ts'], 'Changed files', 'fallback')).toBe('Changed files:\n- a.ts');
  });
});

describe('collectImplementationFiles — line notes against a real repo', () => {
  const exec = promisify(execFile);
  const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@haive.local',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@haive.local',
  };
  const git = (dir: string, args: string[]) => exec('git', args, { cwd: dir, env: GIT_ENV });

  /** ctx answering both step lookups the collector makes, and a DAG issue list — the only
   *  file source left once the work is committed and the tree is clean. */
  function ctxFor(baseBranch: string | null, dagFiles: string[] = []): StepContextLike {
    loadPreviousStepOutput.mockImplementation(async (_db: unknown, _task: unknown, id: string) =>
      id === '01-worktree-setup' ? { output: { baseBranch } } : { output: { filesTouched: [] } },
    );
    return {
      taskId: 't1',
      db: {
        select: () => ({
          from: () => ({ where: () => Promise.resolve([{ filesModified: dagFiles }]) }),
        }),
      },
    } as unknown as StepContextLike;
  }

  /** A repo with one committed file, on a `task` branch forked from `main`. */
  async function setupRepo(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'impl-lines-'));
    await git(dir, ['init', '-b', 'main']);
    await writeFile(path.join(dir, 'app.ts'), 'a\nb\nc\nd\ne\n', 'utf8');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'base']);
    await git(dir, ['checkout', '-b', 'task']);
    return dir;
  }

  it('annotates uncommitted work — the single-agent path', async () => {
    const dir = await setupRepo();
    try {
      await writeFile(path.join(dir, 'app.ts'), 'a\nb\nCHANGED\nd\ne\n', 'utf8');
      await writeFile(path.join(dir, 'brand-new.ts'), 'fresh\n', 'utf8');
      const out = await collectImplementationFiles(ctxFor('main'), dir);
      expect(out.changedLines?.['app.ts']).toBe('lines 3');
      // An untracked file appears in no diff at all, so the note has to come from status.
      expect(out.changedLines?.['brand-new.ts']).toBe('new file');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('annotates COMMITTED work — the DAG path, where git diff HEAD is empty', async () => {
    // dag-executor commits every issue and merges it in, so by review time the tree is
    // clean and HEAD already contains the change. Diffing HEAD would report nothing; the
    // fork point is what recovers it.
    const dir = await setupRepo();
    try {
      await writeFile(path.join(dir, 'app.ts'), 'a\nb\nCHANGED\nd\ne\n', 'utf8');
      await git(dir, ['add', '-A']);
      await git(dir, ['commit', '-m', 'ISSUE-1: change it']);
      const clean = await git(dir, ['status', '--porcelain']);
      expect(clean.stdout.trim()).toBe('');

      const out = await collectImplementationFiles(ctxFor('main', ['app.ts']), dir);
      expect(out.files).toContain('app.ts');
      expect(out.changedLines?.['app.ts']).toBe('lines 3');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('records no note rather than a wrong one when the base branch is gone', async () => {
    // Falls back to HEAD, which on a committed change measures nothing. No note means the
    // whole file stays in scope — the behaviour that existed before notes did.
    const dir = await setupRepo();
    try {
      await writeFile(path.join(dir, 'app.ts'), 'a\nb\nCHANGED\nd\ne\n', 'utf8');
      await git(dir, ['add', '-A']);
      await git(dir, ['commit', '-m', 'committed']);
      const out = await collectImplementationFiles(ctxFor('no-such-branch', ['app.ts']), dir);
      expect(out.changedLines?.['app.ts']).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
