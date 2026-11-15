import * as secretPolicy from '../../../queues/cli-exec/secret-mask.js';
import * as safeFs from '@haive/shared/fs-safe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMiningResult, StepContext } from '../../step-definition.js';
import { MiningWaveError, ReopenStepFormError } from '../../step-definition.js';
import * as auto from './_insight-auto.js';
import { insightsTriageStep } from './08e-insights-triage.js';
import * as batches from './_insight-batch.js';
import * as dependency from './_dependency-policy.js';
import * as loader from './_insight-loader.js';
import * as previous from '../onboarding/_helpers.js';
import * as specs from './_spec-artifact.js';
import {
  autoInsightReport,
  automaticSelection,
  detectAutoInsights,
  finishAutoClassification,
  startAutoClassification,
  type AutoDetect,
} from './_insight-auto-flow.js';
const one = {
  id: 'one',
  identity: 'src/a.ts::one',
  legacyId: 'i-1',
  sourceStep: 'review',
  picked: false,
  title: 'One',
  location: 'src/a.ts',
  description: 'detail',
};
const batchId = batches.insightBatchId('row', 0);
const claim = {
  version: 1 as const,
  batchId,
  sourceStepRowId: 'row',
  generation: 0,
  ordinal: 1,
  insights: [one],
};
const ctx = {
  db: {},
  taskId: 'task',
  taskStepId: 'row',
  rerunGeneration: 0,
  throwIfCancelled() {},
} as StepContext;
const state = (): AutoDetect => ({
  version: 1,
  mode: 'classify',
  candidates: [one],
  roundsStarted: 0,
  decisions: [],
  stopReason: 'classifying',
  dependencyPolicy: { drupal: false, drupalRoots: [], ownedPaths: [] },
});
const result = (
  attempt: 1 | 2,
  raw: unknown,
  status: 'done' | 'failed' = 'done',
): AgentMiningResult => ({
  agentId: auto.classifierId(batchId, attempt),
  agentTitle: 'Triage',
  invocationId: `run-${attempt}`,
  status,
  rawOutput: typeof raw === 'string' ? raw : null,
  output: raw,
  errorMessage: status === 'failed' ? 'provider unavailable' : null,
});
describe('automatic insight stages', () => {
  let history: { claims: auto.AutoClaim[]; results: auto.AutoClassification[] };
  beforeEach(() => {
    history = { claims: [claim], results: [] };
    vi.spyOn(auto, 'loadAutoHistory').mockImplementation(async () => history);
    vi.spyOn(auto, 'saveAutoClassification').mockImplementation(async (_ctx, record) => {
      history.results.push(record);
      return record;
    });
    vi.spyOn(auto, 'claimAutoRound').mockResolvedValue(claim);
    vi.spyOn(batches, 'loadInsightBatchRecords').mockResolvedValue([]);
    vi.spyOn(dependency, 'loadDependencyPolicy').mockResolvedValue({
      drupal: false,
      drupalRoots: [],
      ownedPaths: [],
    });
  });
  afterEach(() => vi.restoreAllMocks());
  it('starts a separate triage seat and calls neither a classifier nor a claim for settled/manual stages', async () => {
    expect(await startAutoClassification(ctx, state())).toMatchObject([
      { agentId: auto.classifierId(batchId, 1), roleKey: 'triage', capabilities: [] },
    ]);
    vi.mocked(auto.claimAutoRound).mockClear();
    for (const mode of ['manual', 'settled'] as const)
      expect(await startAutoClassification(ctx, { ...state(), mode })).toEqual([]);
    expect(auto.claimAutoRound).not.toHaveBeenCalled();
  });
  it.each([
    { version: 1, items: [] },
    {
      version: 1,
      batchId,
      items: [
        { id: 'one', class: 'minor', kind: 'correctness', reason: 'reason' },
        { id: 'one', class: 'minor', kind: 'correctness', reason: 'reason' },
      ],
    },
    {
      version: 1,
      items: [{ id: 'foreign', class: 'minor', kind: 'correctness', reason: 'reason' }],
    },
    'not json',
  ])(
    'invalid/incomplete classifier gets a second attempt, then a durable manual fallback: %j',
    async (raw) => {
      let wave: MiningWaveError | undefined;
      try {
        await finishAutoClassification(ctx, state(), [result(1, raw)], false);
      } catch (err) {
        expect(err).toBeInstanceOf(MiningWaveError);
        wave = err as MiningWaveError;
      }
      expect(wave!.dispatches).toMatchObject([
        { agentId: auto.classifierId(batchId, 2), roleKey: 'triage' },
      ]);
      expect(auto.saveAutoClassification).not.toHaveBeenCalled();
      const final = await finishAutoClassification(
        ctx,
        state(),
        [result(1, raw), result(2, raw)],
        false,
      );
      expect(final!.result).toMatchObject({
        complete: false,
        items: [{ id: 'one', class: 'unclassified', outcome: 'needs_decision' }],
        invocationIds: ['run-1', 'run-2'],
      });
      expect(automaticSelection(final!.claim, final!.result)).toEqual([]);
      const detected = await detectAutoInsights(ctx, [one], '/repo');
      expect(detected).toMatchObject({
        mode: 'manual',
        stopReason: 'incomplete',
        candidates: [one],
      });
    },
  );
  it.each(['failed', 'exhausted'] as const)(
    'unavailable %s wave falls back without another invocation',
    async (mode) => {
      const final = await finishAutoClassification(
        ctx,
        state(),
        [result(1, null, mode === 'failed' ? 'failed' : 'done')],
        mode === 'exhausted',
      );
      expect(final!.result.complete).toBe(false);
    },
  );
  it('records results before consumption and selects only consequential eligible items', async () => {
    const two = { ...one, id: 'two', identity: 'web/core/a.php::two', location: 'web/core/a.php' };
    history.claims = [{ ...claim, insights: [one, two] }];
    const raw = {
      version: 1,
      batchId,
      items: [
        { id: 'one', class: 'nit', kind: 'regression', reason: 'r' },
        { id: 'two', class: 'minor', kind: 'security', reason: 'r' },
      ],
    };
    const final = await finishAutoClassification(
      ctx,
      { ...state(), dependencyPolicy: { drupal: true, drupalRoots: ['web'], ownedPaths: [] } },
      [result(1, raw)],
      false,
    );
    expect(auto.saveAutoClassification).toHaveBeenCalledOnce();
    expect(automaticSelection(final!.claim, final!.result)).toEqual([one]);
    expect(final!.result.items[1]).toMatchObject({
      class: 'consequential',
      eligible: false,
      outcome: 'needs_decision',
    });
  });
  it('a required classification write failure prevents any editor consumption', async () => {
    vi.mocked(auto.saveAutoClassification).mockRejectedValue(new Error('event refused'));
    await expect(
      finishAutoClassification(
        ctx,
        state(),
        [
          result(1, {
            version: 1,
            batchId,
            items: [{ id: 'one', class: 'consequential', kind: 'correctness', reason: 'reason' }],
          }),
        ],
        false,
      ),
    ).rejects.toThrow('event refused');
  });
  it('all minor/nit stops; aliases and already attempted identities buy no new classification', async () => {
    history.results = [
      {
        version: 1,
        batchId,
        sourceStepRowId: 'row',
        generation: 0,
        complete: true,
        items: [
          {
            id: 'one',
            identity: one.identity,
            class: 'minor',
            kind: 'correctness',
            eligible: true,
            outcome: 'left_minor',
            reason: 'reason',
          },
        ],
        invocationIds: [],
      },
    ];
    const detected = await detectAutoInsights(
      ctx,
      [one, { ...one, id: 'alias', location: 'src/a.ts:99' }],
      '/repo',
    );
    expect(detected).toMatchObject({
      mode: 'settled',
      candidates: [],
      stopReason: 'no_new_consequential',
    });
  });
  it('a fourth discovery is unclassified cap_reached and manual, never a fourth classify opportunity', async () => {
    history.claims = Array.from({ length: 3 }, (_, n) => ({
      ...claim,
      batchId: `old-${n}`,
      insights: [{ ...one, identity: `old-${n}` }],
    }));
    const detected = await detectAutoInsights(ctx, [one], '/repo');
    expect(detected).toMatchObject({
      mode: 'manual',
      roundsStarted: 3,
      stopReason: 'cap',
      decisions: [{ id: 'one', class: 'unclassified', outcome: 'cap_reached' }],
    });
    expect(await startAutoClassification(ctx, detected)).toEqual([]);
    expect(auto.claimAutoRound).not.toHaveBeenCalled();
  });
  it.each(['result without intent', 'claim without result'])(
    'Retry reoffers %s instead of settling it',
    async (window) => {
      const retried = { ...ctx, rerunGeneration: 1 };
      if (window === 'result without intent')
        history.results = [
          {
            version: 1,
            batchId,
            sourceStepRowId: 'row',
            generation: 0,
            complete: true,
            items: [
              {
                id: one.id,
                identity: one.identity,
                class: 'consequential',
                kind: 'correctness',
                eligible: true,
                outcome: 'unconfirmed',
                reason: 'repair',
              },
            ],
            invocationIds: ['classifier'],
          },
        ];
      const detected = await detectAutoInsights(retried, [one], '/repo');
      expect(detected).toMatchObject({
        mode: 'manual',
        candidates: [one],
        stopReason: 'pending_writer',
      });
      expect(await startAutoClassification(retried, detected)).toEqual([]);
      expect(auto.claimAutoRound).not.toHaveBeenCalled();
    },
  );
  it('a justified decline in round 1 permits a fresh consequential item to be classified and applied in round 2', async () => {
    history.results = [
      {
        version: 1,
        batchId,
        sourceStepRowId: 'row',
        generation: 0,
        complete: true,
        items: [
          {
            id: one.id,
            identity: one.identity,
            class: 'consequential',
            kind: 'correctness',
            eligible: true,
            outcome: 'unconfirmed',
            reason: 'repair',
          },
        ],
        invocationIds: [],
      },
    ];
    vi.mocked(batches.loadInsightBatchRecords).mockResolvedValue([
      { stage: 'intent', batchId, selected: [one] },
      {
        stage: 'outcome',
        batchId,
        selected: [one],
        items: [{ id: one.id, outcome: 'not_applied', changes: [], reason: 'Already correct' }],
      },
    ] as never);
    const nextCtx = { ...ctx, taskStepId: 'row-2', round: 2, logger: { info() {} } as never };
    const fresh = { ...one, id: 'fresh', identity: 'src/a.ts::fresh', title: 'Fresh' };
    const nextId = batches.insightBatchId('row-2', 0);
    const detected = await detectAutoInsights(nextCtx, [one, fresh], '/repo');
    expect(detected).toMatchObject({
      mode: 'classify',
      candidates: [fresh],
      stopReason: 'classifying',
    });
    const nextClaim = {
      ...claim,
      batchId: nextId,
      sourceStepRowId: 'row-2',
      ordinal: 2,
      insights: [fresh],
    };
    vi.mocked(auto.claimAutoRound).mockImplementationOnce(async () => {
      history.claims.push(nextClaim);
      return nextClaim;
    });
    expect(await startAutoClassification(nextCtx, detected)).toMatchObject([{ roleKey: 'triage' }]);
    // The location is safe and owned; probe policy is independent of the classifier's prose.
    detected.dependencyPolicy = state().dependencyPolicy;
    const intent = {
      version: 1,
      batchId: nextId,
      sourceStepRowId: 'row-2',
      generation: 0,
      mode: 'auto_08e',
      stage: 'intent',
      selected: [fresh],
      items: [],
      notes: '',
    };
    vi.spyOn(batches, 'ensureInsightIntent').mockResolvedValue(intent as never);
    vi.spyOn(batches, 'appendInsightBatch').mockImplementation(
      async (_ctx, record) => record as never,
    );
    const out = await insightsTriageStep.apply(nextCtx, {
      detected: {
        worktreePath: '/repo',
        sandboxWorktreePath: '/ws',
        spec: '',
        insights: [one, fresh],
        auto: detected,
      },
      formValues: {},
      iteration: 0,
      previousIterations: [],
      agentMiningResults: [
        {
          ...result(1, {
            version: 1,
            batchId: nextId,
            items: [
              { id: fresh.id, class: 'consequential', kind: 'correctness', reason: 'repair' },
            ],
          }),
          agentId: auto.classifierId(nextId, 1),
        },
        {
          ...result(1, {
            version: 1,
            batchId: nextId,
            notes: '',
            items: [{ id: fresh.id, outcome: 'applied', changes: ['Fixed'], reason: 'Repaired' }],
          }),
          agentId: `implementer-${nextId}`,
        },
      ],
    });
    expect(out).toMatchObject({
      selected: [fresh],
      implemented: true,
      automatic: { stopReason: 'no_new_consequential' },
    });
    const manual = await detectAutoInsights({ ...ctx, rerunGeneration: 1 }, [one], '/repo');
    expect(manual).toMatchObject({
      mode: 'manual',
      candidates: [one],
      stopReason: 'no_new_consequential',
    });
  });
  describe('completion preserves outstanding human decisions', () => {
    const fresh = { ...one, id: 'fresh', identity: 'src/a.ts::fresh', title: 'Fresh' };
    const blocked = {
      ...one,
      id: 'blocked',
      identity: 'vendor/lib.ts::blocked',
      title: 'Blocked',
      location: 'vendor/lib.ts',
    };
    let journal: batches.InsightBatchRecord[];
    let inventory: (typeof one)[];
    const flowCtx = {
      ...ctx,
      round: 0,
      workspacePath: '/repo',
      sandboxWorkdir: '/ws',
      logger: { info() {} } as never,
    } as StepContext;
    const applyArgs = (
      detected: Awaited<ReturnType<NonNullable<typeof insightsTriageStep.detect>>>,
      agentMiningResults: AgentMiningResult[] = [],
      selectedInsights: string[] = [],
    ) => ({
      detected,
      formValues: { selectedInsights },
      iteration: 0,
      previousIterations: [],
      agentMiningResults,
    });
    beforeEach(() => {
      flowCtx.rerunGeneration = 0;
      history.claims = [];
      journal = [];
      inventory = [one, fresh];
      vi.mocked(batches.loadInsightBatchRecords).mockImplementation(async () => journal);
      vi.spyOn(loader, 'loadUnactedInsights').mockImplementation(async () => ({
        insights: inventory,
        omitted: 0,
      }));
      vi.spyOn(auto, 'insightAutoEnabled').mockResolvedValue(true);
      vi.spyOn(previous, 'loadPreviousStepOutput').mockResolvedValue(null);
      vi.spyOn(specs, 'resolveSpecView').mockResolvedValue({ text: '' } as never);
      vi.spyOn(specs, 'hydrateNoSpecBrief').mockResolvedValue(undefined);
      vi.spyOn(secretPolicy, 'taskSecretMaskPolicy').mockResolvedValue({
        globs: { deny: [], ignore: [] },
      });
      vi.spyOn(safeFs, 'lstatNoFollow').mockResolvedValue({ kind: 'file' } as never);
      vi.mocked(auto.claimAutoRound).mockImplementation(async (_ctx, insights) => {
        const admitted = { ...claim, insights };
        history.claims.push(admitted);
        return admitted;
      });
      vi.spyOn(batches, 'ensureInsightIntent').mockImplementation(async (_ctx, selected, mode) => {
        const intent: batches.InsightBatchRecord = {
          version: 1,
          protocolVersion: 1,
          batchId: batches.insightBatchId(_ctx.taskStepId, _ctx.rerunGeneration ?? 0),
          sourceStepRowId: 'row',
          generation: _ctx.rerunGeneration ?? 0,
          mode: mode ?? 'manual_08e',
          stage: 'intent',
          selected,
          items: [],
          notes: '',
          miningId: null,
          invocationId: null,
        };
        const saved = journal.find((r) => r.batchId === intent.batchId && r.stage === 'intent');
        if (saved && JSON.stringify(saved.selected) !== JSON.stringify(selected))
          throw new Error(
            'This insight batch already has a different selection. Retry to start a new batch.',
          );
        if (saved) return saved;
        journal.push(intent);
        return intent;
      });
      vi.spyOn(batches, 'appendInsightBatch').mockImplementation(async (_ctx, record) => {
        const saved = journal.find((r) => r.batchId === record.batchId && r.stage === record.stage);
        if (saved) return saved;
        journal.push(record);
        return record;
      });
    });
    function earlier(kind: 'consequential' | 'minor' | 'nit') {
      history.results.push({
        version: 1,
        batchId: 'earlier',
        sourceStepRowId: 'earlier',
        generation: 0,
        complete: true,
        invocationIds: [],
        items: [
          {
            id: one.id,
            identity: one.identity,
            class: kind,
            kind: 'cosmetic',
            eligible: false,
            outcome: kind === 'consequential' ? 'needs_decision' : 'left_minor',
            reason: 'Requires an ownership decision',
          },
        ],
      });
    }
    async function classify(items: { id: string; class: string; kind: string; reason: string }[]) {
      const detected = await insightsTriageStep.detect!(flowCtx);
      expect(detected.auto).toMatchObject({ mode: 'classify' });
      expect(insightsTriageStep.form!(flowCtx, detected, null)).toMatchObject({
        autoSubmit: true,
        fields: [],
      });
      await insightsTriageStep.agentMining!.selectAgents({
        ctx: flowCtx,
        detected,
        formValues: {},
        llmOutput: null,
      });
      return { detected, classification: result(1, { version: 1, batchId, items }) };
    }
    async function manualSubmit(expected: (typeof one)[], selectedInsights: string[] = []) {
      // This is the actual detect/form pair used by the runner's reopen path, on the same row.
      const reopened = await insightsTriageStep.detect!(flowCtx);
      expect(reopened.auto).toMatchObject({ mode: 'manual', candidates: expected });
      const form = insightsTriageStep.form!(flowCtx, reopened, null)!;
      expect(form.autoSubmit).not.toBe(true);
      expect(form.fields[0]).toMatchObject({
        id: 'selectedInsights',
        options: expected.map((i) => expect.objectContaining({ value: i.id })),
      });
      const dispatched = await insightsTriageStep.agentMining!.selectAgents({
        ctx: flowCtx,
        detected: reopened,
        formValues: { selectedInsights },
        llmOutput: null,
      });
      expect(dispatched).toHaveLength(selectedInsights.length ? 1 : 0);
      const manualBatchId = batches.insightBatchId(
        flowCtx.taskStepId,
        flowCtx.rerunGeneration ?? 0,
      );
      const writer: AgentMiningResult[] = selectedInsights.length
        ? [
            {
              ...result(1, {
                version: 1,
                batchId: manualBatchId,
                items: selectedInsights.map((id) => ({
                  id,
                  outcome: 'not_applied',
                  changes: [],
                  reason: 'Leave this for later',
                })),
                notes: '',
              }),
              agentId: `implementer-${manualBatchId}`,
            },
          ]
        : [];
      const completed = await insightsTriageStep.apply(
        flowCtx,
        applyArgs(reopened, writer, selectedInsights),
      );
      expect(completed.continuation).toBeUndefined();
      expect(completed.implemented).toBe(false);
      return completed;
    }
    it('control 1: earlier ineligible consequential + new minor-only cohort reopens; empty submit completes', async () => {
      earlier('consequential');
      const { detected, classification } = await classify([
        { id: fresh.id, class: 'minor', kind: 'cosmetic', reason: 'Style only' },
      ]);
      expect(detected.auto!.candidates).toEqual([fresh]);
      await expect(
        insightsTriageStep.apply(flowCtx, applyArgs(detected, [classification])),
      ).rejects.toMatchObject({ name: 'ReopenStepFormError', notice: true, newAttempt: false });
      expect(auto.saveAutoClassification).toHaveBeenCalledOnce();
      const completed = await manualSubmit([one]);
      expect(completed.selected).toEqual([]);
      expect(auto.claimAutoRound).toHaveBeenCalledOnce();
    });
    it.each(['not_applied', 'unconfirmed'] as const)(
      'control 2: mixed cohort with writer %s reopens declined and ineligible items; manual submit completes',
      async (outcome) => {
        inventory = [fresh, blocked];
        const { detected, classification } = await classify([
          { id: fresh.id, class: 'consequential', kind: 'correctness', reason: 'Repair' },
          { id: blocked.id, class: 'consequential', kind: 'correctness', reason: 'Ownership' },
        ]);
        // The host's policy, not the model's claim, excludes the dependency path.
        detected.auto!.dependencyPolicy = {
          drupal: false,
          drupalRoots: [],
          ownedPaths: [],
        };
        const writer = {
          ...result(
            1,
            outcome === 'unconfirmed'
              ? 'invalid report'
              : {
                  version: 1,
                  batchId,
                  items: [{ id: fresh.id, outcome, changes: [], reason: 'Already correct' }],
                  notes: '',
                },
          ),
          agentId: `implementer-${batchId}`,
        };
        const reopened = await insightsTriageStep
          .apply(flowCtx, applyArgs(detected, [classification, writer]))
          .catch((err) => err);
        expect(reopened).toBeInstanceOf(ReopenStepFormError);
        expect(reopened.newAttempt).toBe(true);
        // The runner advances this in the same transaction as consuming the old writer rows.
        if (reopened.newAttempt) flowCtx.rerunGeneration! += 1;
        expect(journal.find((r) => r.stage === 'outcome')!.items).toMatchObject([
          { id: fresh.id, outcome },
        ]);
        await manualSubmit([fresh, blocked], [blocked.id]);
        expect(auto.claimAutoRound).toHaveBeenCalledOnce();
      },
    );
    it.each(['applied', 'minor', 'nit'] as const)(
      'control 3: earlier %s items do not reopen after a new minor cohort',
      async (kind) => {
        earlier(kind === 'applied' ? 'consequential' : kind);
        if (kind === 'applied') inventory = [fresh]; // The shared loader removes acted identities.
        const { detected, classification } = await classify([
          { id: fresh.id, class: 'minor', kind: 'cosmetic', reason: 'Style only' },
        ]);
        const completed = await insightsTriageStep.apply(
          flowCtx,
          applyArgs(detected, [classification]),
        );
        expect(completed).toMatchObject({ selected: [], implemented: false });
        expect(completed.continuation).toBeUndefined();
        const next = await insightsTriageStep.detect!(flowCtx);
        expect(next.auto!.mode).toBe('settled');
        expect(insightsTriageStep.form!(flowCtx, next, null)).toMatchObject({
          autoSubmit: true,
          fields: [],
        });
      },
    );
  });
  it('an interrupted writer requires a human before further new automatic work', async () => {
    vi.mocked(batches.loadInsightBatchRecords).mockResolvedValue([
      { stage: 'intent', batchId: 'old', selected: [one] } as never,
    ]);
    history.claims = [];
    expect(await detectAutoInsights(ctx, [one], '/repo')).toMatchObject({
      mode: 'manual',
      stopReason: 'interrupted',
    });
  });
  it('host location probes and secret policy reject symlinks, missing files and protected files', async () => {
    history.claims = [];
    vi.spyOn(secretPolicy, 'taskSecretMaskPolicy').mockResolvedValue({
      globs: { deny: ['**/.env'], ignore: [] },
    });
    const stat = vi.spyOn(safeFs, 'lstatNoFollow').mockResolvedValue({ kind: 'symlink' } as never);
    let detected = await detectAutoInsights(ctx, [one], '/repo');
    expect(detected.unsafeIds).toEqual(['one']);
    for (const kind of [null, { kind: 'directory' }]) {
      stat.mockResolvedValue(kind as never);
      detected = await detectAutoInsights(ctx, [one], '/repo');
      expect(detected.unsafeIds).toEqual(['one']);
    }
    stat.mockResolvedValue({ kind: 'file' } as never);
    detected = await detectAutoInsights(
      ctx,
      [one, { ...one, id: 'secret', identity: 'env', location: '.env' }],
      '/repo',
    );
    expect(detected.unsafeIds).toEqual(['secret']);
  });
  it('checks the real batch id at the exact classifier budget boundary before admission', async () => {
    history.claims = [];
    const realSize = auto.buildClassifierPrompt([one], undefined, batchId).length;
    const detected = await detectAutoInsights(ctx, [one], '/repo', { inputChars: realSize - 1 });
    expect(detected).toMatchObject({ mode: 'manual', stopReason: 'incomplete', candidates: [one] });
    expect(auto.claimAutoRound).not.toHaveBeenCalled();
  });
  it('forwards injected input bounds to the dispatched prompt on both classifier attempts', async () => {
    const build = vi.spyOn(auto, 'buildClassifierPrompt');
    const inputChars = auto.buildClassifierPrompt([one], undefined, batchId).length;
    build.mockClear();
    expect(await startAutoClassification(ctx, state(), { inputChars })).toMatchObject([
      { roleKey: 'triage' },
    ]);
    expect(build).toHaveBeenLastCalledWith([one], inputChars, batchId);
    await expect(
      finishAutoClassification(ctx, state(), [result(1, 'invalid')], false, { inputChars }),
    ).rejects.toBeInstanceOf(MiningWaveError);
    expect(build).toHaveBeenLastCalledWith([one], inputChars, batchId);
  });
  it('a smaller start-time input budget reoffers manually before claiming a round', async () => {
    history.claims = [];
    expect(await startAutoClassification(ctx, state(), { inputChars: 10 })).toEqual([]);
    expect(auto.claimAutoRound).not.toHaveBeenCalled();
    expect(history.results).toMatchObject([
      { complete: false, items: [{ id: one.id, class: 'unclassified' }] },
    ]);
    await expect(finishAutoClassification(ctx, state(), [], false)).rejects.toMatchObject({
      name: 'ReopenStepFormError',
    });
  });
  it('input coverage over an injected budget falls back whole, without spending a classifier round', async () => {
    history.claims = [];
    expect(await detectAutoInsights(ctx, [one], '/repo', { inputChars: 10 })).toMatchObject({
      mode: 'manual',
      stopReason: 'incomplete',
      candidates: [one],
      decisions: [{ class: 'unclassified' }],
    });
    expect(auto.claimAutoRound).not.toHaveBeenCalled();
  });
  it('labels application as an agent report, and never as a verified repair', () => {
    expect(
      autoInsightReport(
        [one],
        [
          {
            id: one.id,
            identity: one.identity,
            class: 'consequential',
            kind: 'regression',
            reason: 'r',
            eligible: true,
            outcome: 'unconfirmed',
          },
        ],
        [{ id: one.id, outcome: 'applied', changes: ['Change'], reason: 'r' }],
      ),
    ).toContain('applied (agent report)');
  });
  it('keeps already-classified minor/nit items listed when new cap-final items need manual decisions', async () => {
    history.claims = Array.from({ length: 3 }, (_, n) => ({
      ...claim,
      batchId: `old-${n}`,
      insights: [{ ...one, identity: `old-${n}` }],
    }));
    history.results = [
      {
        version: 1,
        batchId: 'old-0',
        sourceStepRowId: 'old',
        generation: 0,
        complete: true,
        items: [
          {
            id: one.id,
            identity: one.identity,
            class: 'minor',
            kind: 'cosmetic',
            eligible: true,
            outcome: 'left_minor',
            reason: 'style',
          },
        ],
        invocationIds: [],
      },
    ];
    const fresh = { ...one, id: 'fresh', identity: 'a.ts::fresh', title: 'Fresh' };
    const detected = await detectAutoInsights(ctx, [one, fresh], '/repo');
    expect(detected).toMatchObject({ mode: 'manual', stopReason: 'cap', candidates: [fresh] });
    expect(detected.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: one.id, class: 'minor', outcome: 'left_minor' }),
        expect.objectContaining({ id: 'fresh', class: 'unclassified', outcome: 'cap_reached' }),
      ]),
    );
  });
});
