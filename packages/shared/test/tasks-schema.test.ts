import { describe, expect, it } from 'vitest';
import {
  stepLoopLimitsSchema,
  createTaskRequestSchema,
  resolvePlanNodeLinks,
} from '../src/schemas/tasks.js';
import { PLAN_TASK_MAX_NODES } from '../src/schemas/plan.js';

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

describe('createTaskRequestSchema with feature and affectedClients', () => {
  const baseWorkflow = {
    type: 'workflow' as const,
    title: 'fix checkout bug',
    description: 'a real description',
  };

  it('accepts a workflow task with feature and affectedClients', () => {
    const parsed = createTaskRequestSchema.parse({
      ...baseWorkflow,
      feature: 'checkout',
      affectedClients: ['acme', 'globex'],
    });
    expect(parsed.feature).toBe('checkout');
    expect(parsed.affectedClients).toEqual(['acme', 'globex']);
  });

  it('trims the feature and the client names', () => {
    const parsed = createTaskRequestSchema.parse({
      ...baseWorkflow,
      feature: '  checkout  ',
      affectedClients: ['  acme  '],
    });
    expect(parsed.feature).toBe('checkout');
    expect(parsed.affectedClients).toEqual(['acme']);
  });

  it('treats both as optional', () => {
    const parsed = createTaskRequestSchema.parse(baseWorkflow);
    expect(parsed.feature).toBeUndefined();
    expect(parsed.affectedClients).toBeUndefined();
  });

  it('rejects an over-long feature (>120 chars)', () => {
    const result = createTaskRequestSchema.safeParse({
      ...baseWorkflow,
      feature: 'x'.repeat(121),
    });
    expect(result.success).toBe(false);
  });

  it('rejects an over-sized affectedClients array (>50)', () => {
    const result = createTaskRequestSchema.safeParse({
      ...baseWorkflow,
      affectedClients: Array.from({ length: 51 }, (_, i) => `c${i}`),
    });
    expect(result.success).toBe(false);
  });
});

describe('resolvePlanNodeLinks', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';

  it('returns null when the request names no node', () => {
    expect(resolvePlanNodeLinks({})).toBeNull();
    expect(resolvePlanNodeLinks({ planNodeIds: [] })).toBeNull();
  });

  it('defaults ONE node to implements — unchanged from before multi-node existed', () => {
    expect(resolvePlanNodeLinks({ planNodeId: A })).toEqual({ nodeIds: [A], role: 'implements' });
    expect(resolvePlanNodeLinks({ planNodeIds: [A] })).toEqual({
      nodeIds: [A],
      role: 'implements',
    });
  });

  it('defaults TWO OR MORE to touched, so nothing is greened by a slice', () => {
    expect(resolvePlanNodeLinks({ planNodeIds: [A, B] })).toEqual({
      nodeIds: [A, B],
      role: 'touched',
    });
  });

  it('lets an explicit role win in both directions', () => {
    expect(resolvePlanNodeLinks({ planNodeIds: [A, B], planNodeRole: 'implements' })?.role).toBe(
      'implements',
    );
    expect(resolvePlanNodeLinks({ planNodeId: A, planNodeRole: 'touched' })?.role).toBe('touched');
  });

  it('folds the deprecated alias in without duplicating it', () => {
    // A bookmarked plan-panel URL carries planNodeId; the caller may also have
    // built the array. One node, not two, and the count is what picks the role.
    expect(resolvePlanNodeLinks({ planNodeId: A, planNodeIds: [A] })).toEqual({
      nodeIds: [A],
      role: 'implements',
    });
    expect(resolvePlanNodeLinks({ planNodeId: B, planNodeIds: [A] })).toEqual({
      nodeIds: [A, B],
      role: 'touched',
    });
  });

  it('rejects an over-cap array at the schema, rather than truncating it', () => {
    const result = createTaskRequestSchema.safeParse({
      type: 'workflow',
      title: 'spans too much',
      description: 'a real description',
      planNodeIds: Array.from({ length: PLAN_TASK_MAX_NODES + 1 }, () => A),
    });
    expect(result.success).toBe(false);
  });
});
