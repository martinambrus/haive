import { describe, expect, it } from 'vitest';
import { mergeSpan } from '../src/lib/merge-task-span.js';
import type { Task } from '../src/lib/api-client.js';

// mergeSpan only reads id + createdAt; a minimal object cast to Task is enough.
const task = (id: string, createdAt: string): Task => ({ id, createdAt }) as unknown as Task;

// Newest-first, one hour apart so createdAt ordering is unambiguous.
const A = task('A', '2026-07-15T10:00:00.000Z');
const B = task('B', '2026-07-15T09:00:00.000Z');
const C = task('C', '2026-07-15T08:00:00.000Z');
const D = task('D', '2026-07-15T07:00:00.000Z');
const E = task('E', '2026-07-15T06:00:00.000Z');

const ids = (rows: Task[]) => rows.map((t) => t.id);

describe('mergeSpan', () => {
  it('returns fresh when prev is null (initial load)', () => {
    expect(ids(mergeSpan(null, [A, B], 20))).toEqual(['A', 'B']);
  });

  it('drops the oldest task when it finishes under a filter (original bug)', () => {
    // Unfinished filter, 3 loaded, the OLDEST (C) finishes → server returns a
    // short page [A, B]. Before the fix C landed back in the static tail and
    // never disappeared; now the short page is treated as the complete set.
    const prev = [A, B, C];
    const fresh = [A, B]; // C excluded server-side, page not saturated
    expect(ids(mergeSpan(prev, fresh, 20))).toEqual(['A', 'B']);
  });

  it('empties the list when every loaded task finishes', () => {
    expect(mergeSpan([A, B, C], [], 20)).toEqual([]);
  });

  it('keeps the deep-scroll tail when the poll window is saturated', () => {
    // 5 loaded, poll requests only 3 (saturated) → rows D,E are beyond the
    // window and must survive so a deep scroll is not truncated.
    const prev = [A, B, C, D, E];
    const fresh = [A, B, C]; // fresh.length === requested → more rows may exist
    expect(ids(mergeSpan(prev, fresh, 3))).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('drops an in-window finish yet preserves the tail (saturated window)', () => {
    // B finishes; server refills the newest-3 window from beyond (D). B was in
    // the refreshed window → dropped; E stays as tail.
    const prev = [A, B, C, D, E];
    const fresh = [A, C, D]; // newest 3 unfinished after B left
    expect(ids(mergeSpan(prev, fresh, 3))).toEqual(['A', 'C', 'D', 'E']);
  });

  it('returns fresh wholesale when the refreshed set is not longer than prev', () => {
    // Equal-length saturated window with a mid-window swap: B out, D in.
    expect(ids(mergeSpan([A, B, C], [A, C, D], 3))).toEqual(['A', 'C', 'D']);
  });

  it('does not duplicate a boundary row shared by fresh and tail', () => {
    // C appears in both prev and fresh; id membership must keep it once.
    const prev = [A, B, C, D, E];
    const fresh = [A, B, C];
    expect(ids(mergeSpan(prev, fresh, 3))).toEqual(['A', 'B', 'C', 'D', 'E']);
  });
});
