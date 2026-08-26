import { describe, expect, it } from 'vitest';
import { looksLikeMarkdown } from './looks-like-markdown';

describe('looksLikeMarkdown', () => {
  it('detects a heading line', () => {
    expect(looksLikeMarkdown('## A heading')).toBe(true);
    expect(looksLikeMarkdown('prose\n### deeper heading\nmore prose')).toBe(true);
  });

  it('detects fenced code, inline code, bold and links', () => {
    expect(looksLikeMarkdown('```\ncode\n```')).toBe(true);
    expect(looksLikeMarkdown('run `make build` now')).toBe(true);
    expect(looksLikeMarkdown('a **bold** run')).toBe(true);
    expect(looksLikeMarkdown('see [docs](https://example.com) here')).toBe(true);
  });

  it('stays conservative on plain text that merely looks markedy', () => {
    // The heuristic decides only the line-break policy, so a false positive
    // would hard-wrap prose that was meant to keep its newlines.
    expect(looksLikeMarkdown('Just a sentence.')).toBe(false);
    expect(looksLikeMarkdown('- a bullet-like line\n- another')).toBe(false);
    expect(looksLikeMarkdown('2 * 3 * 4 = 24')).toBe(false);
    expect(looksLikeMarkdown('snake_case_name and _emphasis_')).toBe(false);
    expect(looksLikeMarkdown('a single `backtick')).toBe(false);
    expect(looksLikeMarkdown('[bracket] (paren) without a link')).toBe(false);
  });

  it('does not span lines for inline constructs', () => {
    expect(looksLikeMarkdown('**starts here\nand ends** later')).toBe(false);
  });
});
