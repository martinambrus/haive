import { describe, expect, it } from 'vitest';
import {
  MERGE_LEFT_OPEN_EVENT,
  MERGE_LEFT_OPEN_SETTLED_EVENT,
  leftOpenMerges,
} from '../src/merge-left-open.js';

const open = (over: Record<string, unknown> = {}) => ({
  eventType: MERGE_LEFT_OPEN_EVENT,
  payload: { dir: '/repo', ref: 'feat/a', head: 'h1', mergeHead: 'm1', ...over },
});
const settled = (over: Record<string, unknown> = {}) => ({
  eventType: MERGE_LEFT_OPEN_SETTLED_EVENT,
  payload: { dir: '/repo', mergeHead: 'm1', outcome: 'aborted', reason: 'done', ...over },
});

describe('leftOpenMerges', () => {
  it('lists an event with no settled one as unsettled', () => {
    expect(leftOpenMerges([open()])).toEqual([
      { dir: '/repo', ref: 'feat/a', head: 'h1', mergeHead: 'm1', settled: null },
    ]);
  });

  it('carries the settled outcome of the same dir and merge head', () => {
    const [m] = leftOpenMerges([open(), settled({ outcome: 'moved', reason: 'it changed' })]);
    expect(m?.settled).toEqual({ outcome: 'moved', reason: 'it changed' });
  });

  it('does not let a settled event for another dir or merge head close it', () => {
    const [a] = leftOpenMerges([open(), settled({ dir: '/other' })]);
    const [b] = leftOpenMerges([open(), settled({ mergeHead: 'm2' })]);
    expect(a?.settled).toBeNull();
    expect(b?.settled).toBeNull();
  });

  it('keeps the first outcome when a merge is settled twice', () => {
    const [m] = leftOpenMerges([open(), settled(), settled({ outcome: 'moved', reason: 'late' })]);
    expect(m?.settled?.outcome).toBe('aborted');
  });

  it('keeps one entry per dir and merge head, however often the event repeats', () => {
    expect(leftOpenMerges([open(), open(), open({ dir: '/b' })])).toHaveLength(2);
  });

  it('skips events whose payload is not shaped as written', () => {
    expect(
      leftOpenMerges([{ eventType: MERGE_LEFT_OPEN_EVENT, payload: null }, open({ dir: 3 })]),
    ).toEqual([]);
  });
});
