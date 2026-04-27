import { describe, expect, it } from 'vitest';
import { computeLineDelta } from '../src/step-engine/steps/onboarding-upgrade/_diff.js';

describe('computeLineDelta', () => {
  it('empty strings report zero delta', () => {
    expect(computeLineDelta('', '')).toEqual({ added: 0, removed: 0 });
  });

  it('pure addition reports only added', () => {
    expect(computeLineDelta('a\nb', 'a\nb\nc')).toEqual({ added: 1, removed: 0 });
  });

  it('pure removal reports only removed', () => {
    expect(computeLineDelta('a\nb\nc', 'a\nb')).toEqual({ added: 0, removed: 1 });
  });

  it('reorder alone is not a change', () => {
    expect(computeLineDelta('a\nb\nc', 'c\nb\na')).toEqual({ added: 0, removed: 0 });
  });

  it('substitution is one add + one remove', () => {
    expect(computeLineDelta('a\nb\nc', 'a\nX\nc')).toEqual({ added: 1, removed: 1 });
  });

  it('CRLF normalization: same content different line endings is zero delta', () => {
    expect(computeLineDelta('a\r\nb\r\nc', 'a\nb\nc')).toEqual({ added: 0, removed: 0 });
  });

  it('duplicated lines are counted via multiset', () => {
    expect(computeLineDelta('a\na\nb', 'a\nb\nb')).toEqual({ added: 1, removed: 1 });
  });
});
