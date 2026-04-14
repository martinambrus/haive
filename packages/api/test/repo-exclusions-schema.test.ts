import { describe, expect, it } from 'vitest';
import { updateRepoExclusionsRequestSchema } from '@haive/shared';

describe('updateRepoExclusionsRequestSchema', () => {
  it('accepts a valid array of paths', () => {
    const result = updateRepoExclusionsRequestSchema.safeParse({
      excludedPaths: ['node_modules', 'vendor', 'dist/'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty array', () => {
    const result = updateRepoExclusionsRequestSchema.safeParse({ excludedPaths: [] });
    expect(result.success).toBe(true);
  });

  it('rejects a missing excludedPaths field', () => {
    const result = updateRepoExclusionsRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects non-string entries', () => {
    const result = updateRepoExclusionsRequestSchema.safeParse({
      excludedPaths: [42],
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty-string entries', () => {
    const result = updateRepoExclusionsRequestSchema.safeParse({
      excludedPaths: [''],
    });
    expect(result.success).toBe(false);
  });

  it('rejects path strings longer than 1024 characters', () => {
    const result = updateRepoExclusionsRequestSchema.safeParse({
      excludedPaths: ['a'.repeat(1025)],
    });
    expect(result.success).toBe(false);
  });

  it('rejects arrays longer than 1024 entries', () => {
    const result = updateRepoExclusionsRequestSchema.safeParse({
      excludedPaths: new Array(1025).fill('x'),
    });
    expect(result.success).toBe(false);
  });
});
