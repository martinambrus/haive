import { describe, expect, it } from 'vitest';
import {
  MAX_DERIVED_CHANGES,
  derivedChangesSchema,
  createDerivedChangesSchema,
  evaluateDerivedTaskType,
  parsePromptSteps,
  type ComposableStepEntry,
  type DerivedChange,
} from '../src/modularity/index.js';
import {
  derivedBaseEligibility,
  workflowBaseCandidates,
  catalogWorkflowBaseCandidates,
  baseCandidateParityIssues,
} from '../src/step-engine/run-list.js';
import { EXECUTION_PATHS } from '../src/schemas/tasks.js';

const prefix = ['00-model-health-workflow', '00a-sync-base', '00-triage'];
const entry = (stepId: string, extra: Partial<ComposableStepEntry> = {}): ComposableStepEntry => ({
  stepId,
  label: stepId,
  group: 'test',
  dispatchesCli: false,
  requires: [],
  provides: [],
  ...extra,
});
const entries = [...prefix, 'a', 'b', 'c', 'x', 'y', 'module.example.check'].map((id) => entry(id));
const catalog = new Map(entries.map((e) => [e.stepId, e]));
const installedStepIds = new Set(catalog.keys());
const baseCandidates = [
  { executionPath: null, stepIds: [...prefix, 'a', 'b'] },
  { executionPath: 'quick_bugfix' as const, stepIds: [...prefix, 'a'] },
];
const evaluate = (changes: DerivedChange[]) =>
  evaluateDerivedTaskType({
    baseCandidates,
    changes,
    catalog,
    installedStepIds,
  });
const statuses = (result: ReturnType<typeof evaluate>, candidate = 0) =>
  result.candidates[candidate]!.outcomes.map((o) => o.outcome);

describe('derived overlay contracts', () => {
  it('pins the production operation bound and tests empty and small injected bounds', () => {
    expect(MAX_DERIVED_CHANGES).toBe(64);
    expect(derivedChangesSchema.parse([])).toEqual([]);
    const small = createDerivedChangesSchema(2);
    expect(small.safeParse([{ remove: 'a' }, { remove: 'b' }]).success).toBe(true);
    expect(small.safeParse([{ remove: 'a' }, { remove: 'b' }, { remove: 'c' }]).success).toBe(
      false,
    );
    expect(createDerivedChangesSchema(0).safeParse([{ remove: 'a' }]).success).toBe(false);
  });

  it.each([
    { replace: 'a', with: 'module.example.check' },
    { insertAfter: 'a', step: 'custom.example.check' },
    { remove: 'a' },
  ])('parses each strict operation %j', (change) => {
    expect(derivedChangesSchema.parse([change])).toEqual([change]);
    expect(derivedChangesSchema.safeParse([{ ...change, extra: true }]).success).toBe(false);
  });

  it.each([
    {},
    { replace: 'a' },
    { insertAfter: 'a' },
    { remove: 'a', with: 'b' },
    { remove: 'a', insertAfter: 'b', step: 'x' },
    { remove: '' },
    { remove: 'module.bad' },
    { remove: 'A' },
    { remove: 'a'.repeat(129) },
    { insertAfter: 'a', step: 'a'.repeat(129) },
    { replace: 'a', with: 'bad.id' },
  ])('rejects malformed operations and IDs %j', (change) => {
    expect(derivedChangesSchema.safeParse([change]).success).toBe(false);
  });

  it('accepts a valid 128-character id at the storage boundary', () => {
    expect(derivedChangesSchema.safeParse([{ remove: 'a'.repeat(128) }]).success).toBe(true);
  });
});

describe('derived overlay evaluation', () => {
  it('inserts and removes in order, allowing an inserted step to anchor a later operation', () => {
    const result = evaluate([
      { insertAfter: 'a', step: 'x' },
      { insertAfter: 'x', step: 'y' },
      { remove: 'b' },
    ]);
    expect(result.issues).toEqual([]);
    expect(result.candidates.map((c) => c.stepIds)).toEqual([
      [...prefix, 'a', 'x', 'y'],
      [...prefix, 'a', 'x', 'y'],
    ]);
    expect(statuses(result)).toEqual(['applied', 'applied', 'applied']);
    expect(statuses(result, 1)).toEqual(['applied', 'applied', 'path-absent']);
    expect(result.candidates[0]!.outcomes[1]).toMatchObject({
      operationIndex: 1,
      change: { insertAfter: 'x', step: 'y' },
      reason: 'change-applied',
    });
  });

  it('puts a later insert nearest the same surviving anchor', () => {
    expect(
      evaluate([
        { insertAfter: 'a', step: 'x' },
        { insertAfter: 'a', step: 'y' },
      ]).candidates[0]!.stepIds,
    ).toEqual([...prefix, 'a', 'y', 'x', 'b']);
  });

  it('distinguishes path-absent, stale and consumed anchors without aliasing', () => {
    const result = evaluate([
      { remove: 'b' },
      { insertAfter: 'b', step: 'x' },
      { remove: 'old-name' },
    ]);
    expect(statuses(result)).toEqual(['applied', 'refused', 'stale-target']);
    expect(statuses(result, 1)).toEqual(['path-absent', 'path-absent', 'stale-target']);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        kind: 'target-removed-by-change',
        executionPath: null,
        operationIndex: 1,
        stepId: 'b',
      }),
    );
    expect(result.warnings).toHaveLength(2);
    expect(result.candidates[0]!.stepIds).toEqual([...prefix, 'a']);
  });

  it.each(['b', 'old-name'])(
    'propagates a producer skip through chained anchors from %s',
    (anchor) => {
      const result = evaluate([
        { insertAfter: anchor, step: 'x' },
        { insertAfter: 'x', step: 'y' },
        { remove: 'y' },
      ]);
      const expected = anchor === 'b' ? 'path-absent' : 'stale-target';
      expect(statuses(result, 1)).toEqual([expected, expected, expected]);
      const outcomes = result.candidates[1]!.outcomes;
      expect(outcomes[1]).toMatchObject({ reason: outcomes[0]!.reason, causedByOperation: 0 });
      expect(outcomes[2]).toMatchObject({ reason: outcomes[0]!.reason, causedByOperation: 0 });
      expect(result.issues).toEqual([]);
    },
  );

  it('does not reinterpret an existing base ID as a skipped inserted alias', () => {
    const result = evaluate([{ insertAfter: 'old-name', step: 'b' }, { remove: 'b' }]);
    expect(statuses(result)).toEqual(['stale-target', 'applied']);
    expect(statuses(result, 1)).toEqual(['stale-target', 'path-absent']);
    expect(result.issues).toEqual([]);
  });

  it('permits a removed ID to be explicitly reintroduced before use as an anchor', () => {
    const result = evaluate([
      { remove: 'b' },
      { insertAfter: 'a', step: 'b' },
      { insertAfter: 'b', step: 'x' },
    ]);
    expect(result.candidates[0]!.stepIds).toEqual([...prefix, 'a', 'b', 'x']);
    expect(result.issues).toEqual([]);
    expect(statuses(result)).toEqual(['applied', 'applied', 'applied']);
    expect(statuses(result, 1)).toEqual(['path-absent', 'applied', 'applied']);
  });

  it('refuses every active replacement even for equal token declarations or a no-op', () => {
    for (const payload of ['x', 'a']) {
      const result = evaluate([{ replace: 'a', with: payload }]);
      expect(statuses(result)).toEqual(['refused']);
      expect(result.issues).toHaveLength(2);
      expect(result.issues.every((i) => i.kind === 'replacement-contract-unavailable')).toBe(true);
      expect(result.candidates[0]!.stepIds).toEqual(baseCandidates[0]!.stepIds);
    }
  });

  it('skips inactive replacements and does not alias a refused replacement', () => {
    const result = evaluate([
      { replace: 'b', with: 'x' },
      { insertAfter: 'x', step: 'y' },
      { replace: 'old-name', with: 'not-installed' },
    ]);
    expect(statuses(result)).toEqual(['refused', 'refused', 'stale-target']);
    expect(statuses(result, 1)).toEqual(['path-absent', 'path-absent', 'stale-target']);
    expect(result.issues.map((i) => i.kind)).toEqual(['replacement-contract-unavailable']);
    expect(result.candidates[0]!.stepIds).toEqual(baseCandidates[0]!.stepIds);
  });

  it('reports duplicate final IDs through both overlay and composition diagnostics', () => {
    const result = evaluate([{ insertAfter: 'a', step: 'a' }]);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ kind: 'duplicate-resulting-id', stepId: 'a' }),
    );
    expect(result.candidates[0]!.compositionIssues).toContainEqual(
      expect.objectContaining({ kind: 'duplicate-step', stepId: 'a' }),
    );
  });

  it('refuses a missing active payload but does not diagnose payloads on skipped operations', () => {
    const result = evaluate([{ insertAfter: 'b', step: 'not-installed' }]);
    expect(statuses(result)).toEqual(['refused']);
    expect(statuses(result, 1)).toEqual(['path-absent']);
    expect(result.issues).toEqual([
      expect.objectContaining({
        kind: 'missing-installed-step',
        executionPath: null,
        operationIndex: 0,
        stepId: 'not-installed',
      }),
    ]);
  });

  it('checks installed base IDs and keeps unknown composable declarations visible', () => {
    const result = evaluateDerivedTaskType({
      baseCandidates,
      changes: [],
      catalog: new Map([...catalog].filter(([id]) => id !== 'b')),
      installedStepIds: new Set([...installedStepIds].filter((id) => id !== 'a')),
    });
    expect(result.issues).toContainEqual(
      expect.objectContaining({ kind: 'missing-installed-step', stepId: 'a' }),
    );
    expect(result.candidates[0]!.compositionIssues).toContainEqual({
      kind: 'unknown-step',
      index: 4,
      stepId: 'b',
    });
  });

  it.each([
    ...prefix.map((remove) => ({ remove })),
    ...prefix.map((replace) => ({ replace, with: 'x' })),
    ...prefix.slice(0, 2).map((insertAfter) => ({ insertAfter, step: 'x' })),
  ])('refuses protected prefix edits %j', (change) => {
    const result = evaluate([change]);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ kind: 'protected-prefix-edit', operationIndex: 0 }),
    );
    expect(result.candidates[0]!.stepIds).toEqual(baseCandidates[0]!.stepIds);
  });

  it('allows insertion after triage and refuses a malformed base prefix', () => {
    expect(evaluate([{ insertAfter: prefix[2]!, step: 'x' }]).issues).toEqual([]);
    expect(
      evaluateDerivedTaskType({
        baseCandidates: [{ executionPath: null, stepIds: ['a'] }],
        changes: [],
        catalog,
        installedStepIds,
      }).issues,
    ).toContainEqual(expect.objectContaining({ kind: 'protected-prefix-edit' }));
  });

  it('runs composition on every final candidate with repository semantics', () => {
    const changedCatalog = new Map(catalog)
      .set('x', entry('x', { requires: [{ needs: 'provided-by-b', reason: 'input' }] }))
      .set('b', entry('b', { provides: ['provided-by-b'] }));
    const result = evaluateDerivedTaskType({
      baseCandidates,
      changes: [{ insertAfter: 'b', step: 'x' }],
      catalog: changedCatalog,
      installedStepIds,
    });
    expect(result.issues).toEqual([]);
    const invalid = evaluateDerivedTaskType({
      baseCandidates,
      changes: [{ insertAfter: 'a', step: 'x' }],
      catalog: changedCatalog,
      installedStepIds,
    });
    expect(
      invalid.candidates.every((c) => c.compositionIssues.some((i) => i.kind === 'unmet-need')),
    ).toBe(true);
    expect(invalid.issues.filter((i) => i.kind === 'invalid-composition')).toHaveLength(2);
    const repository = new Map(catalog).set(
      'a',
      entry('a', { requires: [{ needs: 'repository', reason: 'input' }] }),
    );
    expect(
      evaluateDerivedTaskType({
        baseCandidates,
        changes: [],
        catalog: repository,
        installedStepIds,
        requiresRepository: false,
      }).issues,
    ).toContainEqual(expect.objectContaining({ kind: 'invalid-composition' }));
  });

  it('does not mutate input lists, operations or declarations', () => {
    const before = JSON.stringify({ baseCandidates, entries });
    const changes = [{ insertAfter: 'a', step: 'x' }];
    evaluate(changes);
    expect(changes).toEqual([{ insertAfter: 'a', step: 'x' }]);
    expect(JSON.stringify({ baseCandidates, entries })).toBe(before);
  });

  it('validates prompt quotes per candidate and orphans against the candidate union', () => {
    const prompt = parsePromptSteps({
      note: {
        slug: 'note',
        title: 'Note',
        template: '{{step:b}}',
        capabilities: [],
        timeoutMs: 60_000,
        agentPool: '*',
      },
    });
    const customId = 'custom.example.note';
    const promptCatalog = new Map(catalog)
      .set('b', entry('b', { agentAuthoredOutput: true }))
      .set(customId, entry(customId));
    const result = evaluateDerivedTaskType({
      baseCandidates,
      changes: [{ insertAfter: 'b', step: customId }],
      catalog: promptCatalog,
      installedStepIds: new Set([...installedStepIds, customId]),
      promptSteps: { typeSlug: 'example', entries: prompt },
    });
    expect(Object.keys(prompt)).toEqual(['note']);
    expect(result.issues).toEqual([]);
    const bad = evaluateDerivedTaskType({
      baseCandidates,
      changes: [{ insertAfter: 'a', step: customId }],
      catalog: promptCatalog,
      installedStepIds: new Set([...installedStepIds, customId]),
      promptSteps: { typeSlug: 'example', entries: prompt },
    });
    expect(bad.issues).toContainEqual(
      expect.objectContaining({ kind: 'invalid-prompt-step', executionPath: 'quick_bugfix' }),
    );
    expect(
      evaluateDerivedTaskType({
        baseCandidates,
        changes: [],
        catalog,
        installedStepIds,
        promptSteps: { typeSlug: 'example', entries: prompt },
      }).issues,
    ).toContainEqual(
      expect.objectContaining({
        kind: 'invalid-prompt-step',
        issue: expect.objectContaining({ kind: 'prompt-step-orphan' }),
      }),
    );
  });
});

describe('ordered workflow base adapter', () => {
  const source = (type: string) =>
    type === 'workflow'
      ? [...prefix, '00b-estimate', '03-phase-0a-discovery']
      : type === 'env_replicate'
        ? ['01-declare-deps', '02-generate-dockerfile', '03-build-image', '04-verify-environment']
        : [];
  const rows = ['workflow', 'env_replicate'].flatMap((workflowType) =>
    source(workflowType).map((stepId, stepIndex) => ({ stepId, workflowType, stepIndex })),
  );

  it('expands null and every workflow path, retaining the entire environment prelude', () => {
    const candidates = workflowBaseCandidates(source);
    expect(candidates.map((c) => c.executionPath)).toEqual([null, ...EXECUTION_PATHS]);
    for (const candidate of candidates) {
      expect(candidate.stepIds.slice(0, 3)).toEqual(prefix);
      expect(candidate.stepIds.slice(3, 7)).toEqual(source('env_replicate'));
    }
  });

  it('sorts catalog metadata by stepIndex rather than ID and checks ordered parity', () => {
    const expected = workflowBaseCandidates(source);
    const actual = catalogWorkflowBaseCandidates([...rows].reverse());
    expect(baseCandidateParityIssues(expected, actual)).toEqual([]);
    const changed = actual.map((c, i) =>
      i === 0 ? { ...c, stepIds: [...c.stepIds].reverse() } : c,
    );
    expect(baseCandidateParityIssues(expected, changed)).toEqual([
      expect.objectContaining({ executionPath: null }),
    ]);
    expect(baseCandidateParityIssues(expected, actual.slice(1))).toHaveLength(1);
    expect(baseCandidateParityIssues(expected.slice(1), actual)).toHaveLength(1);
  });

  it('refuses ambiguous catalog order and duplicate IDs instead of guessing', () => {
    expect(() =>
      catalogWorkflowBaseCandidates([...rows, { ...rows[0]!, stepId: 'different' }]),
    ).toThrow();
    expect(() =>
      catalogWorkflowBaseCandidates([...rows, { ...rows[0]!, stepIndex: 999 }]),
    ).toThrow();
  });

  it('admits workflow builtins only and gives run_app its precise mode-seam reason', () => {
    expect(
      derivedBaseEligibility({
        slug: 'workflow',
        source: 'builtin',
        runListStrategy: 'workflow_paths',
      }),
    ).toEqual({ eligible: true });
    for (const source of ['admin', 'module:example']) {
      expect(
        derivedBaseEligibility({ slug: 'workflow', source, runListStrategy: 'workflow_paths' }),
      ).toMatchObject({ eligible: false, reason: 'base-not-builtin' });
    }
    expect(
      derivedBaseEligibility({
        slug: 'run_app',
        source: 'builtin',
        runListStrategy: 'run_app_modes',
      }),
    ).toMatchObject({
      eligible: false,
      reason: 'run-app-mode-selection-unavailable',
      message: expect.stringContaining('01-declare-deps'),
    });
    expect(
      derivedBaseEligibility({ slug: 'onboarding', source: 'builtin', runListStrategy: 'static' }),
    ).toMatchObject({ eligible: false, reason: 'base-not-supported' });
  });
});
