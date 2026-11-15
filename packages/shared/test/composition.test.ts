import { describe, expect, it } from 'vitest';
import {
  composableStepEntrySchema,
  moduleManifestSchema,
  validateComposition,
  type ComposableStepEntry,
} from '../src/modularity/index.js';

function entry(
  stepId: string,
  opts: { needs?: string[]; provides?: string[]; loop?: string; closes?: boolean } = {},
): ComposableStepEntry {
  return {
    stepId,
    label: stepId,
    group: 'test',
    dispatchesCli: false,
    requires: (opts.needs ?? []).map((needs) => ({ needs, reason: `${stepId} needs ${needs}` })),
    provides: opts.provides ?? [],
    ...(opts.loop ? { loopTargetStepId: opts.loop } : {}),
    ...(opts.closes ? { closes: true } : {}),
  };
}

function catalogOf(...entries: ComposableStepEntry[]): ReadonlyMap<string, ComposableStepEntry> {
  return new Map(entries.map((e) => [e.stepId, e]));
}

const catalog = catalogOf(
  entry('make-worktree', { provides: ['worktree'] }),
  entry('alt-worktree', { provides: ['worktree'] }),
  entry('use-worktree', { needs: ['worktree'] }),
  entry('self-needy', { needs: ['spec'], provides: ['spec'] }),
  entry('self-loop', { loop: 'self-loop' }),
  entry('loop-back', { loop: 'make-worktree' }),
  entry('loop-ahead', { loop: 'use-worktree' }),
);

describe('validateComposition', () => {
  it('accepts a provider followed by the step needing it', () => {
    expect(validateComposition(['make-worktree', 'use-worktree'], catalog)).toEqual([]);
  });

  it('reports a need that only a later step provides', () => {
    expect(validateComposition(['use-worktree', 'make-worktree'], catalog)).toEqual([
      {
        kind: 'unmet-need',
        index: 0,
        stepId: 'use-worktree',
        needs: 'worktree',
        reason: 'use-worktree needs worktree',
      },
    ]);
  });

  it('accepts either of two alternative providers', () => {
    expect(validateComposition(['alt-worktree', 'use-worktree'], catalog)).toEqual([]);
    expect(validateComposition(['make-worktree', 'use-worktree'], catalog)).toEqual([]);
  });

  it('does not let a step satisfy its own need', () => {
    expect(validateComposition(['self-needy'], catalog)).toEqual([
      {
        kind: 'unmet-need',
        index: 0,
        stepId: 'self-needy',
        needs: 'spec',
        reason: 'self-needy needs spec',
      },
    ]);
  });

  it('lets a step target itself as its loop target', () => {
    expect(validateComposition(['self-loop'], catalog)).toEqual([]);
  });

  it('accepts a loop target earlier in the list', () => {
    expect(validateComposition(['make-worktree', 'loop-back'], catalog)).toEqual([]);
  });

  it('reports a loop target that is absent or comes later', () => {
    expect(validateComposition(['loop-back'], catalog)).toEqual([
      { kind: 'missing-loop-target', index: 0, stepId: 'loop-back', target: 'make-worktree' },
    ]);
    expect(validateComposition(['loop-ahead', 'make-worktree', 'use-worktree'], catalog)).toEqual([
      { kind: 'missing-loop-target', index: 0, stepId: 'loop-ahead', target: 'use-worktree' },
    ]);
  });

  it('reports an id missing from the catalog and gives it no provides', () => {
    expect(validateComposition(['ghost', 'use-worktree'], catalog)).toEqual([
      { kind: 'unknown-step', index: 0, stepId: 'ghost' },
      {
        kind: 'unmet-need',
        index: 1,
        stepId: 'use-worktree',
        needs: 'worktree',
        reason: 'use-worktree needs worktree',
      },
    ]);
  });

  it('reports a repeated id', () => {
    expect(validateComposition(['make-worktree', 'make-worktree'], catalog)).toEqual([
      { kind: 'duplicate-step', index: 1, stepId: 'make-worktree' },
    ]);
  });

  it('reports an empty list', () => {
    expect(validateComposition([], catalog)).toEqual([{ kind: 'empty' }]);
  });

  it('reports every issue in list order', () => {
    expect(
      validateComposition(['use-worktree', 'ghost', 'loop-back', 'use-worktree'], catalog),
    ).toEqual([
      {
        kind: 'unmet-need',
        index: 0,
        stepId: 'use-worktree',
        needs: 'worktree',
        reason: 'use-worktree needs worktree',
      },
      { kind: 'unknown-step', index: 1, stepId: 'ghost' },
      { kind: 'missing-loop-target', index: 2, stepId: 'loop-back', target: 'make-worktree' },
      { kind: 'duplicate-step', index: 3, stepId: 'use-worktree' },
      {
        kind: 'unmet-need',
        index: 3,
        stepId: 'use-worktree',
        needs: 'worktree',
        reason: 'use-worktree needs worktree',
      },
    ]);
  });

  it('refuses a looping step after a closing step', () => {
    const catalog = catalogOf(
      entry('impl', { provides: ['implementation'] }),
      entry('commit', { closes: true }),
      entry('verify', { loop: 'impl' }),
    );
    expect(validateComposition(['impl', 'commit', 'verify'], catalog)).toEqual([
      { kind: 'loop-after-closing', index: 2, stepId: 'verify', closingStepId: 'commit' },
    ]);
    expect(validateComposition(['impl', 'verify', 'commit'], catalog)).toEqual([]);
  });

  it('accepts a loop after a closing step whose target also follows it', () => {
    const catalog = catalogOf(
      entry('commit', { closes: true }),
      entry('learn', { loop: 'learn' }),
      entry('review-learnings', { loop: 'learn' }),
    );
    expect(validateComposition(['commit', 'learn', 'review-learnings'], catalog)).toEqual([]);
  });

  it('reports a step placed after a provider of a token it must precede', () => {
    const catalog = catalogOf(entry('cut', { provides: ['worktree'] }), {
      ...entry('sync'),
      precedes: ['worktree'],
    });
    expect(validateComposition(['sync', 'cut'], catalog)).toEqual([]);
    expect(validateComposition(['sync'], catalog)).toEqual([]);
    expect(validateComposition(['cut', 'sync'], catalog)).toEqual([
      { kind: 'too-late', index: 1, stepId: 'sync', token: 'worktree' },
    ]);
  });

  it('reports a step whose entailed token no later step provides', () => {
    const catalog = catalogOf(
      { ...entry('declare'), entails: ['image'] },
      entry('build', { provides: ['image'] }),
    );
    expect(validateComposition(['declare'], catalog)).toEqual([
      { kind: 'unfulfilled', index: 0, stepId: 'declare', token: 'image' },
    ]);
    expect(validateComposition(['build', 'declare'], catalog)).toEqual([
      { kind: 'unfulfilled', index: 1, stepId: 'declare', token: 'image' },
    ]);
    expect(validateComposition(['declare', 'build'], catalog)).toEqual([]);
  });

  it('entails a token only when its condition token was provided earlier', () => {
    const catalog = catalogOf(
      entry('runtime', { provides: ['ddev'] }),
      { ...entry('implement'), entailsWhen: [{ provided: 'ddev', entails: ['reconciled'] }] },
      entry('reconcile', { provides: ['reconciled'] }),
    );
    expect(validateComposition(['implement'], catalog)).toEqual([]);
    expect(validateComposition(['runtime', 'implement'], catalog)).toEqual([
      { kind: 'unfulfilled', index: 1, stepId: 'implement', token: 'reconciled' },
    ]);
    expect(validateComposition(['runtime', 'implement', 'reconcile'], catalog)).toEqual([]);
  });

  it('never lets a step provide the implicit repository token', () => {
    const catalog = catalogOf(
      entry('fake', { provides: ['repository'] }),
      entry('needs-repo', { needs: ['repository'] }),
    );
    expect(
      validateComposition(['fake', 'needs-repo'], catalog, { requiresRepository: false }),
    ).toContainEqual(
      expect.objectContaining({ kind: 'unmet-need', stepId: 'needs-repo', needs: 'repository' }),
    );
  });

  it('refuses an entry that declares an implicit token', () => {
    const base = entry('x');
    expect(composableStepEntrySchema.safeParse({ ...base, provides: ['repository'] }).success).toBe(
      false,
    );
    expect(composableStepEntrySchema.safeParse({ ...base, removes: ['repository'] }).success).toBe(
      false,
    );
    expect(composableStepEntrySchema.safeParse(base).success).toBe(true);
  });

  it('withdraws a token a step removes', () => {
    const catalog = catalogOf(
      entry('cut', { provides: ['worktree'] }),
      { ...entry('clean'), removes: ['worktree'] },
      entry('use', { needs: ['worktree'] }),
    );
    expect(validateComposition(['cut', 'use', 'clean'], catalog)).toEqual([]);
    expect(validateComposition(['cut', 'clean', 'use'], catalog)).toEqual([
      {
        kind: 'unmet-need',
        index: 2,
        stepId: 'use',
        needs: 'worktree',
        reason: 'use needs worktree',
      },
    ]);
  });

  it('checks a loop against the latest closing step, not only the first', () => {
    const catalog = catalogOf(
      entry('close-a', { closes: true }),
      entry('target'),
      entry('close-b', { closes: true }),
      entry('emitter', { loop: 'target' }),
    );
    expect(validateComposition(['close-a', 'target', 'close-b', 'emitter'], catalog)).toEqual([
      { kind: 'loop-after-closing', index: 3, stepId: 'emitter', closingStepId: 'close-b' },
    ]);
    expect(validateComposition(['close-a', 'target', 'emitter', 'close-b'], catalog)).toEqual([]);
  });

  it('treats a step that both closes and loops as its own barrier', () => {
    const catalog = catalogOf(
      entry('impl', { provides: ['implementation'] }),
      entry('push-and-check', { closes: true, loop: 'impl' }),
    );
    expect(validateComposition(['impl', 'push-and-check'], catalog)).toEqual([
      {
        kind: 'loop-after-closing',
        index: 1,
        stepId: 'push-and-check',
        closingStepId: 'push-and-check',
      },
    ]);
  });
});

describe('validateComposition repository token', () => {
  const repoCatalog = catalogOf(
    entry('make-worktree', { needs: ['repository'], provides: ['worktree'] }),
    entry('use-worktree', { needs: ['worktree'] }),
    entry('spec-a'),
    entry('spec-b'),
  );
  const unmet = (index: number, stepId: string, needs: string) => ({
    kind: 'unmet-need',
    index,
    stepId,
    needs,
    reason: `${stepId} needs ${needs}`,
  });

  it('accepts steps that need no repository for a repo-less type', () => {
    expect(
      validateComposition(['spec-a', 'spec-b'], repoCatalog, { requiresRepository: false }),
    ).toEqual([]);
  });

  it('refuses a repository-needing step for a repo-less type', () => {
    expect(
      validateComposition(['make-worktree'], repoCatalog, { requiresRepository: false }),
    ).toEqual([unmet(0, 'make-worktree', 'repository')]);
  });

  it('refuses a worktree consumer for a repo-less type', () => {
    expect(
      validateComposition(['use-worktree'], repoCatalog, { requiresRepository: false }),
    ).toEqual([unmet(0, 'use-worktree', 'worktree')]);
  });

  it('treats an omitted option as requiring a repository', () => {
    expect(validateComposition(['make-worktree', 'use-worktree'], repoCatalog)).toEqual([]);
    expect(
      validateComposition(['make-worktree', 'use-worktree'], repoCatalog, {
        requiresRepository: true,
      }),
    ).toEqual([]);
  });

  it('keeps the repository for the whole composition', () => {
    const c = catalogOf(
      entry('make-worktree', { needs: ['repository'], provides: ['worktree'] }),
      entry('again', { needs: ['repository'] }),
    );
    expect(validateComposition(['make-worktree', 'again'], c)).toEqual([]);
  });
});

describe('ordered token requirements', () => {
  const orderedCatalog = catalogOf(
    entry('verify', { provides: ['verification'] }),
    entry('review', { provides: ['review'] }),
    composableStepEntrySchema.parse({
      ...entry('checkpoint'),
      requires: [
        { needs: 'review', after: 'verification', reason: 'Review must check the verified work.' },
      ],
    }),
  );

  it('refuses a needed provider before the prerequisite provider', () => {
    expect(validateComposition(['review', 'verify', 'checkpoint'], orderedCatalog)).toEqual([
      {
        kind: 'need-out-of-order',
        index: 2,
        stepId: 'checkpoint',
        needs: 'review',
        after: 'verification',
        reason: 'Review must check the verified work.',
      },
    ]);
  });
  it('accepts the ordered providers and leaves lists without the consumer unrestricted', () => {
    expect(validateComposition(['verify', 'review', 'checkpoint'], orderedCatalog)).toEqual([]);
    expect(validateComposition(['review', 'verify'], orderedCatalog)).toEqual([]);
  });
  it('requires the ordering prerequisite to be present', () => {
    expect(validateComposition(['review', 'checkpoint'], orderedCatalog)).toContainEqual(
      expect.objectContaining({ kind: 'unmet-need', stepId: 'checkpoint', needs: 'verification' }),
    );
  });
  it('does not accept two tokens produced by the same step as strictly ordered', () => {
    const both = entry('both', { provides: ['verification', 'review'] });
    expect(
      validateComposition(
        ['both', 'checkpoint'],
        catalogOf(both, orderedCatalog.get('checkpoint')!),
      ),
    ).toContainEqual(expect.objectContaining({ kind: 'need-out-of-order' }));
  });
});

it('preserves ordered needs on module manifests without granting another replacement role', () => {
  const requirement = { needs: 'review', after: 'verification', reason: 'Check in order.' };
  const value = {
    id: 'example',
    name: 'Example',
    version: '1',
    schemaVersion: 1,
    composableSteps: [{ ...entry('check'), requires: [requirement] }],
  };
  expect(moduleManifestSchema.parse(value).composableSteps![0]!.requires).toEqual([requirement]);
  expect(
    moduleManifestSchema.safeParse({
      ...value,
      composableSteps: [{ ...value.composableSteps[0], replaces: ['08e-insights-triage'] }],
    }).success,
  ).toBe(false);
});

it('explicit precommit branching may revise before the gate closes, while later loops remain fenced', () => {
  const catalog = new Map([
    [
      'impl',
      {
        stepId: 'impl',
        label: 'Implementation',
        group: 'build',
        requires: [],
        provides: [],
        dispatchesCli: false,
      },
    ],
    [
      'gate',
      {
        stepId: 'gate',
        label: 'Gate',
        group: 'finish',
        requires: [],
        provides: [],
        dispatchesCli: false,
        closes: true,
        loopBeforeClose: true,
        loopTargetStepId: 'impl',
      },
    ],
    [
      'later',
      {
        stepId: 'later',
        label: 'Later',
        group: 'finish',
        requires: [],
        provides: [],
        dispatchesCli: false,
        loopTargetStepId: 'impl',
      },
    ],
  ]);
  expect(validateComposition(['impl', 'gate'], catalog)).toEqual([]);
  expect(validateComposition(['impl', 'gate', 'later'], catalog)).toEqual([
    { kind: 'loop-after-closing', index: 2, stepId: 'later', closingStepId: 'gate' },
  ]);
});

it('conditional loop destinations preserve absent-target compositions and enforce present-target order and barriers', () => {
  const gate = {
    ...entry('gate', { loop: 'triage', closes: true }),
    loopBeforeClose: true,
    loopTargetWhenPresent: true,
  };
  const catalog = catalogOf(entry('triage'), gate, entry('later', { loop: 'triage' }));
  expect(composableStepEntrySchema.safeParse(gate).success).toBe(true);
  expect(
    composableStepEntrySchema.safeParse({ ...entry('gate'), loopTargetWhenPresent: true }).success,
  ).toBe(false);
  expect(validateComposition(['gate'], catalog)).toEqual([]);
  expect(validateComposition(['triage', 'gate'], catalog)).toEqual([]);
  expect(validateComposition(['gate', 'triage'], catalog)).toContainEqual(
    expect.objectContaining({ kind: 'missing-loop-target', stepId: 'gate' }),
  );
  expect(validateComposition(['triage', 'gate', 'later'], catalog)).toEqual([
    { kind: 'loop-after-closing', index: 2, stepId: 'later', closingStepId: 'gate' },
  ]);
});
