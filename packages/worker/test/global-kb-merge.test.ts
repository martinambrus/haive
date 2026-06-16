import { describe, expect, it } from 'vitest';
import { extractMergedArticle } from '../src/step-engine/steps/onboarding/09_6_4-global-kb-merge.js';

describe('extractMergedArticle', () => {
  it('extracts the article between the markers', () => {
    const raw = [
      'Sure, here is the merged article:',
      '<<<MERGED',
      '# PHP 5 Best Practices',
      '',
      '## PDO',
      'use prepared statements',
      'MERGED>>>',
      'Let me know if you want changes.',
    ].join('\n');
    const out = extractMergedArticle(raw);
    expect(out.startsWith('# PHP 5 Best Practices')).toBe(true);
    expect(out).toContain('use prepared statements');
    expect(out).not.toContain('Sure, here is');
    expect(out).not.toContain('Let me know');
  });

  it('falls back to the whole trimmed text when no markers are present', () => {
    expect(extractMergedArticle('  # Title\n\nbody  ')).toBe('# Title\n\nbody');
  });

  it('returns empty for null/empty input', () => {
    expect(extractMergedArticle(null)).toBe('');
    expect(extractMergedArticle('')).toBe('');
    expect(extractMergedArticle(undefined)).toBe('');
  });
});
