import { describe, expect, it } from 'vitest';
import { findCoverageGaps, headingTerms, parseDocSections } from './plan-coverage-scan.js';

const section = (title: string, line = 1) => ({ title, level: 2, line, body: '' });

describe('headingTerms', () => {
  it('drops the numbering and the filler', () => {
    expect(headingTerms('4.5a Story graph and progression')).toEqual([
      'story',
      'graph',
      'progression',
    ]);
  });

  it('has nothing to look for in a heading of only filler', () => {
    // Reporting this would report the absence of a question, not of an answer.
    expect(headingTerms('2. How to use this')).toEqual([]);
  });
});

describe('findCoverageGaps', () => {
  it('flags a section the plan never mentions', () => {
    const gaps = findCoverageGaps(
      [section('7.8 Music and SFX')],
      ['Curriculum authoring workflow'],
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.missingTerms).toEqual(['music']);
  });

  it('does not flag a section covered only in node BODIES', () => {
    // The rule that matters: an earlier audit scored titles alone and produced
    // false positives that title+body scoring does not.
    const gaps = findCoverageGaps(
      [section('4.4 SRS and mastery contract')],
      ['FSRS binding and card keys — implements the SRS and mastery gates for each act'],
    );
    expect(gaps).toEqual([]);
  });

  it('does not flag an umbrella heading its children cover', () => {
    // "3. Architecture and repository contract" was a false positive in a real
    // audit: every sub-section was represented, only the umbrella words were not.
    const gaps = findCoverageGaps(
      [section('3. Architecture and repository contract')],
      ['Monorepo architecture, package boundaries and the repository layout'],
    );
    expect(gaps).toEqual([]);
  });

  it('does not flag endpoints a surface node covers', () => {
    // The other historical false positive: REST paths not transcribed verbatim,
    // but described by a node naming that exact surface.
    const gaps = findCoverageGaps(
      [section('3.4 API surface')],
      ['Canonical OpenAPI 3.1 contract and declared operation surface: act preparations'],
    );
    expect(gaps).toEqual([]);
  });

  it('reports evidence a reader can act on', () => {
    // Partial coverage still counts as a candidate: "Act extension" is present
    // but "presentation patch" is not, and one term of three is below the
    // threshold. What makes that dismissable in one click is the evidence.
    const [gap] = findCoverageGaps(
      [section('5.4 Act extension and presentation patch', 791)],
      ['Act extension handling', 'Act extension and structural replacement'],
    );
    expect(gap?.missingTerms).toEqual(['presentation', 'patch']);
    expect(gap?.line).toBe(791);
    expect(gap?.score).toBe(0.33);
  });

  it('is not a gap once most of the subject is present', () => {
    const gaps = findCoverageGaps(
      [section('5.4 Act extension and presentation patch')],
      ['Act extension, presentation patch and structural replacement'],
    );
    expect(gaps).toEqual([]);
  });

  it('orders the worst gap first', () => {
    const gaps = findCoverageGaps(
      [section('Zebra quarks', 10), section('Music glockenspiel authoring', 20)],
      ['authoring workflow'],
    );
    expect(gaps[0]!.title).toBe('Zebra quarks');
    expect(gaps[0]!.score).toBe(0);
  });

  it('finds nothing in a plan that covers everything', () => {
    // The auto-pass case: a clean build must finish unattended.
    expect(
      findCoverageGaps([section('7.8 Music and SFX')], ['Music and SFX production pipeline']),
    ).toEqual([]);
  });
});

describe('parseDocSections', () => {
  it('carries each section its own text, up to the next heading', () => {
    const doc = ['# Title', '## One', 'first body', '## Two', 'second body', 'more'].join('\n');
    const secs = parseDocSections(doc);
    expect(secs.map((s) => s.title)).toEqual(['One', 'Two']);
    expect(secs[0]!.body.trim()).toBe('first body');
    expect(secs[1]!.body.trim()).toBe('second body\nmore');
    expect(secs[0]!.line).toBe(2);
  });

  it('ignores the h1 so the whole document is not one section', () => {
    expect(parseDocSections('# Doc\n## A\nx').map((s) => s.title)).toEqual(['A']);
  });
});
