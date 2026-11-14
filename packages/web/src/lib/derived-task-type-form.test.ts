import { describe, expect, it } from 'vitest';
import { evaluateDerivedTaskType, type DerivedChange } from '@haive/shared/modularity';
import {
  evaluateDerivedEditor,
  buildDerivedCreateBody,
  buildDerivedUpdateBody,
} from './derived-task-type-form';
import { derivedFixture } from './derived-test-fixture';
import { readPromptSteps } from './prompt-step-editing';

const fixture = derivedFixture();
const values = {
  slug: 'mine',
  displayName: 'Mine',
  requiresRepository: true,
  enabled: true,
  selectable: true,
};

describe('derived editor contract', () => {
  it('omits unchanged null descriptions and legacy prompt defaults from PATCH', () => {
    const stored = {
      check: {
        slug: 'check',
        title: 'Check',
        template: 'Review',
        timeoutMs: 60_000,
        capabilities: [],
      },
    };
    expect(
      buildDerivedUpdateBody(
        { ...values, description: '' },
        ['description', 'promptSteps'],
        { changes: [], loopLimits: {}, promptSteps: readPromptSteps(stored) },
        {
          ...values,
          description: null,
          changes: [],
          stepLoopLimitDefaults: {},
          promptSteps: stored,
        },
      ),
    ).toEqual({});
  });
  it.each<{ changes: DerivedChange[] }>([
    { changes: [] },
    {
      changes: [{ insertAfter: 'a', step: 'x' }, { insertAfter: 'x', step: 'y' }, { remove: 'b' }],
    },
    {
      changes: [
        { insertAfter: 'a', step: 'x' },
        { insertAfter: 'a', step: 'y' },
      ],
    },
    { changes: [{ remove: 'b' }, { insertAfter: 'b', step: 'x' }, { remove: 'old-name' }] },
    {
      changes: [
        { insertAfter: 'old-name', step: 'x' },
        { insertAfter: 'x', step: 'y' },
      ],
    },
    { changes: [{ replace: 'a', with: 'x' }] },
    { changes: [{ remove: '00-triage' }] },
    { changes: [{ insertAfter: 'a', step: 'missing' }] },
    { changes: [{ insertAfter: 'a', step: 'b' }] },
  ])('uses the PR1 evaluator fixtures %#', ({ changes }) => {
    const actual = evaluateDerivedEditor({
      catalog: fixture.catalog,
      baseSlug: 'workflow',
      changes,
      typeSlug: 'mine',
      requiresRepository: true,
      promptSteps: {},
      loopLimits: {},
      preAnswerDefaults: {},
    });
    const expected = evaluateDerivedTaskType({
      baseCandidates: fixture.candidates,
      changes,
      catalog: new Map(fixture.catalog.steps.map((s) => [s.stepId, s.entry])),
      installedStepIds: new Set(fixture.catalog.registeredStepIds),
      requiresRepository: true,
    });
    expect(actual.candidates).toEqual(expected.candidates);
    expect(actual.issues).toEqual(expected.issues);
  });

  it('keeps incomplete operations invalid rather than dropping rows', () => {
    const result = evaluateDerivedEditor({
      catalog: fixture.catalog,
      baseSlug: 'workflow',
      changes: [{ remove: '' }],
      typeSlug: 'mine',
      requiresRepository: true,
      promptSteps: {},
      loopLimits: {},
      preAnswerDefaults: {},
    });
    expect(result.issues).toContainEqual(
      expect.objectContaining({ kind: 'invalid-derived-changes' }),
    );
  });

  it('serializes only overlay and own defaults, never preview arrays', () => {
    const changes = [{ remove: 'b' }];
    const body = buildDerivedCreateBody(values, {
      baseSlug: 'workflow',
      changes,
      loopLimits: { a: 3 },
      promptSteps: {},
      preAnswerDefaults: { a: { depth: 2 } },
    });
    expect(body).toMatchObject({
      slug: 'mine',
      runListStrategy: 'derived',
      baseSlug: 'workflow',
      changes,
      stepLoopLimitDefaults: { a: 3 },
      preAnswerDefaults: { a: { depth: 2 } },
    });
    expect(body).not.toHaveProperty('stepIds');
    expect(body).not.toHaveProperty('candidates');
    const patch = buildDerivedUpdateBody(
      values,
      ['displayName', 'changes', 'stepLoopLimitDefaults', 'promptSteps'],
      { changes, loopLimits: {}, promptSteps: {} },
      { ...values, changes: [], stepLoopLimitDefaults: {}, promptSteps: {} },
    );
    expect(patch).toEqual({ changes });
  });

  it('checks defaults against the candidate union and honors editableFields', () => {
    const result = evaluateDerivedEditor({
      catalog: fixture.catalog,
      baseSlug: 'workflow',
      changes: [],
      typeSlug: 'mine',
      requiresRepository: true,
      promptSteps: {},
      loopLimits: { b: 3, a: 51 },
      preAnswerDefaults: { gone: {} },
    });
    expect(result.defaultIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stepId: 'gone' }),
        expect.objectContaining({ stepId: 'b' }),
        expect.objectContaining({ stepId: 'a' }),
      ]),
    );
    expect(
      buildDerivedUpdateBody(
        values,
        ['displayName'],
        { changes: [{ remove: 'a' }], loopLimits: { a: 2 }, promptSteps: {} },
        { ...values, changes: [], stepLoopLimitDefaults: {}, promptSteps: {} },
      ),
    ).toEqual({});
  });
});
