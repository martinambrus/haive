import { describe, it, expect } from 'vitest';
import { parseCoderResult, issuePaths } from './dag-executor.js';
import type { StepContext } from './step-definition.js';

type InvLike = Parameters<typeof parseCoderResult>[0];
function inv(partial: Partial<InvLike>): InvLike {
  return { parsedOutput: null, rawOutput: null, exitCode: 0, ...partial } as InvLike;
}

describe('parseCoderResult', () => {
  it('parses a fenced ISSUE_RESULT_JSON from rawOutput', () => {
    const raw =
      'work done\n```json\n{"issue_id":"ISSUE-001","outcome":"completed","files_modified":["a.ts"],"debt_items":[],"concerns":"none"}\n```';
    const r = parseCoderResult(inv({ rawOutput: raw, exitCode: 0 }));
    expect(r.outcome).toBe('completed');
    expect(r.filesModified).toEqual(['a.ts']);
    expect(r.concerns).toBe('none');
  });

  it('uses parsedOutput when it is already an object', () => {
    const r = parseCoderResult(
      inv({
        parsedOutput: {
          issue_id: 'X',
          outcome: 'completed_with_debt',
          files_modified: ['b.ts'],
          debt_items: [{ severity: 'low' }],
          concerns: '',
        },
      }),
    );
    expect(r.outcome).toBe('completed_with_debt');
    expect(r.debtItems).toHaveLength(1);
  });

  it('falls back to completed on unparseable output with exit 0', () => {
    const r = parseCoderResult(inv({ rawOutput: 'no json here', exitCode: 0 }));
    expect(r.outcome).toBe('completed');
    expect(r.filesModified).toEqual([]);
  });

  it('falls back to failed_unrecoverable on a non-zero exit with no json', () => {
    const r = parseCoderResult(inv({ rawOutput: 'crashed', exitCode: 1 }));
    expect(r.outcome).toBe('failed_unrecoverable');
  });
});

describe('issuePaths', () => {
  it('builds sibling worktree paths + a slashed issue branch', () => {
    const ctx = {
      repoPath: '/var/lib/haive/repos/u/r',
      sandboxWorkdir: '/haive/workdir',
    } as StepContext;
    const p = issuePaths(
      ctx,
      { path: '/var/lib/haive/repos/u/r/.haive/worktrees/feat-x', branch: 'feat-x' },
      'ISSUE-001',
    );
    expect(p.worktreePath).toBe('/var/lib/haive/repos/u/r/.haive/worktrees/feat-x--ISSUE-001');
    expect(p.sandboxWorktreePath).toBe('/haive/workdir/.haive/worktrees/feat-x--ISSUE-001');
    expect(p.branchName).toBe('feat-x--ISSUE-001');
  });

  it('flattens a namespaced integration branch for the dir but keeps the slash in the branch ref', () => {
    const ctx = {
      repoPath: '/var/lib/haive/repos/u/r',
      sandboxWorkdir: '/haive/workdir',
    } as StepContext;
    const p = issuePaths(
      ctx,
      { path: '/var/lib/haive/repos/u/r/.haive/worktrees/feature-foo', branch: 'feature/foo' },
      'ISSUE-001',
    );
    // dir stays one level under worktrees (slash flattened)…
    expect(p.worktreePath).toBe('/var/lib/haive/repos/u/r/.haive/worktrees/feature-foo--ISSUE-001');
    // …but the git branch ref keeps the namespacing slash
    expect(p.branchName).toBe('feature/foo--ISSUE-001');
  });
});
