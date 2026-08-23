import { describe, it, expect } from 'vitest';
import {
  adversarialQaReviewStep,
  formatQaFixDiagnosis,
  formatWaiverLedgerEntry,
  foldsAtGate,
  partitionFindings,
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
      fingerprints: ['fp-sqli-bandit', 'fp-sqli-infector'],
      label: '[critical] sqli @ q.php:5',
      line: '- [critical] sqli @ q.php:5: dump — fix: param',
    },
    {
      key: '1',
      severity: 'high',
      fingerprints: ['fp-xss'],
      label: '[high] xss @ v.tsx:10',
      line: '- [high] xss @ v.tsx:10: steal',
    },
    {
      key: '2',
      severity: 'low',
      fingerprints: ['fp-nit'],
      label: '[low] nit @ a.ts:1',
      line: '- [low] nit @ a.ts:1: style',
    },
  ],
};

/** ctx with a capturing db, so the waiver's two writes can be asserted: the disposition
 *  UPDATE on review_findings and the ledger entry on task_events. */
function captureCtx(): {
  ctx: StepContext;
  updates: Record<string, unknown>[];
  ledger: Record<string, unknown>[];
} {
  const updates: Record<string, unknown>[] = [];
  const ledger: Record<string, unknown>[] = [];
  const ctx = {
    taskId: 'task-1',
    taskStepId: 'step-1',
    round: 2,
    logger: { info: () => {}, warn: () => {} },
    db: {
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updates.push(values);
          return { where: () => Promise.resolve() };
        },
      }),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          ledger.push(values);
          return Promise.resolve();
        },
      }),
    },
  } as unknown as StepContext;
  return { ctx, updates, ledger };
}

const stubCtx = captureCtx().ctx;

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

describe('partitionFindings', () => {
  it('all takes everything and waives nothing', () => {
    const { chosen, waived } = partitionFindings(detected.findings as never, 'all', []);
    expect(chosen).toHaveLength(3);
    expect(waived).toHaveLength(0);
  });

  it('critical_high waives the non-blocking remainder', () => {
    const { chosen, waived } = partitionFindings(detected.findings as never, 'critical_high', []);
    expect(chosen.map((f) => f.key)).toEqual(['0', '1']);
    expect(waived.map((f) => f.key)).toEqual(['2']);
  });

  it('selected waives everything the developer did not pick', () => {
    const { chosen, waived } = partitionFindings(detected.findings as never, 'selected', ['1']);
    expect(chosen.map((f) => f.key)).toEqual(['1']);
    expect(waived.map((f) => f.key)).toEqual(['0', '2']);
  });

  it('treats an unknown scope as all, so a stale form value cannot silently waive', () => {
    const { waived } = partitionFindings(detected.findings as never, 'something-else', []);
    expect(waived).toHaveLength(0);
  });
});

describe('formatWaiverLedgerEntry', () => {
  it('invites a re-raise rather than warning the next round off', () => {
    const text = formatWaiverLedgerEntry(2, detected.findings.slice(2) as never);
    expect(text).toContain('chose');
    expect(text).toContain('NOT to fix them in this round');
    expect(text).toContain('recorded, not deleted');
    expect(text).toContain('raise one again if you can');
    expect(text).toContain('[low] nit @ a.ts:1');
  });

  it('carries the short label, not the full finding line, to stay inside the ledger budget', () => {
    const text = formatWaiverLedgerEntry(2, detected.findings.slice(2) as never);
    expect(text).not.toContain('style');
  });
});

describe('08d2 waiver writes', () => {
  it('accept waives nothing — gate 2 still holds the call', async () => {
    const { ctx, updates, ledger } = captureCtx();
    const out = await adversarialQaReviewStep.apply(ctx, applyArgs({ decision: 'accept' }));
    expect(out.waivedCount).toBe(0);
    expect(updates).toHaveLength(0);
    expect(ledger).toHaveLength(0);
  });

  it('fix + all waives nothing, because nothing was left out', async () => {
    const { ctx, updates, ledger } = captureCtx();
    const out = await adversarialQaReviewStep.apply(
      ctx,
      applyArgs({ decision: 'fix', scope: 'all' }),
    );
    expect(out.waivedCount).toBe(0);
    expect(updates).toHaveLength(0);
    expect(ledger).toHaveLength(0);
  });

  it('fix + selected dispositions the leftovers and leaves the ledger a re-raise note', async () => {
    const { ctx, updates, ledger } = captureCtx();
    const out = await adversarialQaReviewStep.apply(
      ctx,
      applyArgs({ decision: 'fix', scope: 'selected', findingKeys: ['1'] }),
    );
    expect(out.waivedCount).toBe(2);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.disposition).toBe('dismissed_human');
    expect(updates[0]!.dispositionSource).toBe('08d2-adversarial-qa-review');
    expect(ledger).toHaveLength(1);
    const payload = ledger[0]!.payload as { text: string; round: number; stepId: string };
    expect(payload.round).toBe(2);
    expect(payload.stepId).toBe('08d2-adversarial-qa-review');
    // The waived pair, and NOT the finding that was sent back to be fixed.
    expect(payload.text).toContain('sqli');
    expect(payload.text).toContain('nit');
    expect(payload.text).not.toContain('xss');
  });

  it('never fails the gate when the telemetry writes throw', async () => {
    const brokenCtx = {
      taskId: 'task-1',
      taskStepId: 'step-1',
      round: 1,
      logger: { info: () => {}, warn: () => {} },
      db: {
        update: () => {
          throw new Error('db down');
        },
        insert: () => {
          throw new Error('db down');
        },
      },
    } as unknown as StepContext;
    const out = await adversarialQaReviewStep.apply(
      brokenCtx,
      applyArgs({ decision: 'fix', scope: 'critical_high' }),
    );
    expect(out.decision).toBe('fix');
    expect(out.selectedCount).toBe(2);
    expect(out.waivedCount).toBe(1);
  });
});

describe('08d2 restartLoop', () => {
  it('routes fix back to implementation and finalizes accept (and empty fix)', () => {
    const hook = adversarialQaReviewStep.restartLoop!;
    expect(
      hook.evaluate({ decision: 'fix', diagnosis: 'do it', selectedCount: 1, waivedCount: 0 }),
    ).toEqual({
      diagnosis: 'do it',
    });
    expect(
      hook.evaluate({ decision: 'accept', diagnosis: '', selectedCount: 0, waivedCount: 0 }),
    ).toBeNull();
    // fix with nothing selected and no feedback → empty diagnosis → finalize, no loop.
    expect(
      hook.evaluate({ decision: 'fix', diagnosis: '', selectedCount: 0, waivedCount: 3 }),
    ).toBeNull();
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
