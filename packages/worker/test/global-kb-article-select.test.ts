import { describe, expect, it } from 'vitest';
import { mergeRankedWithRecency } from '../src/step-engine/steps/_global-kb-promote.js';

/** Which existing global articles step 11 shows the agent, once relevance
 *  ranking sits in front of the recency order it replaced. */
describe('mergeRankedWithRecency', () => {
  it('leads with the ranked ids and fills the rest from recency', () => {
    const out = mergeRankedWithRecency(['rel-1', 'rel-2'], ['new-1', 'new-2', 'new-3'], 4);

    expect(out).toEqual(['rel-1', 'rel-2', 'new-1', 'new-2']);
  });

  it('does not repeat an id that is both ranked and recent', () => {
    const out = mergeRankedWithRecency(['both'], ['new-1', 'both', 'new-2'], 3);

    expect(out).toEqual(['both', 'new-1', 'new-2']);
  });

  it('caps at the limit', () => {
    const out = mergeRankedWithRecency(['a', 'b', 'c'], ['d', 'e'], 2);

    expect(out).toEqual(['a', 'b']);
  });

  it('is exactly the recency order when nothing ranked — the fallback path', () => {
    // No relevance query, no embedder, or a search that threw. The block must
    // degrade to what it did before ranking existed, never to a shorter list.
    const recency = ['new-1', 'new-2', 'new-3'];

    expect(mergeRankedWithRecency([], recency, 15)).toEqual(recency);
  });

  it('returns an empty list only when there is nothing compatible to show', () => {
    expect(mergeRankedWithRecency([], [], 15)).toEqual([]);
  });
});
