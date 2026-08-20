import { describe, it, expect, vi, beforeEach } from 'vitest';

const loadPreviousStepOutput = vi.fn();
vi.mock('../onboarding/_helpers.js', () => ({
  loadPreviousStepOutput: (...args: unknown[]) => loadPreviousStepOutput(...args),
}));

const { changedFilesBlock, collectImplementationFiles, fileCoverage } =
  await import('./_impl-changes.js');
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
