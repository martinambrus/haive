import { describe, expect, it } from 'vitest';
import { derivedOverlayCases } from '../../../shared/test/derived-overlay-fixtures';
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
  it.each(derivedOverlayCases)('shared contract fixture: $name', (testCase) => {
    const result = evaluateDerivedEditor({
      catalog: {
        ...fixture.catalog,
        steps: fixture.catalog.steps.filter((s) => !testCase.omitDeclarations?.includes(s.stepId)),
        registeredStepIds: fixture.catalog.registeredStepIds.filter(
          (id) => !testCase.omitInstalled?.includes(id),
        ),
      },
      baseSlug: 'workflow',
      changes: testCase.changes,
      typeSlug: 'mine',
      requiresRepository: true,
      promptSteps: {},
      loopLimits: {},
      preAnswerDefaults: {},
    });
    expect(result.candidates.map((c) => c.executionPath)).toEqual([null, 'quick_bugfix']);
    expect({
      steps: result.candidates.map((c) => c.stepIds),
      outcomes: result.candidates.map((c) => c.outcomes.map((o) => o.outcome)),
      issueKinds: [...new Set(result.issues.map((i) => i.kind))].sort(),
      warningKinds: [...new Set(result.warnings.map((w) => w.kind))].sort(),
    }).toEqual(testCase.expected);
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
