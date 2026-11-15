import * as autoPolicy from './_insight-auto.js';
import * as batches from './_insight-batch.js';
import * as autoFlow from './_insight-auto-flow.js';
import * as loader from './_insight-loader.js';
import * as previous from '../onboarding/_helpers.js';
import * as specs from './_spec-artifact.js';
import { afterEach, expect, it, vi } from 'vitest';
import { insightsTriageStep } from './08e-insights-triage.js';
const insight = {
  id: 'one',
  identity: 'a.ts::one',
  legacyId: 'i-1',
  picked: false,
  sourceStep: 'review',
  title: 'One',
  location: 'a.ts',
  description: 'Detail',
};
const detected = {
  worktreePath: '/repo',
  sandboxWorktreePath: '/ws',
  spec: '',
  insights: [insight],
};
const automatic = {
  version: 1 as const,
  mode: 'classify' as const,
  candidates: [insight],
  roundsStarted: 0,
  decisions: [],
  stopReason: 'classifying' as const,
};
it('ON uses a zero-decision automatic form', () => {
  expect(
    insightsTriageStep.form!({} as never, { ...detected, auto: automatic }, null),
  ).toMatchObject({ fields: [], autoSubmit: true });
});
it('minor/nit settle without selecting a stale manual pre-answer or touching dispatch state', async () => {
  const d = {
    ...detected,
    auto: {
      ...automatic,
      mode: 'settled' as const,
      stopReason: 'no_new_consequential' as const,
      decisions: [
        {
          id: 'one',
          identity: insight.identity,
          class: 'nit' as const,
          kind: 'cosmetic' as const,
          reason: 'style',
          eligible: true,
          outcome: 'left_minor' as const,
        },
      ],
    },
  };
  vi.spyOn(autoPolicy, 'loadAutoHistory').mockResolvedValue({ claims: [], results: [] });
  vi.spyOn(batches, 'loadInsightBatchRecords').mockResolvedValue([]);
  vi.spyOn(loader, 'loadUnactedInsights').mockResolvedValue({ insights: [insight], omitted: 0 });
  const ctx = {
    db: {},
    taskId: 'task',
    taskStepId: 'row',
    throwIfCancelled() {},
    logger: { info() {} },
  } as never;
  expect(
    await insightsTriageStep.agentMining!.selectAgents({
      ctx,
      detected: d,
      formValues: { selectedInsights: ['one'] },
      llmOutput: null,
    }),
  ).toEqual([]);
  const out = await insightsTriageStep.apply(ctx, {
    detected: d,
    formValues: { selectedInsights: ['one'] },
    iteration: 0,
    previousIterations: [],
  });
  expect(out).toMatchObject({ implemented: false, selected: [] });
  expect(out.findingsSummary).toContain('nit');
  expect(out.findingsSummary).toContain('left_minor');
});
it('cap-final discoveries are visibly unclassified cap_reached, with real manual checkboxes', () => {
  const d = {
    ...detected,
    auto: {
      ...automatic,
      mode: 'manual' as const,
      roundsStarted: 3,
      stopReason: 'cap' as const,
      decisions: [
        {
          id: 'one',
          identity: insight.identity,
          class: 'unclassified' as const,
          kind: null,
          reason: 'cap',
          eligible: false,
          outcome: 'cap_reached' as const,
        },
      ],
    },
  };
  const form = insightsTriageStep.form!({} as never, d, null)!;
  expect(form.autoSubmit).not.toBe(true);
  expect(form.fields[0]).toMatchObject({ id: 'selectedInsights', options: [{ value: 'one' }] });
  expect(form.infoSections?.[0]?.body).toContain('unclassified');
  expect(form.infoSections?.[0]?.body).toContain('cap_reached');
});
it('refuses an unknown stored automatic protocol before offering or dispatching', async () => {
  const d = { ...detected, auto: { ...automatic, version: 2 } };
  expect(() => insightsTriageStep.form!({} as never, d as never, null)).toThrow(
    /Unsupported automatic insight/,
  );
  await expect(
    insightsTriageStep.agentMining!.selectAgents({
      ctx: {} as never,
      detected: d,
      formValues: {},
      llmOutput: null,
    }),
  ).rejects.toThrow(/Unsupported automatic insight/);
});
it('OFF retains its exact unchecked manual form and zero-dispatch empty submit', async () => {
  const form = insightsTriageStep.form!({} as never, detected, null);
  expect(form).toEqual({
    title: 'Insight triage',
    description:
      'Agents surfaced 1 optional improvement(s) during this run.\nSelect any to implement now (leave all unchecked to skip). Selected items are applied by\none agent and re-verified at the next gate.',
    fields: [
      {
        type: 'multi-select',
        id: 'selectedInsights',
        label: 'Improvements to implement',
        options: [{ value: 'one', label: 'One (a.ts)', badge: 'review', group: 'review' }],
        defaults: [],
      },
    ],
    submitLabel: 'Apply selected',
  });
  expect(
    await insightsTriageStep.agentMining!.selectAgents({
      ctx: {} as never,
      detected,
      formValues: { selectedInsights: [] },
      llmOutput: null,
    }),
  ).toEqual([]);
});

afterEach(() => vi.restoreAllMocks());
it('automatic ownership is checked on the actual writer workspace, even with an old setup output', async () => {
  vi.spyOn(autoPolicy, 'insightAutoEnabled').mockResolvedValue(true);
  vi.spyOn(loader, 'loadUnactedInsights').mockResolvedValue({ insights: [insight], omitted: 0 });
  vi.spyOn(previous, 'loadPreviousStepOutput').mockResolvedValue({
    output: { worktreePath: '/stale' },
  } as never);
  vi.spyOn(specs, 'resolveSpecView').mockResolvedValue({ text: 'context' } as never);
  vi.spyOn(specs, 'resolveTaskWorktreePath').mockResolvedValue('/repo/.haive/worktrees/feat');
  const detect = vi.spyOn(autoFlow, 'detectAutoInsights').mockResolvedValue(automatic);
  const ctx = {
    db: {},
    round: 0,
    taskId: 'task',
    workspacePath: '/repo',
    sandboxWorkdir: '/ws',
    throwIfCancelled() {},
  } as never;
  const out = await insightsTriageStep.detect!(ctx);
  expect(out.worktreePath).toBe('/repo/.haive/worktrees/feat');
  expect(detect).toHaveBeenCalledWith(ctx, [insight], '/repo/.haive/worktrees/feat');
});

it('automatic ownership falls back to the repository root only for a task without a worktree', async () => {
  vi.spyOn(autoPolicy, 'insightAutoEnabled').mockResolvedValue(true);
  vi.spyOn(loader, 'loadUnactedInsights').mockResolvedValue({ insights: [insight], omitted: 0 });
  vi.spyOn(previous, 'loadPreviousStepOutput').mockResolvedValue(null as never);
  vi.spyOn(specs, 'resolveSpecView').mockResolvedValue({ text: 'context' } as never);
  vi.spyOn(specs, 'resolveTaskWorktreePath').mockResolvedValue(null);
  const detect = vi.spyOn(autoFlow, 'detectAutoInsights').mockResolvedValue(automatic);
  const ctx = {
    db: {},
    round: 0,
    taskId: 'task',
    workspacePath: '/repo',
    sandboxWorkdir: '/ws',
    throwIfCancelled() {},
  } as never;
  const out = await insightsTriageStep.detect!(ctx);
  expect(out.worktreePath).toBe('/repo');
  expect(detect).toHaveBeenCalledWith(ctx, [insight], '/repo');
});
