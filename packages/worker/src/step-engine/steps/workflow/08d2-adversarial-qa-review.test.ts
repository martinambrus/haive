import { describe, it, expect } from 'vitest';
import {
  adversarialQaReviewStep,
  formatQaFixDiagnosis,
  foldsAtGate,
} from './08d2-adversarial-qa-review.js';
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

describe('foldsAtGate', () => {
  it('folds a non-blocking finding a verifier ran and could not reproduce', () => {
    expect(foldsAtGate('not_reproduced', 'medium')).toBe(true);
    expect(foldsAtGate('not_reproduced', 'low')).toBe(true);
  });

  it('never folds a blocking finding, whatever the verdict', () => {
    // 08d downgrades those to advisory and keeps them visible — the developer keeps the call.
    expect(foldsAtGate('not_reproduced', 'critical')).toBe(false);
    expect(foldsAtGate('not_reproduced', 'high')).toBe(false);
  });

  it('never folds untestable — that is the environment failing, not the finding', () => {
    // Folding on it would turn a tooling outage into silent data loss.
    expect(foldsAtGate('untestable', 'low')).toBe(false);
  });

  it('never folds unverified or an absent verdict — nobody looked', () => {
    expect(foldsAtGate('unverified', 'low')).toBe(false);
    expect(foldsAtGate(undefined, 'low')).toBe(false);
  });

  it('never folds a reproduced finding', () => {
    expect(foldsAtGate('reproduced', 'medium')).toBe(false);
  });
});

describe('08d2 form — filtered count', () => {
  const withFiltered = (filteredCount: number) => ({ ...detected, filteredCount });

  it('states the filtered count and why, rather than dropping findings silently', () => {
    const schema = adversarialQaReviewStep.form!(stubCtx, withFiltered(14) as never);
    const body = JSON.stringify(schema);
    expect(body).toContain('14 further finding(s) are hidden');
    expect(body).toContain('could not reproduce');
    expect(body).toContain('remain');
    // And the preview reads as shown/filtered, not as a smaller total.
    expect(body).toContain('14 filtered');
  });

  it('says nothing about filtering when nothing was filtered', () => {
    const schema = adversarialQaReviewStep.form!(stubCtx, withFiltered(0) as never);
    const body = JSON.stringify(schema);
    expect(body).not.toContain('are hidden');
    expect(body).not.toContain('filtered');
  });
});
