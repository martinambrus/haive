import { describe, expect, it } from 'vitest';
import { planChatRequestSchema, normalizeStepFormValues } from '@haive/shared/schemas';

describe('plan chat submit limit', () => {
  it('accepts an opening or follow-up turn at the reserved limit', () => {
    const message = 'x'.repeat(20_000);
    expect(planChatRequestSchema.safeParse({ message }).success).toBe(true);
    expect(normalizeStepFormValues('01-plan-chat', { message }).success).toBe(true);
  });
  it('refuses oversized new turns on both submit surfaces with the limit stated', () => {
    const message = 'x'.repeat(20_001);
    expect(planChatRequestSchema.safeParse({ message }).success).toBe(false);
    const parsed = normalizeStepFormValues('01-plan-chat', { message });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.issues.join(' ')).toMatch(/20,000|20000/);
  });
});
