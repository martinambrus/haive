import { describe, it, expect } from 'vitest';
import { adversarialQaReviewStep, formatQaFixDiagnosis } from './08d2-adversarial-qa-review.js';
import type { StepContext, StepApplyArgs } from '../../step-definition.js';

const detected = {
  ran: true,
  level: 'standard',
  blocking: true,
  counts: { critical: 1, high: 1, total: 3 },
  findings: [
    {
      key: '0',
      severity: 'critical',
      label: '[critical] sqli @ q.php:5',
      line: '- [critical] sqli @ q.php:5: dump — fix: param',
    },
    {
      key: '1',
      severity: 'high',
      label: '[high] xss @ v.tsx:10',
      line: '- [high] xss @ v.tsx:10: steal',
    },
    { key: '2', severity: 'low', label: '[low] nit @ a.ts:1', line: '- [low] nit @ a.ts:1: style' },
  ],
};

const stubCtx = { logger: { info: () => {} } } as unknown as StepContext;

function applyArgs(formValues: Record<string, unknown>): StepApplyArgs<typeof detected> {
  return { detected, formValues, iteration: 0, previousIterations: [] };
}

describe('formatQaFixDiagnosis', () => {
  it('is empty when there is nothing to act on', () => {
    expect(formatQaFixDiagnosis([], '')).toBe('');
  });
  it('includes the findings and the reviewer instructions', () => {
    const d = formatQaFixDiagnosis(['- finding a'], 'also harden X');
    expect(d).toContain('- finding a');
    expect(d).toContain('also harden X');
  });
});

describe('08d2 form', () => {
  it('offers fix/accept (defaulting to fix when blocking) and a multi-select of findings', () => {
    const schema = adversarialQaReviewStep.form!(stubCtx, detected);
    const decision = schema.fields.find((f) => f.id === 'decision') as {
      type?: string;
      default?: string;
    };
    expect(decision.type).toBe('radio');
    expect(decision.default).toBe('fix');
    const multi = schema.fields.find((f) => f.id === 'findingKeys') as {
      options?: { value: string }[];
    };
    expect(multi.options).toHaveLength(3);
  });
});

describe('08d2 apply', () => {
  it('accept produces no diagnosis so the step finalizes', async () => {
    const out = await adversarialQaReviewStep.apply(stubCtx, applyArgs({ decision: 'accept' }));
    expect(out.decision).toBe('accept');
    expect(out.diagnosis).toBe('');
  });

  it('fix + all sends every finding back', async () => {
    const out = await adversarialQaReviewStep.apply(
      stubCtx,
      applyArgs({ decision: 'fix', scope: 'all' }),
    );
    expect(out.decision).toBe('fix');
    expect(out.selectedCount).toBe(3);
    expect(out.diagnosis).toContain('sqli');
    expect(out.diagnosis).toContain('nit');
  });

  it('fix + critical_high drops the low-severity finding', async () => {
    const out = await adversarialQaReviewStep.apply(
      stubCtx,
      applyArgs({ decision: 'fix', scope: 'critical_high' }),
    );
    expect(out.selectedCount).toBe(2);
    expect(out.diagnosis).not.toContain('nit');
  });

  it('fix + selected uses only the picked findings', async () => {
    const out = await adversarialQaReviewStep.apply(
      stubCtx,
      applyArgs({ decision: 'fix', scope: 'selected', findingKeys: ['1'] }),
    );
    expect(out.selectedCount).toBe(1);
    expect(out.diagnosis).toContain('xss');
    expect(out.diagnosis).not.toContain('sqli');
  });
});

describe('08d2 restartLoop', () => {
  it('routes fix back to implementation and finalizes accept (and empty fix)', () => {
    const hook = adversarialQaReviewStep.restartLoop!;
    expect(hook.evaluate({ decision: 'fix', diagnosis: 'do it', selectedCount: 1 })).toEqual({
      diagnosis: 'do it',
    });
    expect(hook.evaluate({ decision: 'accept', diagnosis: '', selectedCount: 0 })).toBeNull();
    // fix with nothing selected and no feedback → empty diagnosis → finalize, no loop.
    expect(hook.evaluate({ decision: 'fix', diagnosis: '', selectedCount: 0 })).toBeNull();
  });
});
