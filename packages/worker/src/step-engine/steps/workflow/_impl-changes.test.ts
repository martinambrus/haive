import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
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
  collectChangedLineMap,
  collectImplementationFiles,
  fileCoverage,
  isDocsOnlyChange,
  NO_CHANGE_SET_FALLBACK,
  parseChangedLineRanges,
  readChangedPaths,
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

  it('counts only the names a prompt can list, so a name left out reads as not covered', () => {
    expect(fileCoverage({ files: ['a.ts', 'b\nc.ts'], total: 2, truncated: false })).toEqual({
      listed: 1,
      total: 2,
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

  describe('a scan that failed', () => {
    const set = { files: ['a.ts', 'b.ts'], total: 2, truncated: false };

    it('is flagged, so a gate can tell a list from a failed scan from a complete one', () => {
      expect(fileCoverage({ ...set, scanError: 'git failed' })).toEqual({
        listed: 2,
        total: 2,
        truncated: false,
        scanFailed: true,
      });
    });

    it('is flagged alongside the cap when the list was cut too', () => {
      expect(
        fileCoverage({ files: names(100), total: 150, truncated: true, scanError: 'git failed' }),
      ).toEqual({ listed: 100, total: 150, truncated: true, scanFailed: true });
    });

    it.each([null, undefined])(
      'leaves the flag off where the scan ran (scanError %s)',
      (scanError) => {
        const covered = fileCoverage({ ...set, scanError });
        expect(covered).toEqual({ listed: 2, total: 2, truncated: false });
        expect('scanFailed' in covered!).toBe(false);
      },
    );
  });
});

describe('changedFilesBlock', () => {
  it('lists a file named like an Object member without a note it never had', () => {
    const block = changedFilesBlock(
      { files: ['constructor', 'toString'], total: 2, truncated: false, changedLines: {} },
      'Changed files',
      'fallback',
    );
    expect(block.split('\n')).toEqual(expect.arrayContaining(['- constructor', '- toString']));
    expect(block).not.toContain('native code');
  });

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

  describe('a scan that failed', () => {
    const set = { files: ['src/a.ts', 'src/b.ts'], total: 2, truncated: false };
    const COVERAGE = [
      'COVERAGE: the change could not be read in full, so the list above may be missing files of it.',
      'Any it lacks were NOT given to you and you cannot see them. Work from what is listed, and',
      'state plainly in your output that coverage is incomplete — do NOT report a clean result as',
      'though it covered the whole change.',
    ].join('\n');
    const block = (value: Parameters<typeof changedFilesBlock>[0]) =>
      changedFilesBlock(value, 'Changed files', 'fallback');

    it('adds one COVERAGE paragraph after the list, which orders the agent to say so', () => {
      expect(block({ ...set, scanError: 'git failed' })).toBe(
        `Changed files:\n- src/a.ts\n- src/b.ts\n\n${COVERAGE}`,
      );
    });

    it('renders a set whose scan ran exactly as a set that never recorded it', () => {
      expect(block({ ...set, scanError: null })).toBe(block(set));
      expect(block({ ...set, scanError: undefined })).toBe(block(set));
      expect(block(set)).toBe('Changed files:\n- src/a.ts\n- src/b.ts');
    });

    it('puts it after the notices for a cut list and for names left out', () => {
      const out = block({
        files: [...names(98), 'x=====y.ts', 'ok.ts'],
        total: 160,
        truncated: true,
        scanError: 'git failed',
      });
      const cap = out.indexOf('COVERAGE: the list above is');
      const unlistable = out.indexOf('names that cannot be listed safely');
      const scan = out.indexOf('COVERAGE: the change could not be read in full');
      expect(cap).toBeGreaterThan(-1);
      expect(unlistable).toBeGreaterThan(cap);
      expect(scan).toBeGreaterThan(unlistable);
      expect(out.endsWith(COVERAGE)).toBe(true);
    });

    it("never writes the scan's own error onto a prompt line", () => {
      expect(
        block({ ...set, scanError: 'fatal: /secret/repo/path is not a repository' }),
      ).not.toContain('secret');
    });

    it('has no list to put it after when the set is empty, which the callers refuse before they render', () => {
      expect(block({ files: [], total: 0, truncated: false, scanError: 'git failed' })).toBe(
        'fallback',
      );
    });
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

  it('is false when the scan of the dirty worktree failed, even when every listed file is documentation', () => {
    // The files the scan would have named are unknown, so the rest being documents proves nothing.
    expect(
      isDocsOnlyChange({ ...set(['README.md']), scanError: 'fatal: not a git repository' }),
    ).toBe(false);
  });

  it('is false for the list a failed scan produced', async () => {
    const failed = await collectImplementationFiles(
      ctxWith(['README.md']),
      '/nonexistent-worktree',
    );
    expect(failed.files).toEqual(['README.md']);
    expect(failed.scanError).toBeTruthy();
    expect(isDocsOnlyChange(failed)).toBe(false);
  });

  it('is true when the scan ran and every listed file is documentation', () => {
    expect(isDocsOnlyChange({ ...set(['README.md']), scanError: null })).toBe(true);
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
      const identity = ['-c', 'user.name=T', '-c', 'user.email=t@haive.local', '-c', 'gc.auto=0'];
      await exec2('git', [...identity, 'commit', '--allow-empty', '-m', 'base'], { cwd: dir });
      const ctx = ctxWith(['src/a.ts']);
      // Every step lookup gets this one output, so it also records the fork point the committed half needs.
      loadPreviousStepOutput.mockResolvedValue({
        output: { filesTouched: ['src/a.ts'], baseBranch: 'main' },
      });
      const set = await collectImplementationFiles(ctx, dir);
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

  it('renders the capped string exactly, now that the ranges behind it are kept uncapped', () => {
    const hunks = Array.from({ length: 25 }, (_, i) => `@@ -1,0 +${i * 10 + 1},1 @@`);
    const notes = parseChangedLineRanges(
      diff('diff --git a/big.ts b/big.ts', '--- a/big.ts', '+++ b/big.ts', ...hunks),
    );
    const listed = Array.from({ length: 20 }, (_, i) => i * 10 + 1).join(', ');
    expect(notes['big.ts']).toBe(`lines ${listed} (+5 more ranges)`);
  });

  it('says so when a diff entry has no hunks at all', () => {
    // A mode change or a pure rename. Distinct from a file nothing measured, which carries
    // no note and is treated as wholly in scope.
    const notes = parseChangedLineRanges(
      diff('diff --git a/x b/x', 'old mode 100644', 'new mode 100755', '--- a/x', '+++ b/x'),
    );
    expect(notes['x']).toBe('no line changes (mode or rename only)');
  });

  // A removed `-- x` reads `--- x` in a diff, and an added `++ x` reads `+++ x`.
  it('reads a removed `-- x` line as hunk content, not as the old-side header', () => {
    const notes = parseChangedLineRanges(
      diff(
        'diff --git a/q.sql b/q.sql',
        '--- a/q.sql',
        '+++ b/q.sql',
        '@@ -3 +2,0 @@ select 2;',
        '--- sql comment',
        '@@ -9,0 +9,2 @@',
        '+a',
        '+b',
        'diff --git a/other.sql b/other.sql',
        '--- a/other.sql',
        '+++ b/other.sql',
        '@@ -1 +1 @@',
        '+x',
      ),
    );
    expect(notes).toEqual({ 'q.sql': 'lines 2, 9-10', 'other.sql': 'lines 1' });
  });

  it.each([
    ['text', '+++ added'],
    ['text that reads like the null device', '+++ /dev/null'],
  ])(
    'reads an added `++ x` line (%s) as hunk content, not as the new-side header',
    (_name, line) => {
      const notes = parseChangedLineRanges(
        diff(
          'diff --git a/q.sql b/q.sql',
          '--- a/q.sql',
          '+++ b/q.sql',
          '@@ -5,0 +5 @@ select 4;',
          line,
          'diff --git a/other.sql b/other.sql',
          '--- a/other.sql',
          '+++ b/other.sql',
          '@@ -1 +1 @@',
          '+x',
        ),
      );
      expect(notes).toEqual({ 'q.sql': 'lines 5', 'other.sql': 'lines 1' });
    },
  );

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

describe('changedFilesBlock — names that span lines', () => {
  const set = (files: string[], total = files.length) => ({
    files,
    total,
    truncated: total > files.length,
  });
  const SPANNING = ['a\nb.php', 'a\rb.php', 'a\u0085b.php', 'a b.php'];
  const listed = (block: string) => block.split('\n').filter((line) => line.startsWith('- '));

  it('leaves out every name that holds a line break and counts them', () => {
    const block = changedFilesBlock(set(['ok.php', ...SPANNING]), 'Changed files', 'fallback');

    expect(listed(block)).toEqual(['- ok.php']);
    expect(block).toContain('COVERAGE: 4 changed files have names that cannot be listed safely');
    expect(block).toContain('clean result');
  });

  it('keeps a name holding a tab, which cannot start a line', () => {
    const block = changedFilesBlock(set(['ok.php', 'a\tb.php']), 'Changed files', 'fallback');

    expect(listed(block)).toEqual(['- ok.php', '- a\tb.php']);
    expect(block).not.toContain('COVERAGE');
  });

  it('filters a replayed pre-coverage row the same way', () => {
    const block = changedFilesBlock(['ok.php', ...SPANNING], 'Changed files', 'fallback');

    expect(listed(block)).toEqual(['- ok.php']);
    expect(block).toContain('COVERAGE: 4 changed files have names that cannot be listed safely');
  });

  it('states the cap and the names left out as two shortfalls of one list', () => {
    const block = changedFilesBlock(
      set([...names(98), 'a\nb.php', 'c\nd.php'], 150),
      'Changed files',
      'fallback',
    );

    expect(block).toContain('COVERAGE: the list above is 98 of 150 changed files');
    expect(block).toContain('52 were NOT given to you');
    expect(block).toContain('COVERAGE: 2 changed files have names that cannot be listed safely');
  });

  it('still says what it left out when no name can be listed, rather than answering the fallback', () => {
    const block = changedFilesBlock(set(['a\nb.php', 'c\nd.php']), 'Changed files', 'fallback');

    expect(block).not.toContain('fallback');
    expect(listed(block)).toEqual([]);
    expect(block).toContain('COVERAGE: 2 changed files have names that cannot be listed safely');
  });
});

describe('changedFilesBlock — names that would forge the fence', () => {
  const set = (files: string[]) => ({ files, total: files.length, truncated: false });
  const FORGING = ['x=====y.php', 'a====b.php', '=====.php', 'trailing====='];
  const listed = (block: string) => block.split('\n').filter((line) => line.startsWith('- '));

  it('leaves out every name holding a run of four equals signs and counts them', () => {
    const block = changedFilesBlock(set(['ok.php', ...FORGING]), 'Changed files', 'fallback');

    expect(listed(block)).toEqual(['- ok.php']);
    expect(block).toContain('COVERAGE: 4 changed files have names that cannot be listed safely');
    expect(block).toContain('clean result');
  });

  it('keeps a name with a shorter run, which the fence leaves alone', () => {
    const block = changedFilesBlock(set(['a=b.php', 'a===b.php']), 'Changed files', 'fallback');

    expect(listed(block)).toEqual(['- a=b.php', '- a===b.php']);
    expect(block).not.toContain('COVERAGE');
  });

  it('counts a name that is both multi-line and forging once', () => {
    const block = changedFilesBlock(set(['ok.php', 'a\n=====b.php']), 'Changed files', 'fallback');

    expect(listed(block)).toEqual(['- ok.php']);
    expect(block).toContain('COVERAGE: 1 changed files have names that cannot be listed safely');
  });

  it('filters a replayed pre-coverage row the same way', () => {
    const block = changedFilesBlock(['ok.php', ...FORGING], 'Changed files', 'fallback');

    expect(listed(block)).toEqual(['- ok.php']);
    expect(block).toContain('COVERAGE: 4 changed files have names that cannot be listed safely');
  });

  it('reads as not covered in the record a gate keeps', () => {
    expect(fileCoverage(set(['ok.php', 'x=====y.php']))).toEqual({
      listed: 1,
      total: 2,
      truncated: true,
    });
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

describe('collectChangedLineMap', () => {
  const exec = promisify(execFile);
  const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@haive.local',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@haive.local',
  };
  const git = (dir: string, args: string[]) => exec('git', args, { cwd: dir, env: GIT_ENV });

  /** The agents' own account of the change: 07's `filesTouched`, else the DAG issues' files. */
  function ctxFor(
    reported: { touched?: string[]; dag?: string[] } = {},
    baseBranch: string | null = 'main',
  ): StepContextLike {
    loadPreviousStepOutput.mockImplementation(async (_db: unknown, _task: unknown, id: string) =>
      id === '01-worktree-setup'
        ? { output: { baseBranch } }
        : { output: { filesTouched: reported.touched ?? [] } },
    );
    return {
      taskId: 't1',
      db: {
        select: () => ({
          from: () => ({ where: () => Promise.resolve([{ filesModified: reported.dag ?? [] }]) }),
        }),
      },
    } as unknown as StepContextLike;
  }

  /** A repo with `files` committed on `main`, and a `task` branch forked from it. */
  async function inRepo(
    files: Record<string, string | Buffer>,
    run: (dir: string) => Promise<void>,
  ): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), 'impl-map-'));
    try {
      await git(dir, ['init', '-b', 'main']);
      await git(dir, ['config', 'gc.auto', '0']);
      for (const [name, content] of Object.entries(files)) {
        await writeFile(path.join(dir, name), content);
      }
      await git(dir, ['add', '-A']);
      await git(dir, ['commit', '-m', 'base']);
      await git(dir, ['checkout', '-b', 'task']);
      await run(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Names `git status` C-quotes unless it runs with `-z`: a non-ASCII byte, a space, a quote. */
  const QUOTED_NAMES = ['café.php', 'has space.php', 'a"b.php'];

  it('keeps every hunk, where the prompt notes stop at 20', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `l${i}`);
    await inRepo({ 'app.php': `${lines.join('\n')}\n` }, async (dir) => {
      const edited = lines.map((l, i) => (i % 2 === 0 ? `${l}!` : l));
      await writeFile(path.join(dir, 'app.php'), `${edited.join('\n')}\n`);

      const map = await collectChangedLineMap(ctxFor(), dir);

      const app = map?.get('app.php');
      expect(app?.whole).toBe(false);
      expect(app?.ranges).toHaveLength(25);
      expect(app?.ranges[0]).toEqual([1, 1]);
      expect(app?.ranges[24]).toEqual([49, 49]);
      const notes = await collectImplementationFiles(ctxFor(), dir);
      expect(notes.changedLines?.['app.php']).toContain('(+5 more ranges)');
    });
  });

  it('covers the line a pure deletion sits after and the line after it', async () => {
    await inRepo({ 'app.php': 'a\nb\nc\nd\ne\n' }, async (dir) => {
      await writeFile(path.join(dir, 'app.php'), 'a\nb\nd\ne\n');

      const map = await collectChangedLineMap(ctxFor(), dir);

      expect(map?.get('app.php')).toEqual({ whole: false, ranges: [[2, 3]] });
    });
  });

  it('counts an untracked file whole, since no diff has an old side for it', async () => {
    await inRepo({ 'app.php': 'a\n' }, async (dir) => {
      await writeFile(path.join(dir, 'brand-new.php'), 'fresh\n');

      const map = await collectChangedLineMap(ctxFor(), dir);

      expect(map?.get('brand-new.php')).toEqual({ whole: true, ranges: [] });
    });
  });

  it('reads a file only the diff names, from committed work with a clean tree', async () => {
    await inRepo({ 'app.php': 'a\nb\nc\nd\ne\n' }, async (dir) => {
      await writeFile(path.join(dir, 'app.php'), 'a\nb\nCHANGED\nd\ne\n');
      await git(dir, ['add', '-A']);
      await git(dir, ['commit', '-m', 'ISSUE-1: change it']);

      const map = await collectChangedLineMap(ctxFor(), dir);

      expect(map?.get('app.php')).toEqual({ whole: false, ranges: [[3, 3]] });
    });
  });

  it('counts whole a file git status or an agent names but the diff has no lines for', async () => {
    await inRepo({ 'app.php': 'a\nb\n', 'logo.png': Buffer.from([0, 1, 2, 3]) }, async (dir) => {
      await writeFile(path.join(dir, 'app.php'), 'a\nB\n');
      await writeFile(path.join(dir, 'logo.png'), Buffer.from([0, 9, 2, 3]));

      const map = await collectChangedLineMap(ctxFor({ touched: ['reported.php'] }), dir);

      expect(map?.get('app.php')).toEqual({ whole: false, ranges: [[2, 2]] });
      expect(map?.get('logo.png')).toEqual({ whole: true, ranges: [] });
      expect(map?.get('reported.php')).toEqual({ whole: true, ranges: [] });
      const dag = await collectChangedLineMap(ctxFor({ dag: ['dag-reported.php'] }), dir);
      expect(dag?.get('dag-reported.php')).toEqual({ whole: true, ranges: [] });
    });
  });

  it('counts whole a committed binary change, which the diff prints no header for', async () => {
    await inRepo({ 'my blob.php': Buffer.from([0, 1, 2, 3]), 'app.php': 'a\nb\n' }, async (dir) => {
      await writeFile(path.join(dir, 'my blob.php'), Buffer.from([0, 9, 2, 3]));
      await writeFile(path.join(dir, 'app.php'), 'a\nB\n');
      await git(dir, ['add', '-A']);
      await git(dir, ['commit', '-m', 'ISSUE-1: change it']);
      const clean = await git(dir, ['status', '--porcelain']);
      expect(clean.stdout.trim()).toBe('');

      const map = await collectChangedLineMap(ctxFor(), dir);

      expect(map?.get('my blob.php')).toEqual({ whole: true, ranges: [] });
      expect(map?.get('app.php')).toEqual({ whole: false, ranges: [[2, 2]] });
    });
  });

  it('counts whole a committed mode-only change, which the diff prints no hunk for', async () => {
    await inRepo({ 'app.php': 'a\nb\n' }, async (dir) => {
      await chmod(path.join(dir, 'app.php'), 0o755);
      await git(dir, ['add', '-A']);
      await git(dir, ['commit', '-m', 'ISSUE-1: make it executable']);

      const map = await collectChangedLineMap(ctxFor(), dir);

      expect(map?.get('app.php')).toEqual({ whole: true, ranges: [] });
    });
  });

  it('counts whole a binary change still in the working tree', async () => {
    await inRepo({ 'blob.php': Buffer.from([0, 1, 2, 3]) }, async (dir) => {
      await writeFile(path.join(dir, 'blob.php'), Buffer.from([0, 9, 2, 3]));

      const map = await collectChangedLineMap(ctxFor(), dir);

      expect(map?.get('blob.php')).toEqual({ whole: true, ranges: [] });
    });
  });

  it('leaves a deleted file out and keeps the files around it', async () => {
    await inRepo({ 'gone.php': 'x\n', 'kept.php': 'a\nb\n' }, async (dir) => {
      await rm(path.join(dir, 'gone.php'));
      await writeFile(path.join(dir, 'kept.php'), 'a\nB\n');

      const map = await collectChangedLineMap(ctxFor(), dir);

      expect(map?.has('gone.php')).toBe(false);
      expect(map?.get('kept.php')?.ranges).toEqual([[2, 2]]);
    });
  });

  it('leaves a committed deletion out, binary or text, and keeps the files around it', async () => {
    await inRepo(
      { 'gone.php': 'x\n', 'gone-blob.php': Buffer.from([0, 1, 2, 3]), 'kept.php': 'a\nb\n' },
      async (dir) => {
        await rm(path.join(dir, 'gone.php'));
        await rm(path.join(dir, 'gone-blob.php'));
        await writeFile(path.join(dir, 'kept.php'), 'a\nB\n');
        await git(dir, ['add', '-A']);
        await git(dir, ['commit', '-m', 'ISSUE-1: change it']);

        const map = await collectChangedLineMap(ctxFor(), dir);

        expect(map?.has('gone.php')).toBe(false);
        expect(map?.has('gone-blob.php')).toBe(false);
        expect(map?.get('kept.php')?.ranges).toEqual([[2, 2]]);
      },
    );
  });

  it('keeps the real file and its hunks when a removed `-- x` or added `++ x` line reads like a header', async () => {
    const before = 'select 1;\nselect 2;\n-- sql comment\nselect 3;\nselect 4;\n';
    await inRepo({ 'q.sql': before }, async (dir) => {
      await writeFile(
        path.join(dir, 'q.sql'),
        'select 1;\nselect 2;\nselect 3;\nselect 4;\n++ x\n',
      );
      await git(dir, ['add', '-A']);
      await git(dir, ['commit', '-m', 'ISSUE-1: change it']);

      const map = await collectChangedLineMap(ctxFor(), dir);

      expect([...(map?.keys() ?? [])]).toEqual(['q.sql']);
      expect(map?.get('q.sql')).toEqual({
        whole: false,
        ranges: [
          [2, 3],
          [5, 5],
        ],
      });
    });
  });

  it('is null when nothing names a changed file', async () => {
    await inRepo({ 'app.php': 'a\n' }, async (dir) => {
      expect(await collectChangedLineMap(ctxFor(), dir)).toBeNull();
    });
  });

  it('is null when git status cannot run, whatever the agents reported', async () => {
    const map = await collectChangedLineMap(
      ctxFor({ touched: ['app.php'] }),
      '/nonexistent-worktree',
    );
    expect(map).toBeNull();
  });

  it('is null when no diff base resolves, since no committed file could be named', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'impl-map-'));
    try {
      await git(dir, ['init', '-b', 'main']);
      await git(dir, ['config', 'gc.auto', '0']);
      await writeFile(path.join(dir, 'brand-new.php'), 'fresh\n');

      expect(await collectChangedLineMap(ctxFor(), dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads the diff when the base falls back to HEAD and a root file is named HEAD', async () => {
    await inRepo({ 'app.php': 'a\nb\n', HEAD: 'x\n' }, async (dir) => {
      await git(dir, ['branch', '-D', 'main']);
      await writeFile(path.join(dir, 'app.php'), 'a\nB\n');

      const map = await collectChangedLineMap(ctxFor(), dir);

      expect(map?.get('app.php')).toEqual({ whole: false, ranges: [[2, 2]] });
    });
  });

  it('is null when the diff quotes a path, which would never match a tool report', async () => {
    await inRepo({ 'a"b.php': 'a\n' }, async (dir) => {
      await writeFile(path.join(dir, 'a"b.php'), 'b\n');

      expect(await collectChangedLineMap(ctxFor(), dir)).toBeNull();
    });
  });

  it.each(['café.php', 'has space.php'])(
    'reads the edited %s under its literal name, which is how a tool reports it',
    async (name) => {
      await inRepo({ [name]: 'a\nb\n' }, async (dir) => {
        await writeFile(path.join(dir, name), 'a\nB\n');

        const map = await collectChangedLineMap(ctxFor(), dir);

        expect(map?.get(name)).toEqual({ whole: false, ranges: [[2, 2]] });
      });
    },
  );

  it.each([...QUOTED_NAMES, '"lead".php'])(
    'counts the untracked %s whole, under its literal name',
    async (name) => {
      await inRepo({ 'kept.php': 'a\n' }, async (dir) => {
        await writeFile(path.join(dir, name), 'fresh\n');

        const map = await collectChangedLineMap(ctxFor(), dir);

        expect(map?.get(name)).toEqual({ whole: true, ranges: [] });
      });
    },
  );

  describe('readChangedPaths', () => {
    const base = { 'kept.php': 'a\nb\n', 'gone.php': 'x\n', 'gone-in-commit.php': 'y\n' };

    async function removeTwoAndEditOne(dir: string): Promise<void> {
      await rm(path.join(dir, 'gone-in-commit.php'));
      await git(dir, ['add', '-A']);
      await git(dir, ['commit', '-m', 'ISSUE-1: remove it']);
      await rm(path.join(dir, 'gone.php'));
      await writeFile(path.join(dir, 'kept.php'), 'a\nB\n');
    }

    it('leaves a deleted path out, committed or removed from the working tree', async () => {
      await inRepo(base, async (dir) => {
        await removeTwoAndEditOne(dir);

        expect(await readChangedPaths(dir, 'main')).toEqual(['kept.php']);
      });
    });

    it('names a deleted path, committed or removed from the working tree, when asked', async () => {
      await inRepo(base, async (dir) => {
        await removeTwoAndEditOne(dir);

        const paths = await readChangedPaths(dir, 'main', { includeDeleted: true });

        expect([...(paths ?? [])].sort()).toEqual(['gone-in-commit.php', 'gone.php', 'kept.php']);
      });
    });
  });

  describe('collectImplementationFiles — committed deletions', () => {
    async function commitRemoval(dir: string, name = 'gone.php'): Promise<void> {
      await rm(path.join(dir, name));
      await git(dir, ['add', '-A']);
      await git(dir, ['commit', '-m', 'ISSUE-1: remove it']);
      const clean = await git(dir, ['status', '--porcelain']);
      expect(clean.stdout.trim()).toBe('');
    }

    it('lists a deletion nobody reported, with its note, and counts it', async () => {
      await inRepo({ 'gone.php': 'x\n', 'kept.php': 'a\n' }, async (dir) => {
        await commitRemoval(dir);

        const out = await collectImplementationFiles(ctxFor(), dir);

        expect(out.files).toEqual(['gone.php']);
        expect(out.total).toBe(1);
        expect(out.truncated).toBe(false);
        expect(out.changedLines).toEqual({ 'gone.php': 'deleted' });
      });
    });

    it.each([
      ['07 reported it', { touched: ['gone.php'] }],
      ['a DAG issue reported it', { dag: ['gone.php'] }],
    ])('lists a deletion once when %s too', async (_who, reported) => {
      await inRepo({ 'gone.php': 'x\n' }, async (dir) => {
        await commitRemoval(dir);

        const out = await collectImplementationFiles(ctxFor(reported), dir);

        expect(out.files).toEqual(['gone.php']);
        expect(out.total).toBe(1);
        expect(out.changedLines).toEqual({ 'gone.php': 'deleted' });
      });
    });

    it.each([
      ['a binary file', 'gone.bin', Buffer.from([0, 1, 2, 3])],
      ['an empty file', 'empty.php', ''],
    ])(
      'lists the deletion of %s, which the diff prints no header for, once and with its note',
      async (_what, name, content) => {
        await inRepo({ [name]: content, 'kept.php': 'a\n' }, async (dir) => {
          await commitRemoval(dir, name);

          for (const reported of [{}, { touched: [name] }]) {
            const out = await collectImplementationFiles(ctxFor(reported), dir);

            expect(out.files).toEqual([name]);
            expect(out.total).toBe(1);
            expect(out.changedLines).toEqual({ [name]: 'deleted' });
          }
        });
      },
    );

    it.each(['has"quote.php', 'café.php'])(
      'lists the committed deletion of %s once, under its literal spelling, with its note',
      async (name) => {
        await inRepo({ [name]: 'x\n', 'kept.php': 'a\n' }, async (dir) => {
          await commitRemoval(dir, name);

          const out = await collectImplementationFiles(ctxFor(), dir);

          expect(out.files).toEqual([name]);
          expect(out.total).toBe(1);
          expect(out.changedLines).toEqual({ [name]: 'deleted' });
        });
      },
    );

    it('lists a renamed file by its old name, and a deletion after it, since renames are not paired', async () => {
      await inRepo({ 'a-old.php': 'one\ntwo\n', 'z-gone.php': 'x\n' }, async (dir) => {
        await git(dir, ['mv', 'a-old.php', 'a-new.php']);
        await rm(path.join(dir, 'z-gone.php'));
        await git(dir, ['add', '-A']);
        await git(dir, ['commit', '-m', 'ISSUE-1: move one, remove one']);
        const clean = await git(dir, ['status', '--porcelain']);
        expect(clean.stdout.trim()).toBe('');

        const out = await collectImplementationFiles(ctxFor(), dir);

        expect(out.files).toEqual(expect.arrayContaining(['a-old.php', 'z-gone.php']));
      });
    });

    it('lists a committed deletion in a tree that holds a file named HEAD', async () => {
      await inRepo({ HEAD: 'x\n', 'gone.php': 'y\n' }, async (dir) => {
        await commitRemoval(dir);

        const out = await collectImplementationFiles(ctxFor(), dir);

        expect(out.files).toEqual(['gone.php']);
      });
    });

    it('lists a modification nobody reported after the deletion beside it', async () => {
      await inRepo({ 'gone.php': 'x\n', 'app.php': 'a\nb\nc\n' }, async (dir) => {
        await writeFile(path.join(dir, 'app.php'), 'a\nB\nc\n');
        await commitRemoval(dir);

        const out = await collectImplementationFiles(ctxFor(), dir);

        expect(out.files).toEqual(['gone.php', 'app.php']);
        expect(out.total).toBe(2);
      });
    });

    it('lists a removal still in the working tree once', async () => {
      await inRepo({ 'gone.php': 'x\n', 'kept.php': 'a\n' }, async (dir) => {
        await rm(path.join(dir, 'gone.php'));

        const out = await collectImplementationFiles(ctxFor(), dir);

        expect(out.files).toEqual(['gone.php']);
        expect(out.total).toBe(1);
        expect(out.changedLines).toEqual({ 'gone.php': 'deleted' });
      });
    });

    it.each(['has"quote.php', 'café.php'])(
      'lists an uncommitted removal of %s once: git status names it and the committed diff cannot',
      async (name) => {
        await inRepo({ [name]: 'x\n', 'kept.php': 'a\n' }, async (dir) => {
          await rm(path.join(dir, name));

          const out = await collectImplementationFiles(ctxFor(), dir);

          expect(out.files).toHaveLength(1);
          expect(out.total).toBe(1);
        });
      },
    );

    it('counts a deletion toward the cap like any other changed file', async () => {
      await inRepo({ 'gone.php': 'x\n' }, async (dir) => {
        await commitRemoval(dir);

        const out = await collectImplementationFiles(ctxFor({ touched: names(100) }), dir);

        expect(out.files).toHaveLength(100);
        expect(out.total).toBe(101);
        expect(out.truncated).toBe(true);
      });
    });
  });

  describe('collectImplementationFiles — committed edits', () => {
    async function commitAll(dir: string): Promise<void> {
      await git(dir, ['add', '-A']);
      await git(dir, ['commit', '-m', 'ISSUE-1: change it']);
      const clean = await git(dir, ['status', '--porcelain']);
      expect(clean.stdout.trim()).toBe('');
    }

    it('lists an edit nobody reported, with its note, when the work is committed and the tree is clean', async () => {
      await inRepo({ 'app.php': 'a\nb\nc\n' }, async (dir) => {
        await writeFile(path.join(dir, 'app.php'), 'a\nB\nc\n');
        await commitAll(dir);

        const out = await collectImplementationFiles(ctxFor(), dir);

        expect(out.files).toEqual(['app.php']);
        expect(out.total).toBe(1);
        expect(out.truncated).toBe(false);
        expect(out.changedLines).toEqual({ 'app.php': 'lines 2' });
      });
    });

    it('lists a committed binary change and a committed mode change, which the diff prints no header for', async () => {
      await inRepo(
        { 'logo.png': Buffer.from([0, 1, 2, 3]), 'run.sh': 'echo hi\n' },
        async (dir) => {
          await writeFile(path.join(dir, 'logo.png'), Buffer.from([0, 9, 2, 3]));
          await chmod(path.join(dir, 'run.sh'), 0o755);
          await commitAll(dir);

          const out = await collectImplementationFiles(ctxFor(), dir);

          expect([...out.files].sort()).toEqual(['logo.png', 'run.sh']);
          expect(out.total).toBe(2);
        },
      );
    });

    it.each([
      ['07 reported it', { touched: ['app.php'] }],
      ['a DAG issue reported it', { dag: ['app.php'] }],
    ])('lists an edit once when %s and it is dirty again', async (_who, reported) => {
      await inRepo({ 'app.php': 'a\nb\nc\n' }, async (dir) => {
        await writeFile(path.join(dir, 'app.php'), 'a\nB\nc\n');
        await commitAll(dir);
        await writeFile(path.join(dir, 'app.php'), 'a\nB\nC\n');

        const out = await collectImplementationFiles(ctxFor(reported), dir);

        expect(out.files).toEqual(['app.php']);
        expect(out.total).toBe(1);
      });
    });

    it('lists the reported files first, then the dirty ones, the deletions, and last the committed edits', async () => {
      await inRepo(
        { 'gone.php': 'x\n', 'edited.php': 'a\nb\n', 'dirty.php': 'a\nb\n' },
        async (dir) => {
          await rm(path.join(dir, 'gone.php'));
          await writeFile(path.join(dir, 'edited.php'), 'a\nB\n');
          await commitAll(dir);
          await writeFile(path.join(dir, 'dirty.php'), 'a\nB\n');

          const out = await collectImplementationFiles(ctxFor({ touched: ['reported.php'] }), dir);

          expect(out.files).toEqual(['reported.php', 'dirty.php', 'gone.php', 'edited.php']);
          expect(out.total).toBe(4);
        },
      );
    });

    it('counts an unreported dirty file once, whichever spelling git gives its name', async () => {
      await inRepo({ 'has space.php': 'a\n' }, async (dir) => {
        await writeFile(path.join(dir, 'has space.php'), 'b\n');

        const out = await collectImplementationFiles(ctxFor(), dir);

        expect(out.total).toBe(1);
      });
    });

    it.each([
      ['café.php', 'lines 1-2'],
      ['has space.php', 'lines 1-2'],
      ['a"b.php', undefined],
    ])(
      'lists %s once, under its literal name, when it is committed and dirty again',
      async (name, note) => {
        await inRepo({ 'kept.php': 'a\n' }, async (dir) => {
          await writeFile(path.join(dir, name), 'a\nb\n');
          await commitAll(dir);
          await writeFile(path.join(dir, name), 'a\nB\n');

          const out = await collectImplementationFiles(ctxFor(), dir);

          expect(out.files).toEqual([name]);
          expect(out.total).toBe(1);
          expect(out.changedLines?.[name]).toBe(note);
        });
      },
    );

    it.each(QUOTED_NAMES)(
      'notes the untracked %s as a new file, under its literal name',
      async (name) => {
        await inRepo({ 'kept.php': 'a\n' }, async (dir) => {
          await writeFile(path.join(dir, name), 'fresh\n');

          const out = await collectImplementationFiles(ctxFor(), dir);

          expect(out.files).toEqual([name]);
          expect(out.changedLines).toEqual({ [name]: 'new file' });
        });
      },
    );

    it.each(['plain.php', 'café.php', 'x -> y.php'])(
      'lists the destination of a staged rename to %s, and not its source',
      async (to) => {
        await inRepo({ 'old name.php': 'one\ntwo\n' }, async (dir) => {
          await git(dir, ['mv', 'old name.php', to]);

          const out = await collectImplementationFiles(ctxFor(), dir);

          expect(out.files).toEqual([to]);
          expect(out.total).toBe(1);
        });
      },
    );

    it.each(['plain.php', 'café.php', 'x -> y.php'])(
      'lists the destination of an intent-to-add rename to %s, and not its source',
      async (to) => {
        await inRepo({ 'old name.php': 'one\ntwo\n' }, async (dir) => {
          await rename(path.join(dir, 'old name.php'), path.join(dir, to));
          await git(dir, ['add', '-N', to]);

          const out = await collectImplementationFiles(ctxFor(), dir);

          expect(out.files).toEqual([to]);
          expect(out.total).toBe(1);
        });
      },
    );

    it('keeps the real paths when the cap cuts, and counts each changed file once', async () => {
      await inRepo({ 'kept.php': 'a\n' }, async (dir) => {
        for (const name of QUOTED_NAMES) await writeFile(path.join(dir, name), 'a\nb\n');
        await commitAll(dir);
        for (const name of QUOTED_NAMES) await writeFile(path.join(dir, name), 'a\nB\n');

        const out = await collectImplementationFiles(ctxFor({ touched: names(98) }), dir);

        const real = new Set([...names(98), ...QUOTED_NAMES]);
        expect(out.files.filter((f) => !real.has(f))).toEqual([]);
        expect(out.total).toBe(101);
        expect(out.truncated).toBe(true);
      });
    });

    it('keeps the reported and the dirty files when the cap cuts, and counts the committed edit it cut', async () => {
      await inRepo({ 'edited.php': 'a\nb\n', 'dirty.php': 'a\nb\n' }, async (dir) => {
        await writeFile(path.join(dir, 'edited.php'), 'a\nB\n');
        await commitAll(dir);
        await writeFile(path.join(dir, 'dirty.php'), 'a\nB\n');

        const out = await collectImplementationFiles(ctxFor({ touched: names(99) }), dir);

        expect(out.files).toHaveLength(100);
        expect(out.files).toContain('dirty.php');
        expect(out.files).not.toContain('edited.php');
        expect(out.total).toBe(101);
        expect(out.truncated).toBe(true);
      });
    });
  });

  describe('collectImplementationFiles — a committed change that cannot be read', () => {
    const UNREAD = 'the change committed since the fork point could not be read';

    /** `c.js` committed on the task branch and reported by nobody, with a clean tree. */
    async function inCommittedRepo(run: (dir: string) => Promise<void>): Promise<void> {
      await inRepo({ 'kept.js': 'a\n', 'gone.js': 'x\n' }, async (dir) => {
        await writeFile(path.join(dir, 'c.js'), 'new\n');
        await git(dir, ['add', '-A']);
        await git(dir, ['commit', '-m', 'ISSUE-1: add c.js']);
        const clean = await git(dir, ['status', '--porcelain']);
        expect(clean.stdout.trim()).toBe('');
        await run(dir);
      });
    }

    it('lists the committed file and records no failure while the fork point resolves', async () => {
      await inCommittedRepo(async (dir) => {
        const out = await collectImplementationFiles(ctxFor(), dir);

        expect(out.files).toEqual(['c.js']);
        expect(out.total).toBe(1);
        expect(out.scanError).toBeNull();
      });
    });

    it('marks the scan failed when the recorded base branch is gone, rather than reading the change against HEAD', async () => {
      await inCommittedRepo(async (dir) => {
        await git(dir, ['branch', '-D', 'main']);

        const out = await collectImplementationFiles(ctxFor(), dir);

        expect(out.files).toEqual([]);
        expect(out.total).toBe(0);
        expect(out.scanError).toBe(UNREAD);
      });
    });

    it('marks the scan failed when no base branch was recorded', async () => {
      await inCommittedRepo(async (dir) => {
        const out = await collectImplementationFiles(ctxFor({}, null), dir);

        expect(out.files).toEqual([]);
        expect(out.scanError).toBe(UNREAD);
      });
    });

    it('marks the scan failed for a committed deletion nobody reported, and says so once', async () => {
      await inRepo({ 'gone.js': 'x\n', 'kept.js': 'a\n' }, async (dir) => {
        await rm(path.join(dir, 'gone.js'));
        await git(dir, ['add', '-A']);
        await git(dir, ['commit', '-m', 'ISSUE-1: remove it']);
        await git(dir, ['branch', '-D', 'main']);

        const out = await collectImplementationFiles(ctxFor(), dir);

        expect(out.files).toEqual([]);
        expect(out.scanError).toBe(UNREAD);
      });
    });

    it("states the dirty scan's own error first when that failed too", async () => {
      const out = await collectImplementationFiles(
        ctxFor({ touched: ['a.js'] }),
        '/nonexistent-worktree',
      );

      expect(out.files).toEqual(['a.js']);
      expect(out.scanError?.endsWith(`; ${UNREAD}`)).toBe(true);
      expect(out.scanError?.startsWith(UNREAD)).toBe(false);
      expect(out.scanError?.split(UNREAD)).toHaveLength(2);
    });

    it('tells the reviewers and the gate that the list may lack the committed file the fork point could not name', async () => {
      await inCommittedRepo(async (dir) => {
        await git(dir, ['branch', '-D', 'main']);

        const out = await collectImplementationFiles(ctxFor({ dag: ['kept.js'] }), dir);

        expect(out.files).toEqual(['kept.js']);
        expect(fileCoverage(out)).toEqual({
          listed: 1,
          total: 1,
          truncated: false,
          scanFailed: true,
        });
        expect(changedFilesBlock(out, 'Changed files', 'fallback')).toContain(
          'COVERAGE: the change could not be read in full',
        );
      });
    });

    it('records no failure for the same change while the fork point resolves', async () => {
      await inCommittedRepo(async (dir) => {
        const out = await collectImplementationFiles(ctxFor({ dag: ['kept.js'] }), dir);

        expect(out.files).toEqual(['kept.js', 'c.js']);
        const covered = fileCoverage(out);
        expect(covered).toEqual({ listed: 2, total: 2, truncated: false });
        expect('scanFailed' in covered!).toBe(false);
        expect(changedFilesBlock(out, 'Changed files', 'fallback')).not.toContain('COVERAGE');
      });
    });

    it('reads against HEAD when the fork point is gone, unless the caller asks for the fork point only', async () => {
      await inRepo({ 'kept.js': 'a\n' }, async (dir) => {
        await writeFile(path.join(dir, 'kept.js'), 'b\n');
        await git(dir, ['branch', '-D', 'main']);

        expect(await readChangedPaths(dir, 'main')).toEqual(['kept.js']);
        expect(await readChangedPaths(dir, null)).toEqual(['kept.js']);
        expect(await readChangedPaths(dir, 'main', { forkPointOnly: true })).toBeNull();
        expect(await readChangedPaths(dir, null, { forkPointOnly: true })).toBeNull();
      });
    });

    it('names the same paths with or without forkPointOnly while the fork point resolves', async () => {
      await inRepo({ 'kept.js': 'a\n' }, async (dir) => {
        await writeFile(path.join(dir, 'kept.js'), 'b\n');

        expect(await readChangedPaths(dir, 'main', { forkPointOnly: true })).toEqual(['kept.js']);
        expect(await readChangedPaths(dir, 'main')).toEqual(['kept.js']);
      });
    });
  });

  describe('collectImplementationFiles — names that span lines', () => {
    it('records a committed, a dirty and an untracked file whose names hold a newline, and lists none', async () => {
      await inRepo({ 'dirty\nname.php': 'a\nb\n', 'ordinary.php': 'a\nb\n' }, async (dir) => {
        await writeFile(path.join(dir, 'committed\nname.php'), 'x\n');
        await git(dir, ['add', '-A']);
        await git(dir, ['commit', '-m', 'ISSUE-1: add it']);
        await writeFile(path.join(dir, 'dirty\nname.php'), 'a\nB\n');
        await writeFile(path.join(dir, 'ordinary.php'), 'a\nB\n');
        await writeFile(path.join(dir, 'untracked\nname.php'), 'fresh\n');

        const out = await collectImplementationFiles(ctxFor({ touched: ['reported.php'] }), dir);
        const block = changedFilesBlock(out, 'Changed files', 'fallback');

        expect(out.total).toBe(5);
        expect(block.split('\n').filter((line) => line.startsWith('- '))).toEqual([
          '- reported.php',
          '- ordinary.php — lines 2',
        ]);
        expect(block).not.toContain('name.php');
        expect(block).toContain(
          'COVERAGE: 3 changed files have names that cannot be listed safely',
        );
        expect(fileCoverage(out)).toEqual({ listed: 2, total: 5, truncated: true });
      });
    });
  });

  describe('collectImplementationFiles — names that would forge the fence', () => {
    it('records a dirty file whose name holds a run of equals signs, and lists none of them', async () => {
      await inRepo({ 'ordinary.php': 'a\nb\n' }, async (dir) => {
        await writeFile(path.join(dir, 'ordinary.php'), 'a\nB\n');
        await writeFile(path.join(dir, 'a===b.php'), 'fresh\n');
        await writeFile(path.join(dir, 'x=====y.php'), 'fresh\n');

        const out = await collectImplementationFiles(ctxFor(), dir);
        const block = changedFilesBlock(out, 'Changed files', 'fallback');

        expect(out.total).toBe(3);
        expect(block.split('\n').filter((line) => line.startsWith('- '))).toEqual([
          '- ordinary.php — lines 2',
          '- a===b.php — new file',
        ]);
        expect(block).not.toContain('x=====y.php');
        expect(block).toContain(
          'COVERAGE: 1 changed files have names that cannot be listed safely',
        );
        expect(fileCoverage(out)).toEqual({ listed: 2, total: 3, truncated: true });
      });
    });
  });
});
