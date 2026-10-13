import { describe, expect, it } from 'vitest';
import { validateComposition, type ComposableStepEntry } from '../src/modularity/index.js';

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
