import * as returns from '../../../queues/insight-gate3-return.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gate3CommitStep } from './10-gate-3-commit.js';
import * as loader from './_insight-loader.js';
import * as previous from '../onboarding/_helpers.js';
import * as gitWorkspace from '../../../repo/git-workspace.js';
import * as git from '../../../repo/git-exec.js';
import * as batches from './_insight-batch.js';
import * as auto from './_insight-auto.js';
import * as sites from './_similar-sites.js';
import * as rules from './_gate-house-rules.js';
import * as pages from './_insight-page.js';
import * as captures from './_fix-test-store.js';
import type { StepContext } from '../../step-definition.js';
const item = (id: string) => ({
  id,
  identity: id,
  sourceStep: 'review',
  title: id,
  location: 'src/a.ts',
  description: id,
  picked: false,
});
const ctx = {
  db: {},
  taskId: 'task',
  taskStepId: 'gate',
  round: 2,
  rerunGeneration: 0,
  workspacePath: '/repo',
  throwIfCancelled() {},
  logger: { info() {} },
} as unknown as StepContext;
const detected = {
  hasGit: true,
  workspacePath: '/repo',
  diffSummary: 'old diff',
  dirtyFiles: 1,
  diffArtifactPath: null,
  changedFileCount: 1,
  diffArtifactTruncated: false,
  insightChoices: [item('minor'), item('nit')],
};
beforeEach(() => {
  vi.spyOn(returns, 'pendingInsightApproval').mockResolvedValue(null);
});
afterEach(() => vi.restoreAllMocks());
describe('PR5 gate-3 insight controls', () => {
  it.each([false, true])(
    'offers minor/nit with empty defaults even after gate 2 (auto=%s)',
    async (enabled) => {
      vi.spyOn(previous, 'loadPreviousStepOutput').mockImplementation(
        async (_db, _task, step) =>
          ({
            output: step === '09-gate-2-verify-approval' ? { decision: 'approve' } : {},
          }) as never,
      );
      vi.spyOn(loader, 'loadUnactedInsights').mockResolvedValue({
        insights: [item('minor'), item('nit')],
        omitted: 0,
      });
      vi.spyOn(pages, 'insightPageOffset').mockResolvedValue(0);
      vi.spyOn(gitWorkspace, 'requireUsableGit').mockResolvedValue(false);
      vi.spyOn(auto, 'insightAutoEnabled').mockResolvedValue(enabled);
      vi.spyOn(auto, 'loadAutoHistory').mockResolvedValue({ claims: [], results: [] });
      vi.spyOn(batches, 'loadInsightBatchRecords').mockResolvedValue([]);
      vi.spyOn(captures, 'loadFixTestRecords').mockResolvedValue([]);
      vi.spyOn(sites, 'loadTaskSimilarSites').mockResolvedValue({ sites: [], omitted: 0 });
      vi.spyOn(rules, 'loadGateHouseRules').mockResolvedValue(null);
      const d = await gate3CommitStep.detect!(ctx);
      const form = await gate3CommitStep.form!(ctx, d, null);
      expect(form!.fields.find((f) => f.id === 'selectedInsights')).toMatchObject({
        defaults: [],
        options: [{ value: 'minor' }, { value: 'nit' }],
      });
      expect(loader.loadUnactedInsights).toHaveBeenCalled();
    },
  );
  it('pick with commit=true routes before ANY git or staging, even with a blank message', async () => {
    const run = vi.spyOn(git, 'gitRun').mockRejectedValue(new Error('git must not run'));
    vi.spyOn(batches, 'ensureInsightIntent').mockImplementation(
      async (_ctx, selected, mode) =>
        ({
          version: 1,
          protocolVersion: 1,
          mode,
          batchId: 'batch',
          sourceStepRowId: 'gate',
          generation: 0,
          stage: 'intent',
          selected,
          items: [],
          notes: '',
          miningId: null,
          invocationId: null,
        }) as never,
    );
    const out = await gate3CommitStep.apply(ctx, {
      detected,
      formValues: { commit: true, commitMessage: '', selectedInsights: ['nit'] },
      llmOutput: null,
    } as never);
    expect(run).not.toHaveBeenCalled();
    expect(gate3CommitStep.reviseLoop?.evaluate(out)).toMatchObject({
      targetStepId: '08e-insights-triage',
      continuation: { batchId: 'batch', mode: 'gate3', stage: 'apply' },
    });
  });
  it('empty pick preserves the skip result byte for byte', async () => {
    expect(
      await gate3CommitStep.apply(ctx, {
        detected,
        formValues: { commit: false, selectedInsights: [] },
        llmOutput: null,
      } as never),
    ).toEqual({ committed: false, commitSha: null, message: 'commit skipped' });
  });
});
it('all pages are reachable without an edit and omissions are explicit', async () => {
  const form = await gate3CommitStep.form!(
    ctx,
    {
      ...detected,
      insightChoices: Array.from({ length: 2 }, (_, n) => item(`item-${n}`)),
      insightPage: 0,
      insightTotal: 5,
      insightPageSize: 2,
      outOfScopeInsightsOmitted: 3,
    } as never,
    null,
  );
  expect(form!.fields.find((f) => f.id === 'insightPage')).toMatchObject({
    type: 'select',
    options: [{ value: '0' }, { value: '2' }, { value: '4' }],
  });
  expect(JSON.stringify(form)).toContain('3 more');
});
it('gate3 continuation metadata is versioned and survives strict decoding', async () => {
  const { readInsightContinuation } = await import('./_insight-continuation.js');
  expect(
    readInsightContinuation({
      version: 1,
      kind: 'insight_revise',
      batchId: 'b',
      sourceStepRow: 'gate',
      generation: 0,
      round: 3,
      mode: 'gate3',
      stage: 'apply',
    }),
  ).toMatchObject({ mode: 'gate3', stage: 'apply' });
});
it('InsightSummary is deterministic, groups shifted aliases, and bounds item/attempt copies', async () => {
  const modulePath = './_insight-summary.js';
  const { buildInsightSummary } = await import(modulePath);
  const inputs = [
    item('nit'),
    { ...item('nit-alias'), identity: 'nit' },
    item('minor'),
    item('other'),
  ];
  const options = { limit: 2, attemptLimit: 1 };
  const summary = buildInsightSummary(inputs, [], [], false, options);
  expect(summary).toEqual(buildInsightSummary([...inputs].reverse(), [], [], false, options));
  expect(summary).toMatchObject({
    version: 1,
    totals: { identities: 3, occurrences: 4 },
    omitted: 1,
  });
  expect(summary.items).toHaveLength(2);
  expect(
    summary.items.every(
      (i: { class: string; outcome: string }) =>
        i.class === 'unclassified' && i.outcome === 'not_selected',
    ),
  ).toBe(true);
});

it('a legacy picked alias remains unconfirmed even when its unpicked alias sorts first', async () => {
  const { buildInsightSummary } = await import('./_insight-summary.js');
  const summary = buildInsightSummary(
    [
      { ...item('a'), identity: 'same' },
      { ...item('b'), identity: 'same', picked: true },
    ],
    [],
    [],
    false,
  );
  expect(summary.items[0]).toMatchObject({ outcome: 'unconfirmed', occurrences: 2 });
});
it('summary bounds every attempt page and retains the latest report separately from class', async () => {
  const { buildInsightSummary } = await import('./_insight-summary.js');
  const journal = [1, 2, 3].map((n) => ({
    version: 1,
    protocolVersion: 1,
    mode: 'gate3',
    batchId: `batch-${n}`,
    sourceStepRowId: 'row',
    generation: n,
    stage: 'outcome',
    selected: [item('nit')],
    items: [
      { id: 'nit', outcome: n === 3 ? 'not_applied' : 'applied', changes: ['edit'], reason: '' },
    ],
    notes: '',
    miningId: null,
    invocationId: `run-${n}`,
  }));
  const summary = buildInsightSummary(
    [item('nit')],
    [
      {
        id: 'nit',
        identity: 'nit',
        class: 'nit',
        kind: 'cosmetic',
        reason: 'Style',
        outcome: 'left_minor',
        eligible: true,
      },
    ],
    journal as never,
    true,
    { attemptLimit: 1 },
  );
  expect(summary.items[0]).toMatchObject({
    class: 'nit',
    outcome: 'not_applied',
    attemptsOmitted: 2,
    attempts: [{ batchId: 'batch-3', reportedOutcome: 'not_applied' }],
  });
});

it('a zero attempt limit returns no attempts while counting every omission', async () => {
  const { buildInsightSummary } = await import('./_insight-summary.js');
  const journal = [
    {
      mode: 'gate3',
      batchId: 'batch',
      stage: 'outcome',
      selected: [item('nit')],
      items: [{ id: 'nit', outcome: 'applied' }],
      invocationId: null,
    },
  ];
  expect(
    buildInsightSummary([item('nit')], [], journal as never, false, { attemptLimit: 0 }).items[0],
  ).toMatchObject({ attempts: [], attemptsOmitted: 1 });
});

it('complete reports retain full occurrence text and provenance in bounded deterministic entries', async () => {
  const module = await import('./_insight-summary.js');
  const records = [
    { ...item('alias-b'), identity: 'same', location: 'src/a.ts:12' },
    {
      ...item('alias-a'),
      identity: 'same',
      description: 'full description '.repeat(20) + 'the end',
      sourceRefs: Array.from({ length: 4 }, (_, n) => ({
        kind: 'invocation' as const,
        invocationId: `run-${n}`,
        taskStepId: 'row',
        stepId: '08c-code-review',
        round: n,
        superseded: n === 0,
      })),
    },
  ];
  const entries = module.insightOccurrenceReportEntries(records, 128);
  expect(entries).toEqual(module.insightOccurrenceReportEntries([...records].reverse(), 128));
  expect(entries.every((entry) => entry.length <= 128 * 2 + 100)).toBe(true);
  const body = entries.join('\n').replaceAll('\\', '');
  expect(body).toContain('the end');
  expect(body).toContain('src/a.ts:12');
  expect(body).toContain('alias-a');
  expect(body).toContain('alias-b');
  expect(body).toContain('run-3');
  expect(body).toContain('superseded');
});
