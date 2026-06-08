import { describe, expect, it } from 'vitest';
import { llmReviewMarkdown } from '../src/step-engine/steps/onboarding/11-final-review.js';

const FALLBACK = '# fallback\n';

describe('llmReviewMarkdown', () => {
  it('does not truncate a ```markdown-wrapped review that contains inner code blocks', () => {
    const review = [
      '# Onboarding final review',
      '',
      'Run:',
      '```bash',
      'pnpm test',
      '```',
      '',
      'Done.',
    ].join('\n');
    const out = llmReviewMarkdown(['```markdown', review, '```'].join('\n'), FALLBACK);
    expect(out.startsWith('# Onboarding final review')).toBe(true);
    expect(out).toContain('```bash');
    expect(out).toContain('pnpm test');
    expect(out).toContain('Done.');
  });

  it('passes an unwrapped review through unchanged (plus trailing newline)', () => {
    const review = '# Onboarding final review\n\nAll good.';
    expect(llmReviewMarkdown(review, FALLBACK)).toBe(`${review}\n`);
  });

  it('keeps a bare code fence that is part of the content, not an outer wrapper', () => {
    const review = '# Review\n\n```ts\nconst x = 1;\n```';
    const out = llmReviewMarkdown(review, FALLBACK);
    expect(out).toContain('```ts');
    expect(out).toContain('const x = 1;');
  });

  it('prefixes a heading when the body does not start with #', () => {
    const out = llmReviewMarkdown('Just some notes.', FALLBACK);
    expect(out.startsWith('# Onboarding final review')).toBe(true);
    expect(out).toContain('Just some notes.');
  });

  it('returns the fallback for empty / non-string input', () => {
    expect(llmReviewMarkdown('', FALLBACK)).toBe(FALLBACK);
    expect(llmReviewMarkdown(null, FALLBACK)).toBe(FALLBACK);
    expect(llmReviewMarkdown('   ', FALLBACK)).toBe(FALLBACK);
  });
});
