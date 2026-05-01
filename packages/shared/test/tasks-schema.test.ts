import { describe, expect, it } from 'vitest';
import { stepLoopLimitsSchema, createTaskRequestSchema } from '../src/schemas/tasks.js';

describe('stepLoopLimitsSchema', () => {
  it('accepts a map of stepId → integer in [1, 50]', () => {
    const parsed = stepLoopLimitsSchema.parse({
      '05-phase-0b5-spec-quality': 5,
      'other-loop-step': 50,
    });
    expect(parsed).toEqual({
      '05-phase-0b5-spec-quality': 5,
      'other-loop-step': 50,
    });
  });

  it('accepts an empty record', () => {
    const parsed = stepLoopLimitsSchema.parse({});
    expect(parsed).toEqual({});
  });

  it('treats omission as undefined (the column-default {} happens at insert time)', () => {
    const parsed = stepLoopLimitsSchema.parse(undefined);
    expect(parsed).toBeUndefined();
  });

  it('rejects non-integer iteration counts', () => {
    expect(() => stepLoopLimitsSchema.parse({ x: 1.5 })).toThrow();
  });

  it('rejects iteration counts of 0 or negative', () => {
    expect(() => stepLoopLimitsSchema.parse({ x: 0 })).toThrow();
    expect(() => stepLoopLimitsSchema.parse({ x: -1 })).toThrow();
  });

  it('rejects iteration counts above the 50 ceiling (LLM-cost guardrail)', () => {
    expect(() => stepLoopLimitsSchema.parse({ x: 51 })).toThrow();
    expect(() => stepLoopLimitsSchema.parse({ x: 100 })).toThrow();
  });

  it('rejects empty-string step keys', () => {
    expect(() => stepLoopLimitsSchema.parse({ '': 3 })).toThrow();
  });
});

describe('createTaskRequestSchema with stepLoopLimits', () => {
  const baseOnboarding = {
    type: 'onboarding' as const,
    title: 'Onboard repo',
  };

  it('accepts onboarding tasks without stepLoopLimits', () => {
    const parsed = createTaskRequestSchema.parse(baseOnboarding);
    expect(parsed.stepLoopLimits).toBeUndefined();
  });

  it('accepts onboarding tasks with valid stepLoopLimits', () => {
    const parsed = createTaskRequestSchema.parse({
      ...baseOnboarding,
      stepLoopLimits: { '05-phase-0b5-spec-quality': 10 },
    });
    expect(parsed.stepLoopLimits).toEqual({ '05-phase-0b5-spec-quality': 10 });
  });

  it('rejects workflow tasks missing description (existing refinement still holds)', () => {
    const result = createTaskRequestSchema.safeParse({
      type: 'workflow',
      title: 'do thing',
      stepLoopLimits: { x: 3 },
    });
    expect(result.success).toBe(false);
  });

  it('accepts workflow tasks with both description and stepLoopLimits', () => {
    const parsed = createTaskRequestSchema.parse({
      type: 'workflow',
      title: 'do thing',
      description: 'a real description',
      stepLoopLimits: { '05-phase-0b5-spec-quality': 5 },
    });
    expect(parsed.stepLoopLimits).toEqual({ '05-phase-0b5-spec-quality': 5 });
  });

  it('rejects out-of-range loop limits in a create payload', () => {
    const result = createTaskRequestSchema.safeParse({
      ...baseOnboarding,
      stepLoopLimits: { x: 0 },
    });
    expect(result.success).toBe(false);
  });
});
