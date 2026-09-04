import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  parseCoderResult,
  issuePaths,
  issueSpecText,
  reviewerPrompt,
  fixCoderPrompt,
  advisorPrompt,
  pickFatalProviderError,
  fixRequiredIsCosmetic,
  parseReviewerOutput,
  parseAdvisor,
  parseReplanner,
} from './dag-executor.js';
import { dagEnvironmentHaltReason } from './dag-failure-class.js';
import { dagExecuteStep } from './steps/workflow/06c-dag-execute.js';
import { SPEC_ARTIFACT_RELPATH } from './steps/workflow/_spec-artifact.js';
import { PROVIDER_FATAL_HEADLINES } from '../queues/cli-exec/failure-class.js';
import type { DagCoderContext, StepContext } from './step-definition.js';
import type { ReviewerOutput } from '@haive/shared';

type DagIssue = Parameters<typeof issueSpecText>[1];

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

describe('issueSpecText', () => {
  const view = { text: 'INDEX', spec: 'WHOLE SPEC', condensed: true };
  const issue = (worktreePath: string | null) => ({ worktreePath }) as DagIssue;

  async function worktreeWithSpec(present: boolean): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'ist-'));
    if (present) {
      const abs = path.join(dir, SPEC_ARTIFACT_RELPATH);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, 'spec body', 'utf8');
    }
    return dir;
  }

  it('passes an uncondensed view straight through', async () => {
    const dir = await worktreeWithSpec(false);
    try {
      const r = await issueSpecText({ ...view, condensed: false }, issue(dir));
      expect(r).toEqual({ text: 'INDEX', condensed: false });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the index when the issue worktree holds the artifact', async () => {
    const dir = await worktreeWithSpec(true);
    try {
      expect(await issueSpecText(view, issue(dir))).toEqual({ text: 'INDEX', condensed: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the whole spec when the copy did not land', async () => {
    const dir = await worktreeWithSpec(false);
    try {
      expect(await issueSpecText(view, issue(dir))).toEqual({
        text: 'WHOLE SPEC',
        condensed: false,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the whole spec when the issue has no worktree yet', async () => {
    expect(await issueSpecText(view, issue(null))).toEqual({
      text: 'WHOLE SPEC',
      condensed: false,
    });
  });
});

describe('06c buildCoderPrompt spec directive', () => {
  const build = dagExecuteStep.dagExecute!.buildCoderPrompt;
  const ctx = (over: Partial<DagCoderContext>): DagCoderContext => ({
    issueKey: 'ISSUE-001',
    title: 'Add the thing',
    description: 'desc',
    spec: 'INDEX',
    specCondensed: true,
    specSections: ['## Data model'],
    acceptanceCriteria: ['it works'],
    provides: 'the thing',
    sandboxWorktreePath: '/haive/workdir',
    ...over,
  });
  const DIRECTIVE = 'Read them IN FULL from the spec file named above';

  it('tells a coder to read its own sections when the view is condensed', () => {
    expect(build(ctx({}), '')).toContain(DIRECTIVE);
  });

  it('stays silent when the whole spec is already embedded', () => {
    expect(build(ctx({ specCondensed: false }), '')).not.toContain(DIRECTIVE);
  });

  it('stays silent when the planner assigned this issue no sections', () => {
    expect(build(ctx({ specSections: [] }), '')).not.toContain(DIRECTIVE);
  });
});

describe('review-loop prompts carry the spec', () => {
  const issue = {
    issueKey: 'ISSUE-001',
    title: 'Add the thing',
    specSections: ['## Data model'],
    acceptanceCriteria: ['it works'],
    filesModified: ['a.ts'],
    innerIteration: 1,
    reviewerVerdict: null,
  } as unknown as DagIssue;

  const built = () => [
    reviewerPrompt(issue, 'INDEX'),
    fixCoderPrompt(issue, [{ severity: 'high' }], 'INDEX'),
    advisorPrompt(issue, 'INDEX'),
  ];

  it('names the sections and embeds the spec view for every role', () => {
    for (const p of built()) {
      expect(p).toContain('Spec sections this issue implements:');
      expect(p).toContain('## Data model');
      expect(p).toContain('=== Spec (the sections above live in this document) ===');
      expect(p).toContain('INDEX');
    }
  });

  it('tells the reviewer the criteria are only a summary', () => {
    expect(reviewerPrompt(issue, 'INDEX')).toContain(
      'The criteria are a summary — also check the code against the spec sections themselves.',
    );
  });

  it('warns the advisor before it drops a criterion', () => {
    expect(advisorPrompt(issue, 'INDEX')).toContain('before proposing drop_criteria');
  });

  it('adds nothing when the run has no spec (lightweight paths)', () => {
    for (const p of [
      reviewerPrompt(issue, ''),
      fixCoderPrompt(issue, [], ''),
      advisorPrompt(issue, ''),
    ]) {
      expect(p).not.toContain('=== Spec');
      expect(p).not.toContain('drop_criteria — dropping one');
      expect(p).not.toContain('The criteria are a summary');
    }
  });
});
