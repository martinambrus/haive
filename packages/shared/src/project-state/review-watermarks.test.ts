import { describe, expect, it } from 'vitest';
import { emptyProjectState } from './record.js';
import { mergeProjectState } from './merge.js';
import { parseProjectState, renderProjectState } from './codec.js';
import { isConflictUnit, blocksUpgrade } from './conflicts.js';
const a = 'a'.repeat(40),
  b = 'b'.repeat(40),
  c = 'c'.repeat(40);
const record = (kbSyncedCommit?: string, planSyncedCommit?: string) => ({
  ...emptyProjectState(),
  settings: {
    'review-watermarks': Object.fromEntries(
      Object.entries({ kbSyncedCommit, planSyncedCommit }).filter(
        ([, value]) => value !== undefined,
      ),
    ),
  },
});
describe('review watermark merge', () => {
  it('keeps descendant progress independently and never unsets progress through an absent file', () => {
    const merged = mergeProjectState({
      base: record(a, a),
      local: record(b, a),
      incoming: record(a, c),
      watermarkOrder: (local, incoming) => (local === b && incoming === a ? 'local' : 'incoming'),
    });
    expect(merged.conflicts).toEqual([]);
    expect(merged.merged.settings['review-watermarks']).toEqual({
      kbSyncedCommit: b,
      planSyncedCommit: c,
    });
    const removed = mergeProjectState({
      base: record(b, c),
      local: record(b, c),
      incoming: emptyProjectState(),
    });
    expect(removed.merged.settings['review-watermarks']).toEqual({
      kbSyncedCommit: b,
      planSyncedCommit: c,
    });
  });
  it('asks for an incomparable key without blocking or reverting the independent key', () => {
    const merged = mergeProjectState({
      base: record(a, a),
      local: record(b, a),
      incoming: record(c, b),
      watermarkOrder: (local, incoming) =>
        local === a && incoming === b ? 'incoming' : 'incomparable',
    });
    expect(merged.conflicts).toEqual([
      { unit: 'settings/review-watermarks.json#kbSyncedCommit', base: a, local: b, incoming: c },
    ]);
    expect(merged.merged.settings['review-watermarks']).toEqual({
      kbSyncedCommit: b,
      planSyncedCommit: b,
    });
    expect(isConflictUnit(merged.conflicts[0]!.unit)).toBe(true);
    expect(blocksUpgrade(merged.conflicts[0]!.unit)).toBe(false);
  });
  it('uses the current codec and keeps an unknown future setting', () => {
    const state = record(a, b);
    Object.assign(state.settings, { 'future-setting': { value: 'kept' } });
    const files = renderProjectState(state);
    expect(files.has('settings/review-watermarks.json')).toBe(true);
    const parsed = parseProjectState(files);
    expect(parsed.ok && parsed.record.settings).toEqual(state.settings);
  });
});
