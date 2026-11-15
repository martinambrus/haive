import { describe, expect, it, vi } from 'vitest';
import * as specAdapters from '../src/step-engine/steps/workflow/_spec-artifact.js';
import { runConfigStep } from '../src/step-engine/steps/workflow/06-run-config.js';
import { testManagementStep } from '../src/step-engine/steps/workflow/08b-test-management.js';
import { configService } from '@haive/shared';
import { randomUUID } from 'node:crypto';
import { CORE_COMPOSABLE_STEPS } from '../src/step-engine/composable-core.js';
import { composableStepEntrySchema, validatePromptStep } from '@haive/shared/modularity';
import { assertPinnedCandidateSupport } from '../src/queues/run-list.js';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { SPEC_ROLES, STEP_ROLE_REGISTRY } from '@haive/shared/step-outputs';
import { readRole, legacyRoleOutput } from '../src/step-engine/read-role.js';
import {
  resolveApprovedSpec,
  readSpecStages,
  effectiveSpec,
} from '../src/step-engine/steps/workflow/_spec-artifact.js';
import { loadPreviousStepOutput } from '../src/step-engine/steps/onboarding/_helpers.js';
import {
  gate1SpecApprovalStep,
  buildSpecSummary,
} from '../src/step-engine/steps/workflow/06-gate-1-spec-approval.js';
import { phase0bPrePlanningStep } from '../src/step-engine/steps/workflow/04-phase-0b-pre-planning.js';
import { phase0b5SpecQualityStep } from '../src/step-engine/steps/workflow/05-phase-0b5-spec-quality.js';
import { resolveSpecWarningsStep } from '../src/step-engine/steps/workflow/05a-resolve-spec-warnings.js';
import type { StepContext } from '../src/step-engine/step-definition.js';

vi.mock('../src/step-engine/steps/workflow/_spec-feedback.js', () => ({
  loadOutstandingSpecFeedback: async () => '',
}));
vi.mock('../src/step-engine/review-dimension-context.js', () => ({
  resolveTaskReviewDimensions: async () => ({ enabled: [] }),
  dimensionScopeLines: () => [],
}));
vi.mock('../src/step-engine/steps/workflow/_impl-changes.js', async (original) => ({
  ...(await original<object>()),
  collectImplementationFiles: async () => ({ files: [], total: 0, truncated: false }),
}));
vi.mock('../src/step-engine/steps/workflow/_plan-impact.js', async (original) => ({
  ...(await original<object>()),
  loadPlanImpactContext: async () => null,
}));
vi.mock('../src/step-engine/workspace-probe.js', () => ({ hasWorkspaceEntry: async () => false }));
vi.mock('../src/step-engine/steps/env-replicate/_shared.js', async (original) => ({
  ...(await original<object>()),
  getTaskEnvTemplate: async () => null,
}));
vi.mock('../src/step-engine/steps/workflow/_task-meta.js', async (original) => ({
  ...(await original<object>()),
  resolveDdevWorkspace: async () => null,
  loadDeclaredVerifyCommands: async () => null,
}));
vi.mock('@haive/shared/fs-safe', async (original) => ({
  ...(await original<object>()),
  writeFileNoFollow: vi.fn(),
}));

const taskId = 'aaaaaaaa-0000-4000-8000-000000000001';
function fixture() {
  const fake = createFakeDb({ tasks: schema.tasks, taskSteps: schema.taskSteps });
  fake.insert(schema.tasks, {
    id: taskId,
    title: 'Task',
    description: 'Brief',
    repositoryId: null,
    stepLoopLimits: {},
  });
  const ctx = {
    db: fake.db as unknown as Database,
    taskId,
    repoPath: '/unused',
    workspacePath: '/unused',
    sandboxWorkdir: '/workspace',
    logger: { warn: vi.fn() },
  } as unknown as StepContext;
  function put(
    role: (typeof SPEC_ROLES)[keyof typeof SPEC_ROLES],
    output: unknown,
    round = 0,
    status = 'done',
  ) {
    const stepId = STEP_ROLE_REGISTRY[role].legacyStepId;
    const id = randomUUID();
    fake.insert(schema.taskSteps, { id, taskId, stepId, round, status, output, iterations: [] });
    return id;
  }
  return { fake, ctx, put };
}
const oldSpec = async (ctx: StepContext, maxRound?: number) => {
  const [draft, checked, resolved] = await Promise.all(
    Object.values(SPEC_ROLES).map((role) =>
      loadPreviousStepOutput(ctx.db, ctx.taskId, STEP_ROLE_REGISTRY[role].legacyStepId, maxRound),
    ),
  );
  return (
    ((resolved?.output as { spec?: string } | null)?.spec ??
      (checked?.output as { spec?: string } | null)?.spec ??
      (draft?.output as { spec?: string } | null)?.spec) ||
    ''
  );
};

describe('canonical role reader preserves physical selection', () => {
  it('distinguishes absent, not-ready, invalid and ready with producer metadata', async () => {
    const { ctx, put } = fixture();
    expect(await readRole(ctx, SPEC_ROLES.draft)).toMatchObject({
      state: 'absent',
      producer: null,
    });
    const id = put(SPEC_ROLES.draft, { spec: 'draft', extension: 'hidden' }, 0);
    const ready = await readRole(ctx, SPEC_ROLES.draft);
    expect(ready).toMatchObject({
      state: 'ready',
      data: { spec: 'draft' },
      producer: { rowId: id, stepId: '04-phase-0b-pre-planning', round: 0, status: 'done' },
      contract: { id: 'haive.spec.draft', version: 1 },
    });
    expect(legacyRoleOutput(ready)).toEqual({ spec: 'draft' });
    put(SPEC_ROLES.draft, { spec: 42 }, 1);
    expect(await readRole(ctx, SPEC_ROLES.draft)).toMatchObject({
      state: 'invalid',
      issuePaths: ['spec'],
      producer: { round: 1 },
    });
    put(SPEC_ROLES.draft, null, 2, 'pending');
    expect(await readRole(ctx, SPEC_ROLES.draft)).toMatchObject({
      state: 'not-ready',
      producer: { round: 2 },
    });
    expect(await readRole(ctx, SPEC_ROLES.draft, 0)).toMatchObject({
      state: 'ready',
      producer: { rowId: id, round: 0 },
    });
  });
  it('projects nested declared fields while leaving storage extensions intact', async () => {
    const { ctx, put } = fixture();
    const output = {
      spec: 's',
      affectedComponents: {
        named: [{ id: 'n', title: 'N', parentTitle: null, extension: 'hidden' }],
        reached: [],
        truncated: null,
        extension: 'hidden',
      },
      extension: 'hidden',
    };
    put(SPEC_ROLES.draft, output);
    expect(legacyRoleOutput(await readRole(ctx, SPEC_ROLES.draft))).toEqual({
      spec: 's',
      affectedComponents: {
        named: [{ id: 'n', title: 'N', parentTitle: null }],
        reached: [],
        truncated: null,
      },
    });
    expect(
      (await loadPreviousStepOutput(ctx.db, ctx.taskId, '04-phase-0b-pre-planning'))!.output,
    ).toEqual(output);
  });
});

const cases = [
  { name: 'no-spec quick path', draft: null, checked: null, resolved: null },
  {
    name: 'draft only / quality skipped',
    draft: { spec: 'draft', summary: 'summary' },
    checked: null,
    resolved: null,
  },
  { name: 'checked', draft: { spec: 'draft' }, checked: { spec: 'checked' }, resolved: null },
  {
    name: 'resolved',
    draft: { spec: 'draft' },
    checked: { spec: 'checked' },
    resolved: { spec: 'resolved' },
  },
  {
    name: 'intentionally empty resolved',
    draft: { spec: 'draft' },
    checked: { spec: 'checked' },
    resolved: { spec: '' },
  },
  {
    name: 'absent resolved spec',
    draft: { spec: 'draft' },
    checked: { spec: 'checked' },
    resolved: { scopeQuestions: ['question'] },
  },
  { name: 'old summary-only draft', draft: { summary: 'summary' }, checked: null, resolved: null },
];
describe('effective spec equivalence', () => {
  it.each(cases)('$name', async ({ draft, checked, resolved }) => {
    const { ctx, put } = fixture();
    if (draft) put(SPEC_ROLES.draft, draft);
    if (checked) put(SPEC_ROLES.checked, checked);
    if (resolved) put(SPEC_ROLES.resolved, resolved);
    expect(await resolveApprovedSpec(ctx)).toBe(await oldSpec(ctx));
  });
  it('does not borrow an older success after Retry; respects explicit ceilings', async () => {
    const { ctx, put } = fixture();
    put(SPEC_ROLES.draft, { spec: 'draft' });
    put(SPEC_ROLES.checked, { spec: 'checked' });
    put(SPEC_ROLES.resolved, { spec: 'resolved' });
    put(SPEC_ROLES.resolved, null, 2, 'pending');
    expect(await resolveApprovedSpec(ctx)).toBe('checked');
    expect(await resolveApprovedSpec(ctx)).toBe(await oldSpec(ctx));
    expect(effectiveSpec(await readSpecStages(ctx, 1))).toBe('resolved');
    expect(effectiveSpec(await readSpecStages(ctx, 1))).toBe(await oldSpec(ctx, 1));
  });
  it('uses the draft when a persisted 05 row is skipped with no output', async () => {
    const { ctx, put } = fixture();
    put(SPEC_ROLES.draft, { spec: 'draft' });
    put(SPEC_ROLES.checked, null, 0, 'skipped');
    expect(await resolveApprovedSpec(ctx)).toBe(await oldSpec(ctx));
    expect(await resolveApprovedSpec(ctx)).toBe('draft');
  });
  it('retains output from a non-done canonical row just as L did', async () => {
    const { ctx, put } = fixture();
    put(SPEC_ROLES.resolved, { spec: 'retained' }, 1, 'skipped');
    expect(await resolveApprovedSpec(ctx)).toBe(await oldSpec(ctx));
    expect(await resolveApprovedSpec(ctx)).toBe('retained');
  });
});

describe('converted stage consumers use their original fallback operators', () => {
  it.each(cases)('gate 1: $name', async ({ draft, checked, resolved }) => {
    const { ctx, put } = fixture();
    if (draft) put(SPEC_ROLES.draft, draft);
    if (checked) put(SPEC_ROLES.checked, checked);
    if (resolved) put(SPEC_ROLES.resolved, resolved);
    const out = await gate1SpecApprovalStep.detect!(ctx);
    const d = draft as { spec?: string; summary?: string } | null;
    const c = checked as { spec?: string } | null;
    const r = resolved as { spec?: string; scopeQuestions?: string[] } | null;
    const body = r?.spec ?? c?.spec ?? d?.spec ?? d?.summary ?? '';
    expect(out).toEqual({
      scopeQuestions: r?.scopeQuestions ?? [],
      specBody: body,
      specSummary: buildSpecSummary(body),
      qualityScore: null,
      qualityVerdict: null,
      qualityFindings: [],
      iterationHistory: [],
      exhaustedBudget: false,
      affectedComponents: null,
      repositoryId: null,
    });
  });
  it('05a still falls back to the draft for an empty checked spec', async () => {
    const { ctx, put } = fixture();
    put(SPEC_ROLES.draft, { spec: 'draft' });
    put(SPEC_ROLES.checked, { spec: '' });
    expect(await resolveSpecWarningsStep.detect!(ctx)).toMatchObject({ spec: 'draft' });
    expect(await resolveApprovedSpec(ctx)).toBe('');
  });
  it('gate 1 retains quality findings, scores, questions, iterations and draft impact', async () => {
    const { ctx, put, fake } = fixture();
    const impact = { named: [], reached: [], truncated: null, diagrams: [] };
    put(SPEC_ROLES.draft, { spec: 'draft', summary: 'summary', affectedComponents: impact });
    const id = put(SPEC_ROLES.checked, {
      spec: 'checked',
      score: 8,
      verdict: 'APPROVED',
      findings: [{ severity: 'high', dimension: 'scope', comment: 'gap' }],
      scopeQuestions: ['q'],
    });
    fake.patch(schema.taskSteps, id, {
      iterations: [
        { iteration: 0, exhaustedBudget: true, applyOutput: { score: 8, verdict: 'APPROVED' } },
      ],
    });
    put(SPEC_ROLES.resolved, { spec: 'resolved', scopeQuestions: ['q', 'r'] });
    expect(await gate1SpecApprovalStep.detect!(ctx)).toMatchObject({
      specBody: 'resolved',
      qualityScore: 8,
      qualityVerdict: 'APPROVED',
      qualityFindings: ['[HIGH] scope: gap'],
      scopeQuestions: ['q', 'r'],
      affectedComponents: impact,
      exhaustedBudget: true,
    });
  });
  it.each(cases)('05 and 05a: $name', async ({ draft, checked }) => {
    const { ctx, put } = fixture();
    if (draft) put(SPEC_ROLES.draft, draft);
    if (checked) put(SPEC_ROLES.checked, checked);
    const d = draft as { spec?: string; summary?: string } | null;
    const c = checked as { spec?: string } | null;
    expect(await phase0b5SpecQualityStep.detect!(ctx)).toMatchObject({
      spec: d?.spec ?? '',
      specSummary: d?.summary ?? '',
      specLength: (d?.spec ?? '').length,
    });
    expect(await resolveSpecWarningsStep.detect!(ctx)).toMatchObject({
      spec: c?.spec || (d?.spec ?? d?.summary ?? ''),
      findings: [],
      blockingCount: 0,
      advisoryCount: 0,
    });
  });
});

it('keeps mixed spec producers unquotable and outside executable host policy', () => {
  const quotableStepIds = new Set(
    CORE_COMPOSABLE_STEPS.filter((e) => e.agentAuthoredOutput).map((e) => e.stepId),
  );
  const producers = Object.values(SPEC_ROLES).map((role) => STEP_ROLE_REGISTRY[role].legacyStepId);
  for (const step of producers) {
    expect(
      validatePromptStep(
        { template: '{{step:' + step + '}}', capabilities: [], timeoutMs: 300000 },
        {
          typeSlug: 'spec-check',
          requiresRepository: true,
          stepIdsBefore: producers,
          quotableStepIds,
        },
      ).map((p) => p.kind),
    ).toEqual(['step-token-not-quotable']);
  }
  const get = vi.fn();
  assertPinnedCandidateSupport(
    {
      roleBindings: {
        [SPEC_ROLES.draft]: {
          stepId: producers[0],
          outputContract: STEP_ROLE_REGISTRY[SPEC_ROLES.draft].contract,
        },
      },
    } as never,
    { get },
  );
  expect(get).not.toHaveBeenCalled();
});

it('catalog serialization never persists spec output contracts or activates runner validation', () => {
  for (const step of [phase0bPrePlanningStep, phase0b5SpecQualityStep, resolveSpecWarningsStep]) {
    expect(step.outputContract).toBeUndefined();
    const entry = CORE_COMPOSABLE_STEPS.find((e) => e.stepId === step.metadata.id)!;
    expect(entry.outputContract).toBeUndefined();
  }
  // Catalog reads and derived admission use this same entry decoder. Serialized pins
  // must remain readable by the base contract decoder (review/audit references only).
  const serialized = CORE_COMPOSABLE_STEPS.map((e) => composableStepEntrySchema.parse(e));
  expect(serialized.flatMap((e) => (e.outputContract ? [e.outputContract.id] : []))).not.toEqual(
    expect.arrayContaining(Object.values(SPEC_ROLES)),
  );
  expect(
    serialized.every((e) => !e.outputContract || !e.outputContract.id.startsWith('haive.spec.')),
  ).toBe(true);
});

describe('remaining spec consumers use the shared adapters', () => {
  const readStages = vi.spyOn(specAdapters, 'readSpecStages');
  const approvedSpec = vi.spyOn(specAdapters, 'resolveApprovedSpec');
  it.each(cases)('run config: $name', async ({ draft, checked, resolved }) => {
    const { ctx, put } = fixture();
    if (draft) put(SPEC_ROLES.draft, draft);
    if (checked) put(SPEC_ROLES.checked, checked);
    if (resolved) put(SPEC_ROLES.resolved, resolved);
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
    readStages.mockClear();
    const out = await runConfigStep.detect!(ctx);
    expect(out.specBody).toBe(await oldGateSpec(ctx));
    expect(readStages).toHaveBeenCalledWith(ctx);
  });
  it.each(cases)('test management: $name', async ({ draft, checked, resolved }) => {
    const { ctx, put } = fixture();
    if (draft) put(SPEC_ROLES.draft, draft);
    if (checked) put(SPEC_ROLES.checked, checked);
    if (resolved) put(SPEC_ROLES.resolved, resolved);
    approvedSpec.mockClear();
    const out = await testManagementStep.detect!(ctx);
    expect(out.spec).toBe(await oldSpec(ctx));
    expect(approvedSpec).toHaveBeenCalledWith(ctx);
  });
});
// Base 06-run-config detect read/formula at 253f30214; independent physical selectors.
async function oldGateSpec(ctx: StepContext) {
  const plan = await loadPreviousStepOutput(ctx.db, ctx.taskId, '04-phase-0b-pre-planning');
  const quality = await loadPreviousStepOutput(ctx.db, ctx.taskId, '05-phase-0b5-spec-quality');
  const resolved = await loadPreviousStepOutput(ctx.db, ctx.taskId, '05a-resolve-spec-warnings');
  const planOutput = (plan?.output as { spec?: string; summary?: string } | null) ?? {};
  const qualityOutput = (quality?.output as { spec?: string } | null) ?? {};
  const resolvedOutput = (resolved?.output as { spec?: string } | null) ?? {};
  return resolvedOutput.spec ?? qualityOutput.spec ?? planOutput.spec ?? planOutput.summary ?? '';
}

it.each(['08c-code-review', '08c2-code-audit'] as const)(
  'refuses host-policy role %s until pinned resolution is supported',
  async (role) => {
    const { ctx } = fixture();
    // @ts-expect-error canonical spec reader cannot resolve legacy host-policy bindings
    await expect(readRole(ctx, role)).rejects.toThrow('host-policy');
  },
);
