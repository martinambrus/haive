import { describe, it, expect } from 'vitest';
import {
  parseCoderResult,
  issuePaths,
  pickFatalProviderError,
  fixRequiredIsCosmetic,
  parseReviewerOutput,
  parseAdvisor,
  parseReplanner,
} from './dag-executor.js';
import { dagEnvironmentHaltReason } from './dag-failure-class.js';
import { PROVIDER_FATAL_HEADLINES } from '../queues/cli-exec/failure-class.js';
import type { StepContext } from './step-definition.js';
import type { ReviewerOutput } from '@haive/shared';

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

  it('fails closed on unparseable output even when the CLI exits 0', () => {
    const r = parseCoderResult(inv({ rawOutput: 'no json here', exitCode: 0 }));
    expect(r.outcome).toBe('failed_unrecoverable');
    expect(r.filesModified).toEqual([]);
    expect(r.concerns).toContain('without a valid ISSUE_RESULT_JSON');
  });

  it('falls back to failed_unrecoverable on a non-zero exit with no json', () => {
    const r = parseCoderResult(inv({ rawOutput: 'crashed', exitCode: 1 }));
    expect(r.outcome).toBe('failed_unrecoverable');
  });
});

describe('dagEnvironmentHaltReason', () => {
  it('halts on the root-owned EACCES failure from DAG issue worktrees', () => {
    expect(
      dagEnvironmentHaltReason({
        concerns: 'Worktree is root:root mode 0755 and every write returned EACCES.',
      }),
    ).toContain('root:root');
  });

  it('halts on a transient re-dispatch exhausted (repeatedly-killed) coder', () => {
    expect(
      dagEnvironmentHaltReason({
        concerns: 'DAG_INFRA_EXHAUSTED: ISSUE-004 coder was killed/orphaned 3 times',
      }),
    ).not.toBeNull();
  });

  it('does NOT halt on a clean contract violation (missing result JSON) — that escalates', () => {
    expect(
      dagEnvironmentHaltReason({
        concerns: 'coder exited 0 without a valid ISSUE_RESULT_JSON; refusing to infer success',
      }),
    ).toBeNull();
  });

  it('does NOT halt on a killed/orphaned coder — that is re-dispatched', () => {
    expect(
      dagEnvironmentHaltReason({
        errorMessage: 'CLI invocation orphaned by a worker restart (worker exited mid-run)',
      }),
    ).toBeNull();
  });

  it('does not halt on an ordinary implementation failure', () => {
    expect(
      dagEnvironmentHaltReason({
        concerns: 'The proposed parser cannot satisfy the backwards-compatibility requirement.',
      }),
    ).toBeNull();
  });
});

describe('DAG structured-decision parsing', () => {
  it('does not approve an unparseable reviewer response', () => {
    expect(parseReviewerOutput(inv({ rawOutput: 'looks fine', exitCode: 0 }))).toBeNull();
  });

  it('escalates an unparseable advisor response instead of accepting debt', () => {
    expect(parseAdvisor(inv({ rawOutput: '', exitCode: 0 })).action).toBe('ESCALATE_TO_REPLAN');
  });

  it('aborts on an unparseable replanner response instead of continuing', () => {
    expect(parseReplanner(inv({ rawOutput: '', exitCode: 0 })).action).toBe('ABORT');
  });
});

describe('pickFatalProviderError', () => {
  const RATE_LIMIT_MSG = `${PROVIDER_FATAL_HEADLINES.rate_limit} — retry once it resets. (429)`;

  it('returns the fatal message when an ended invocation hit a provider wall', () => {
    expect(pickFatalProviderError([{ errorMessage: RATE_LIMIT_MSG }])).toBe(RATE_LIMIT_MSG);
  });

  it('finds the fatal even when a successful sibling ended after it (scans all rows)', () => {
    // orderBy endedAt desc means a later-finishing success can sort first; the scan
    // must still surface the earlier fatal coder.
    const rows = [
      { errorMessage: null },
      { errorMessage: RATE_LIMIT_MSG },
      { errorMessage: 'cli invocation failed: TypeError at build.ts:42' },
    ];
    expect(pickFatalProviderError(rows)).toBe(RATE_LIMIT_MSG);
  });

  it('returns null when no invocation is a fatal provider failure', () => {
    expect(
      pickFatalProviderError([
        { errorMessage: null },
        { errorMessage: 'coder exited 1; no ISSUE_RESULT_JSON parsed' },
      ]),
    ).toBe(null);
  });

  it('returns null for an empty set', () => {
    expect(pickFatalProviderError([])).toBe(null);
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

describe('fixRequiredIsCosmetic', () => {
  function rv(p: Partial<ReviewerOutput>): ReviewerOutput {
    return { verdict: 'fix_required', criteria_results: [], issues: [], ...p };
  }
  const pass = { criterion: 'c1', passed: true };

  it('true: fix_required, all criteria pass, only a low-severity issue', () => {
    expect(
      fixRequiredIsCosmetic(
        rv({
          criteria_results: [pass, { criterion: 'c2', passed: true }],
          issues: [{ severity: 'low', description: 'comment wording nit' }],
        }),
      ),
    ).toBe(true);
  });

  it('true: fix_required, all criteria pass, no issues at all', () => {
    expect(fixRequiredIsCosmetic(rv({ criteria_results: [pass] }))).toBe(true);
  });

  it('false: a criterion failed', () => {
    expect(
      fixRequiredIsCosmetic(
        rv({
          criteria_results: [pass, { criterion: 'c2', passed: false }],
          issues: [{ severity: 'low', description: 'nit' }],
        }),
      ),
    ).toBe(false);
  });

  it('false: a medium-severity issue is present', () => {
    expect(
      fixRequiredIsCosmetic(
        rv({ criteria_results: [pass], issues: [{ severity: 'medium', description: 'real bug' }] }),
      ),
    ).toBe(false);
  });

  it('false: an issue with no explicit severity', () => {
    expect(
      fixRequiredIsCosmetic(
        rv({ criteria_results: [pass], issues: [{ description: 'unlabeled finding' }] }),
      ),
    ).toBe(false);
  });

  it('false: empty criteria_results (cannot assert criteria pass)', () => {
    expect(
      fixRequiredIsCosmetic(
        rv({ criteria_results: [], issues: [{ severity: 'low', description: 'nit' }] }),
      ),
    ).toBe(false);
  });

  it('false: verdict approve or block, even with passing criteria', () => {
    expect(fixRequiredIsCosmetic(rv({ verdict: 'approve', criteria_results: [pass] }))).toBe(false);
    expect(fixRequiredIsCosmetic(rv({ verdict: 'block', criteria_results: [pass] }))).toBe(false);
  });
});
