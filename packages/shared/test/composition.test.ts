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
});
