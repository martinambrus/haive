import { describe, expect, it } from 'vitest';
import type { CompositionIssue } from '@haive/shared/modularity';
import { validateComposition } from '@haive/shared/modularity';
import {
  catalogEntries,
  compositionProblems,
  describeAvailability,
  describeDefaultsIssue,
  describeIssue,
  issuesByRow,
  providersOf,
  splitServerIssues,
} from './composition-messages';
import { TEST_CATALOG } from './composition-test-catalog';

const catalog = catalogEntries(TEST_CATALOG);
const ctx = (stepIds: string[], requiresRepository = true) => ({
  stepIds,
  catalog,
  requiresRepository,
});

describe('providersOf', () => {
  it('lists the catalog steps that provide a token, in catalog order', () => {
    expect(providersOf('spec', catalog).map((s) => s.stepId)).toEqual([
      '04-phase-0b-pre-planning',
      '05-phase-0b5-spec-quality',
    ]);
  });

  it('leaves out the step asking', () => {
    expect(providersOf('spec', catalog, '05-phase-0b5-spec-quality').map((s) => s.label)).toEqual([
      'Phase 0b: Pre-planning',
    ]);
  });

  it('is empty for a token nothing provides', () => {
    expect(providersOf('repository', catalog)).toEqual([]);
  });
});

describe('describeIssue', () => {
  it('empty', () => {
    expect(describeIssue({ kind: 'empty' }, ctx([])).message).toBe('Add at least one step.');
  });

  it('unknown-step names the id', () => {
    const view = describeIssue(
      { kind: 'unknown-step', index: 0, stepId: 'zz-gone' },
      ctx(['zz-gone']),
    );
    expect(view.message).toBe('zz-gone is not in the step catalog (removed or its module is off).');
  });

  it('duplicate-step points at the first occurrence', () => {
    const ids = ['03-phase-0a-discovery', '03-phase-0a-discovery'];
    const view = describeIssue({ kind: 'duplicate-step', index: 1, stepId: ids[1]! }, ctx(ids));
    expect(view.message).toBe('Phase 0a: Knowledge discovery is already step 1.');
  });

  it('unmet-need carries the reason and who provides the token', () => {
    const view = describeIssue(
      {
        kind: 'unmet-need',
        index: 0,
        stepId: '05-phase-0b5-spec-quality',
        needs: 'spec',
        reason: 'Reviews the pre-planning spec',
      },
      ctx(['05-phase-0b5-spec-quality']),
    );
    expect(view.message).toBe('Needs spec first: Reviews the pre-planning spec.');
    expect(view.providedBy.map((s) => s.stepId)).toEqual(['04-phase-0b-pre-planning']);
  });

  it('unmet-need for the repository token names the switch', () => {
    const view = describeIssue(
      {
        kind: 'unmet-need',
        index: 0,
        stepId: '01-worktree-setup',
        needs: 'repository',
        reason: 'Cuts the worktree.',
      },
      ctx(['01-worktree-setup'], false),
    );
    expect(view.message).toBe(
      "Requires a repository: turn on 'Requires repository' or remove this step.",
    );
    expect(view.providedBy).toEqual([]);
  });

  it('too-late names the earlier step that already provides the token', () => {
    const ids = ['05-phase-0b5-spec-quality', '03-phase-0a-discovery'];
    const view = describeIssue(
      { kind: 'too-late', index: 1, stepId: ids[1]!, token: 'spec' },
      ctx(ids),
    );
    expect(view.message).toBe(
      'Must run before any step that provides spec; currently after Phase 0b.5: Spec quality review.',
    );
  });

  it('too-late without a findable earlier step still reads', () => {
    const view = describeIssue(
      { kind: 'too-late', index: 0, stepId: '03-phase-0a-discovery', token: 'spec' },
      ctx(['03-phase-0a-discovery']),
    );
    expect(view.message).toBe('Must run before any step that provides spec.');
  });

  it('unfulfilled lists the steps to add after it', () => {
    const view = describeIssue(
      { kind: 'unfulfilled', index: 0, stepId: '09-finish', token: 'finished' },
      ctx(['09-finish']),
    );
    expect(view.message).toBe(
      'Starts something that finished must finish later: add a step that provides finished after it.',
    );
    const withProvider = describeIssue(
      { kind: 'unfulfilled', index: 0, stepId: '01-worktree-setup', token: 'spec' },
      ctx(['01-worktree-setup']),
    );
    expect(withProvider.message).toBe(
      'Starts something that spec must finish later: add Phase 0b: Pre-planning or Phase 0b.5: Spec quality review after it.',
    );
    expect(withProvider.providedBy).toHaveLength(2);
  });

  it('missing-loop-target names the target by label', () => {
    const view = describeIssue(
      {
        kind: 'missing-loop-target',
        index: 0,
        stepId: '07b-phase-4-validate',
        target: '07-phase-2-implement',
      },
      ctx(['07b-phase-4-validate']),
    );
    expect(view.message).toBe('Loops back to Phase 2: Implement, which must come earlier.');
    expect(view.providedBy.map((s) => s.stepId)).toEqual(['07-phase-2-implement']);
  });

  it('loop-after-closing names the closing step', () => {
    const view = describeIssue(
      {
        kind: 'loop-after-closing',
        index: 2,
        stepId: '07b-phase-4-validate',
        closingStepId: '09-finish',
      },
      ctx([]),
    );
    expect(view.message).toBe(
      'Its fix loop would return past Finish, which closes the run; move it before that step.',
    );
  });

  it('every kind validateComposition can emit has a message that is not the raw kind', () => {
    const samples: CompositionIssue[] = [
      ...validateComposition([], catalog),
      ...validateComposition(['nope'], catalog),
      ...validateComposition(['05-phase-0b5-spec-quality', '05-phase-0b5-spec-quality'], catalog),
      ...validateComposition(['05-phase-0b5-spec-quality', '03-phase-0a-discovery'], catalog),
      ...validateComposition(['09-finish'], catalog),
      ...validateComposition(['01-worktree-setup', '07b-phase-4-validate'], catalog),
      ...validateComposition(
        ['01-worktree-setup', '07-phase-2-implement', '09-finish', '07b-phase-4-validate'],
        catalog,
      ),
    ];
    expect(new Set(samples.map((i) => i.kind))).toEqual(
      new Set([
        'empty',
        'unknown-step',
        'duplicate-step',
        'unmet-need',
        'too-late',
        'unfulfilled',
        'missing-loop-target',
        'loop-after-closing',
      ]),
    );
    for (const issue of samples) {
      const { message } = describeIssue(issue, ctx(['x']));
      expect(message.length).toBeGreaterThan(10);
      expect(message).not.toContain('undefined');
      expect(message).not.toContain(issue.kind);
    }
  });
});

describe('describeDefaultsIssue', () => {
  it('names the step', () => {
    expect(
      describeDefaultsIssue(
        { kind: 'loop-limit-not-editable', stepId: '01-worktree-setup' },
        catalog,
      ),
    ).toBe('Worktree setup has no loop limit to set.');
    expect(
      describeDefaultsIssue(
        { kind: 'default-key-not-in-steps', field: 'stepLoopLimitDefaults', stepId: 'gone' },
        catalog,
      ),
    ).toBe('A loop limit is set for gone, which is not in the list.');
  });
});

describe('issuesByRow', () => {
  it('groups by index and leaves the row-less issue out', () => {
    const rows = issuesByRow([
      { kind: 'empty' },
      { kind: 'unknown-step', index: 2, stepId: 'a' },
      { kind: 'duplicate-step', index: 2, stepId: 'a' },
    ]);
    expect([...rows.keys()]).toEqual([2]);
    expect(rows.get(2)).toHaveLength(2);
  });
});

describe('compositionProblems', () => {
  it('agrees with validateComposition and flags a loop limit on a step that has none', () => {
    const stepIds = ['05-phase-0b5-spec-quality', '04-phase-0b-pre-planning'];
    const out = compositionProblems({
      stepIds,
      loopLimits: { '04-phase-0b-pre-planning': 3 },
      catalog,
      requiresRepository: false,
    });
    expect(out.composition).toEqual(
      validateComposition(stepIds, catalog, { requiresRepository: false }),
    );
    expect(out.defaults).toEqual([
      { kind: 'loop-limit-not-editable', stepId: '04-phase-0b-pre-planning' },
    ]);
  });
});

describe('splitServerIssues', () => {
  it('separates composition, defaults and validation issues by shape', () => {
    const out = splitServerIssues([
      { kind: 'unknown-step', index: 0, stepId: 'a' },
      { kind: 'loop-limit-not-editable', stepId: 'b' },
      { path: 'slug', message: 'Invalid' },
      { nonsense: true },
    ]);
    expect(out.composition).toEqual([{ kind: 'unknown-step', index: 0, stepId: 'a' }]);
    expect(out.defaults).toEqual([{ kind: 'loop-limit-not-editable', stepId: 'b' }]);
    expect(out.fields).toEqual([{ path: 'slug', message: 'Invalid' }]);
  });

  it('tolerates a body with no issues', () => {
    expect(splitServerIssues(undefined)).toEqual({ composition: [], defaults: [], fields: [] });
  });
});

describe('describeAvailability', () => {
  it('says why a type cannot be used, in words', () => {
    expect(describeAvailability({ available: true })).toBe('Available');
    expect(describeAvailability({ available: false, reason: 'custom-types-off' })).toBe(
      'Unavailable: custom task types are switched off',
    );
    expect(
      describeAvailability({ available: false, reason: 'missing-step', stepIds: ['a', 'b'] }),
    ).toBe('Unavailable: missing steps a, b');
    expect(
      describeAvailability({
        available: false,
        reason: 'invalid-composition',
        issues: [{ kind: 'empty' }],
      }),
    ).toBe('Unavailable: the step list has 1 problem');
    expect(describeAvailability({ available: false, reason: 'disabled' })).toBe(
      'Unavailable: disabled',
    );
  });
});
