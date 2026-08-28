import { describe, expect, it } from 'vitest';
import { planBuildRequestSchema } from './plan.js';

const doc = { filename: 'plan.md', content: '# Plan\n' };

describe('planBuildRequestSchema', () => {
  it('accepts a knowledge-base build with no document', () => {
    expect(planBuildRequestSchema.safeParse({ mode: 'from_repo' }).success).toBe(true);
  });

  it('accepts a document build carrying its document', () => {
    expect(planBuildRequestSchema.safeParse({ mode: 'from_md', document: doc }).success).toBe(true);
  });

  it('refuses a document build with nothing attached', () => {
    // The from_md prompt tells the agent to read "the attached document";
    // dispatching that with nothing there spends an invocation drafting a plan
    // for a file that does not exist.
    const out = planBuildRequestSchema.safeParse({ mode: 'from_md' });
    expect(out.success).toBe(false);
    expect(out.error?.issues[0]?.path).toEqual(['document']);
  });

  it('refuses a document larger than the inline cap', () => {
    const out = planBuildRequestSchema.safeParse({
      mode: 'from_md',
      document: { filename: 'huge.md', content: 'x'.repeat(1_048_577) },
    });
    expect(out.success).toBe(false);
  });

  it('refuses an empty document, which would decompose to nothing', () => {
    expect(
      planBuildRequestSchema.safeParse({
        mode: 'from_md',
        document: { filename: 'empty.md', content: '' },
      }).success,
    ).toBe(false);
  });

  it('refuses a document with no filename', () => {
    expect(
      planBuildRequestSchema.safeParse({
        mode: 'from_md',
        document: { filename: '   ', content: '# Plan' },
      }).success,
    ).toBe(false);
  });

  it('carries a greenfield brief', () => {
    const out = planBuildRequestSchema.safeParse({
      mode: 'from_repo',
      description: 'A CMS for small clubs.',
    });
    expect(out.success).toBe(true);
    expect(out.data?.description).toBe('A CMS for small clubs.');
  });
});
