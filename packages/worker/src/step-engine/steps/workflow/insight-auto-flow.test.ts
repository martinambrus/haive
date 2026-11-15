import * as secretPolicy from '../../../queues/cli-exec/secret-mask.js';
import * as safeFs from '@haive/shared/fs-safe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMiningResult, StepContext } from '../../step-definition.js';
import { MiningWaveError } from '../../step-definition.js';
import * as auto from './_insight-auto.js';
import * as batches from './_insight-batch.js';
import * as dependency from './_dependency-policy.js';
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
