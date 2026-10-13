import { describe, expect, it } from 'vitest';
import { dropMove, insertStep, moveStep, pruneLoopLimits, removeStep } from './composition-order';

const ids = ['a', 'b', 'c'];

describe('moveStep', () => {
  it('moves a step up and down', () => {
    expect(moveStep(ids, 1, 0)).toEqual(['b', 'a', 'c']);
    expect(moveStep(ids, 1, 2)).toEqual(['a', 'c', 'b']);
  });

  it('leaves the list alone at the ends', () => {
    expect(moveStep(ids, 0, -1)).toBe(ids);
    expect(moveStep(ids, 2, 3)).toBe(ids);
    expect(moveStep(ids, 1, 1)).toBe(ids);
  });

  it('never mutates its input', () => {
    moveStep(ids, 0, 2);
    expect(ids).toEqual(['a', 'b', 'c']);
  });
});

describe('removeStep', () => {
  it('removes by index', () => {
    expect(removeStep(ids, 1)).toEqual(['a', 'c']);
    expect(removeStep(ids, 0)).toEqual(['b', 'c']);
    expect(removeStep(ids, 2)).toEqual(['a', 'b']);
  });

  it('ignores an index outside the list', () => {
    expect(removeStep(ids, 3)).toBe(ids);
    expect(removeStep(ids, -1)).toBe(ids);
  });
});

describe('insertStep', () => {
  it('inserts before the given index', () => {
    expect(insertStep(ids, 1, 'x')).toEqual(['a', 'x', 'b', 'c']);
    expect(insertStep(ids, 0, 'x')).toEqual(['x', 'a', 'b', 'c']);
  });

  it('appends at or past the end', () => {
    expect(insertStep(ids, 3, 'x')).toEqual(['a', 'b', 'c', 'x']);
    expect(insertStep(ids, 99, 'x')).toEqual(['a', 'b', 'c', 'x']);
  });
});

describe('dropMove', () => {
  it('drops a row before or after another', () => {
    expect(dropMove(ids, 0, 2, 'before')).toEqual(['b', 'a', 'c']);
    expect(dropMove(ids, 0, 2, 'after')).toEqual(['b', 'c', 'a']);
    expect(dropMove(ids, 2, 0, 'before')).toEqual(['c', 'a', 'b']);
    expect(dropMove(ids, 2, 0, 'after')).toEqual(['a', 'c', 'b']);
  });

  it('is a no-op when dropped on itself or onto its own neighbour slot', () => {
    expect(dropMove(ids, 1, 1, 'before')).toBe(ids);
    expect(dropMove(ids, 1, 0, 'after')).toBe(ids);
    expect(dropMove(ids, 1, 2, 'before')).toBe(ids);
  });

  it('moves the right row when ids repeat', () => {
    expect(dropMove(['a', 'b', 'a'], 2, 0, 'before')).toEqual(['a', 'a', 'b']);
  });
});

describe('pruneLoopLimits', () => {
  it('drops limits for steps no longer listed and keeps the object when nothing goes', () => {
    const limits = { a: 3, z: 4 };
    expect(pruneLoopLimits(limits, ids)).toEqual({ a: 3 });
    const same = { a: 3 };
    expect(pruneLoopLimits(same, ids)).toBe(same);
  });
});
