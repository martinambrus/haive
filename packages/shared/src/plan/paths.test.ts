import { describe, it, expect } from 'vitest';
import {
  descendantPathSqlOffset,
  descendantsLikePattern,
  planNodeDepth,
  planNodePath,
  rewriteDescendantPath,
  subtreeLikePattern,
  wouldDetachSubtree,
} from './paths.js';

const ROOT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LEAF = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const rootPath = planNodePath(null, ROOT);
const midPath = planNodePath(rootPath, MID);
const leafPath = planNodePath(midPath, LEAF);

describe('planNodePath', () => {
  it('is self-inclusive and slash-terminated at every level', () => {
    expect(rootPath).toBe(`/${ROOT}/`);
    expect(midPath).toBe(`/${ROOT}/${MID}/`);
    expect(leafPath).toBe(`/${ROOT}/${MID}/${LEAF}/`);
  });
});

describe('subtree patterns', () => {
  it('subtree pattern matches the node itself and its descendants', () => {
    const pattern = subtreeLikePattern(midPath);
    expect(midPath.startsWith(pattern.slice(0, -1))).toBe(true);
    expect(leafPath.startsWith(pattern.slice(0, -1))).toBe(true);
  });

  it('descendant pattern excludes the node itself', () => {
    // The trailing `_` demands one more character than the node's own path has.
    expect(descendantsLikePattern(midPath)).toBe(`${midPath}_%`);
    expect(midPath.length).toBeLessThan(leafPath.length);
  });

  it('the trailing slash is what stops a sibling-prefix false positive', () => {
    // Without slash termination '/a/b' would prefix-match '/a/bc'. Constructed
    // with plain ids to make the failure mode visible rather than uuid-shaped.
    const b = planNodePath(null, 'b');
    const bc = planNodePath(null, 'bc');
    expect(bc.startsWith(b)).toBe(false);
    expect('/bc/'.startsWith('/b')).toBe(true); // the un-terminated version DOES collide
  });
});

describe('rewriteDescendantPath', () => {
  it('re-roots a descendant onto the new prefix', () => {
    const newMidPath = planNodePath(planNodePath(null, ROOT), MID); // unchanged parent
    expect(rewriteDescendantPath(midPath, newMidPath, leafPath)).toBe(leafPath);
  });

  it('moves a whole subtree when the node changes parent', () => {
    const otherPath = planNodePath(rootPath, OTHER);
    const movedMid = planNodePath(otherPath, MID);
    expect(rewriteDescendantPath(midPath, movedMid, leafPath)).toBe(
      `/${ROOT}/${OTHER}/${MID}/${LEAF}/`,
    );
  });

  it('leaves a non-descendant untouched', () => {
    const otherPath = planNodePath(rootPath, OTHER);
    expect(rewriteDescendantPath(midPath, 'whatever', otherPath)).toBe(otherPath);
  });

  it('agrees with the SQL offset it is paired with', () => {
    // SQL substring(from N) is 1-indexed, JS slice(n) is 0-indexed. A mismatch here
    // corrupts every descendant of every moved node while leaving the moved node
    // itself correct, so the two are asserted equal rather than assumed.
    const offset = descendantPathSqlOffset(midPath);
    const sqlEquivalent = leafPath.slice(offset - 1);
    expect(sqlEquivalent).toBe(leafPath.slice(midPath.length));
  });
});

describe('wouldDetachSubtree', () => {
  it('rejects moving a node under itself', () => {
    expect(wouldDetachSubtree(midPath, midPath)).toBe(true);
  });

  it('rejects moving a node under its own descendant', () => {
    expect(wouldDetachSubtree(midPath, leafPath)).toBe(true);
  });

  it('allows moving a node under an unrelated node', () => {
    expect(wouldDetachSubtree(midPath, planNodePath(rootPath, OTHER))).toBe(false);
  });

  it('allows moving a node under its own ancestor', () => {
    expect(wouldDetachSubtree(leafPath, rootPath)).toBe(false);
  });
});

describe('planNodeDepth', () => {
  it('counts the root as depth zero', () => {
    expect(planNodeDepth(rootPath)).toBe(0);
    expect(planNodeDepth(midPath)).toBe(1);
    expect(planNodeDepth(leafPath)).toBe(2);
  });
});
