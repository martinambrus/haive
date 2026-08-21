import { describe, expect, it } from 'vitest';
import { stripManagedKnowledgeGlobs, trimGlobSlashes } from '../src/knowledge-paths.js';

/** The pattern this replaced, kept ONLY as the equivalence oracle. Never call it on
 *  untrusted input -- it is the polynomial one (CodeQL js/polynomial-redos #16). */
const LEGACY = (s: string) => s.replace(/^\/+|\/+$/g, '');

describe('trimGlobSlashes', () => {
  it('is byte-identical to the regex it replaced across every glob shape', () => {
    const cases = [
      '',
      '/',
      '//',
      '///',
      'a',
      '/a',
      'a/',
      '/a/',
      '//a//',
      'a/b',
      '/a/b/',
      '///a///b///',
      '.haive-data',
      '/.haive-data/',
      '.haive-data/knowledge_base',
      'packages/web',
      '/packages//web//',
      'x/y/z',
      './x',
      '/./',
      '..',
      '/../',
      'a b/c d',
      '*',
      '/*/',
      '/'.repeat(64),
      `${'/'.repeat(8)}mid${'/'.repeat(8)}`,
      'x/'.repeat(50),
    ];
    for (const c of cases) {
      expect(trimGlobSlashes(c), JSON.stringify(c)).toBe(LEGACY(c));
    }
  });

  it('leaves interior slashes alone', () => {
    expect(trimGlobSlashes('/a//b/')).toBe('a//b');
  });

  it('collapses an all-slash string to empty', () => {
    expect(trimGlobSlashes('/'.repeat(1000))).toBe('');
  });

  // The regression this exists for. The legacy pattern is O(n^2) on a slash run that
  // does NOT start at index 0 (a leading `^\/+` match would swallow it and leave
  // nothing to rescan). MEASURED before the fix: 650ms at n=32000, quadrupling per
  // doubling. Reachable from a request body and from a cloned repo's .gitignore, so
  // this asserts the linear bound rather than trusting the shape.
  it('stays linear on the input that made the old regex quadratic', () => {
    const attack = `x${'/'.repeat(200_000)}x`;
    const started = performance.now();
    expect(trimGlobSlashes(attack)).toBe(attack);
    // The old pattern needed ~25s at this size; 1s is a wide margin that still fails
    // loudly if someone reintroduces backtracking here.
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('still normalizes a hand-edited managed-dir glob into a strip', () => {
    expect(stripManagedKnowledgeGlobs(['/.haive-data/knowledge_base/'])).toEqual([]);
    expect(stripManagedKnowledgeGlobs(['//node_modules//'])).toEqual(['//node_modules//']);
  });
});
