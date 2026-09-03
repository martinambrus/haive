import { describe, expect, it } from 'vitest';
import { planBuildRequestSchema } from './plan.js';

describe('planBuildRequestSchema', () => {
  it('accepts a knowledge-base build with nothing else', () => {
    expect(planBuildRequestSchema.safeParse({ mode: 'from_repo' }).success).toBe(true);
  });

  it('accepts a greenfield build carrying a brief', () => {
    const out = planBuildRequestSchema.safeParse({
      mode: 'greenfield',
      description: 'A CMS for small clubs.',
    });
    expect(out.success).toBe(true);
    expect(out.data?.description).toBe('A CMS for small clubs.');
  });

  it('accepts a greenfield build with no brief when files are coming', () => {
    // deferStart means the caller is about to stream attachments and finalize
    // afterwards, so "no description" is not yet "nothing to plan from".
    expect(planBuildRequestSchema.safeParse({ mode: 'greenfield', deferStart: true }).success).toBe(
      true,
    );
  });

  it('refuses a greenfield build with neither a brief nor incoming files', () => {
    // Nothing to decompose. Dispatching it spends a CLI invocation inventing a
    // project the user never described.
    const out = planBuildRequestSchema.safeParse({ mode: 'greenfield' });
    expect(out.success).toBe(false);
    expect(out.error?.issues[0]?.path).toEqual(['description']);
  });

  it('treats a whitespace-only brief as no brief', () => {
    expect(
      planBuildRequestSchema.safeParse({ mode: 'greenfield', description: '   ' }).success,
    ).toBe(false);
  });

  it('no longer accepts the retired inline-document mode', () => {
    // `from_md` survives in the WORKER so stored tasks keep running, but nothing
    // may create one: a plan document is now an ordinary task attachment.
    expect(planBuildRequestSchema.safeParse({ mode: 'from_md' }).success).toBe(false);
  });

  it('ignores an inline document rather than accepting it', () => {
    const out = planBuildRequestSchema.safeParse({
      mode: 'from_repo',
      document: { filename: 'plan.md', content: '# Plan\n' },
    });
    expect(out.success).toBe(true);
    expect(out.data).not.toHaveProperty('document');
  });
});
