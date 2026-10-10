import { describe, expect, it } from 'vitest';
import { reviewerOutputSchema } from '../src/schemas/dag.js';

const verdict = (issues: unknown[]) => ({ verdict: 'fix_required', issues });

describe('reviewerOutputSchema in_scope', () => {
  it.each([['no (pre-existing)'], ['yes'], [false], [true]])(
    'keeps %j on the parsed issue',
    (v) => {
      const parsed = reviewerOutputSchema.parse(verdict([{ description: 'd', in_scope: v }]));
      expect(parsed.issues[0]?.in_scope).toBe(v);
    },
  );

  it('reads a value of another type as absent and keeps the verdict', () => {
    const parsed = reviewerOutputSchema.parse(verdict([{ description: 'd', in_scope: 7 }]));
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]?.in_scope).toBeUndefined();
  });
});
