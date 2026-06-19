import { describe, expect, it } from 'vitest';
import { logger } from '@haive/shared';
import {
  parseCorrectorOutput,
  parseSpecQualityOutput,
  phase0b5SpecQualityStep,
  reviewScorePlateaued,
} from '../src/step-engine/steps/workflow/05-phase-0b5-spec-quality.js';
import type { StepLoopPassRecord } from '../src/step-engine/step-definition.js';

describe('reviewScorePlateaued (diminishing-returns gate)', () => {
  type Outs = Parameters<typeof reviewScorePlateaued>[0];
  const r = (score: number, verdict = 'NEEDS_REVISION') => ({ source: 'review', verdict, score });
  const c = (score: number) => ({ source: 'correct', verdict: 'NEEDS_REVISION', score });
  const plateaued = (outs: unknown[]) => reviewScorePlateaued(outs as unknown as Outs);

  it('returns false until more than STALL_REVIEWS reviews exist', () => {
    expect(plateaued([r(7)])).toBe(false);
    expect(plateaued([r(7), r(6)])).toBe(false);
  });

  it('stops on a wobble that never sets a new best (7,6,8,7,8)', () => {
    expect(plateaued([r(7), r(6), r(8), r(7), r(8)])).toBe(true);
  });

  it('keeps going on a genuine climb (5,6,7,8)', () => {
    expect(plateaued([r(5), r(6), r(7), r(8)])).toBe(false);
  });

  it('stops when scores are flat', () => {
    expect(plateaued([r(7), r(7), r(7)])).toBe(true);
  });

  it('treats a verdict upgrade as a new best (keeps going)', () => {
    expect(plateaued([r(5), r(5), r(5, 'APPROVED')])).toBe(false);
  });

  it('ignores corrector passes — only reviews count', () => {
    expect(plateaued([r(7), c(7), r(6), c(6), r(8)])).toBe(false);
  });
});

describe('parseSpecQualityOutput', () => {
  it('returns null for empty / non-stringy / unparseable input', () => {
    expect(parseSpecQualityOutput(null)).toBeNull();
    expect(parseSpecQualityOutput(undefined)).toBeNull();
    expect(parseSpecQualityOutput(42)).toBeNull();
    expect(parseSpecQualityOutput('no fence here, just prose')).toBeNull();
    expect(parseSpecQualityOutput('```json\n{not valid json}\n```')).toBeNull();
  });

  it('parses a fenced JSON block with score + findings', () => {
    const raw = [
      'preamble that should be ignored',
      '```json',
      JSON.stringify({
        score: 7,
        findings: [
          { dimension: 'goal_clarity', severity: 'warn', comment: 'be more specific' },
          { dimension: 'risk_coverage', severity: 'info', comment: 'looks fine' },
        ],
      }),
      '```',
      'trailing prose',
    ].join('\n');
    const result = parseSpecQualityOutput(raw);
    expect(result?.score).toBe(7);
    expect(result?.findings).toHaveLength(2);
    expect(result?.findings[0]).toMatchObject({
      dimension: 'goal_clarity',
      severity: 'warn',
      comment: 'be more specific',
    });
    expect(result?.amendedSpec).toBeNull();
  });

  it('captures amendedSpec from the fenced JSON when present', () => {
    const raw = [
      '```json',
      JSON.stringify({
        score: 4,
        findings: [
          { dimension: 'acceptance_criteria', severity: 'error', comment: 'no AC at all' },
        ],
        amendedSpec: '## Goal\nfoo\n## Acceptance criteria\n- bar\n',
      }),
      '```',
    ].join('\n');
    const result = parseSpecQualityOutput(raw);
    expect(result?.score).toBe(4);
    expect(result?.amendedSpec).toBe('## Goal\nfoo\n## Acceptance criteria\n- bar\n');
  });

  it('parses JSON whose amendedSpec contains nested ``` code fences (regression)', () => {
    // Reproduces the loop trap: the reviewer returns the full revised spec in
    // amendedSpec, which itself is markdown with ``` code fences. A non-greedy
    // /```json([\s\S]*?)```/ stopped at the first inner fence and truncated the
    // JSON, so every pass fell to the stub (NEEDS_REVISION) and looped to budget.
    const amended = [
      '## Config',
      '```yaml',
      'key: value',
      '```',
      '```php',
      '<?php echo 1;',
      '```',
    ].join('\n');
    const raw = [
      'Now I have enough data. Let me compile the verdict.',
      '```json',
      JSON.stringify({
        verdict: 'NEEDS_REVISION',
        score: 3,
        findings: [{ dimension: 'goal_clarity', severity: 'warn', comment: 'tighten' }],
        amendedSpec: amended,
      }),
      '```',
      'trailing prose with a stray ``` fence',
    ].join('\n');
    const result = parseSpecQualityOutput(raw);
    expect(result).not.toBeNull();
    expect(result?.verdict).toBe('NEEDS_REVISION');
    expect(result?.score).toBe(3);
    expect(result?.findings).toHaveLength(1);
    expect(result?.amendedSpec).toBe(amended);
  });

  it('clamps score to [0, 10] and rounds non-integer values', () => {
    const high = parseSpecQualityOutput('```json\n{"score": 99.9, "findings": []}\n```');
    expect(high?.score).toBe(10);
    const low = parseSpecQualityOutput('```json\n{"score": -3, "findings": []}\n```');
    expect(low?.score).toBe(0);
    const fractional = parseSpecQualityOutput('```json\n{"score": 6.4, "findings": []}\n```');
    expect(fractional?.score).toBe(6);
  });

  it('coerces unknown severity to info and missing fields to defaults', () => {
    const raw = [
      '```json',
      JSON.stringify({
        score: 5,
        findings: [
          { severity: 'critical', comment: 'unknown sev' },
          { dimension: 'test_strategy' },
          'not even an object',
        ],
      }),
      '```',
    ].join('\n');
    const result = parseSpecQualityOutput(raw);
    expect(result?.findings).toHaveLength(2);
    expect(result?.findings[0]).toMatchObject({
      dimension: 'general',
      severity: 'info',
      comment: 'unknown sev',
    });
    expect(result?.findings[1]).toMatchObject({
      dimension: 'test_strategy',
      severity: 'info',
      comment: '',
    });
  });

  it('accepts an object payload directly (skips fence parsing)', () => {
    const result = parseSpecQualityOutput({
      score: 3,
      findings: [{ dimension: 'goal_clarity', severity: 'error', comment: 'unclear' }],
      amendedSpec: 'fixed body',
    });
    expect(result?.score).toBe(3);
    expect(result?.findings[0]?.severity).toBe('error');
    expect(result?.amendedSpec).toBe('fixed body');
  });

  it('parses an explicit verdict and derives one when omitted', () => {
    expect(
      parseSpecQualityOutput(
        '```json\n{"verdict":"BLOCKING_AMBIGUITY","score":2,"findings":[]}\n```',
      )?.verdict,
    ).toBe('BLOCKING_AMBIGUITY');
    // Omitted verdict + an ERROR finding -> NEEDS_REVISION (a real gap to fix).
    expect(
      parseSpecQualityOutput(
        '```json\n{"score":5,"findings":[{"severity":"error","comment":"x"}]}\n```',
      )?.verdict,
    ).toBe('NEEDS_REVISION');
    // Omitted verdict + only warn (non-blocking) -> APPROVED; the loop must not chase it.
    expect(
      parseSpecQualityOutput(
        '```json\n{"score":7,"findings":[{"severity":"warn","comment":"x"}]}\n```',
      )?.verdict,
    ).toBe('APPROVED');
    // Omitted verdict + clean findings -> APPROVED.
    expect(parseSpecQualityOutput('```json\n{"score":9,"findings":[]}\n```')?.verdict).toBe(
      'APPROVED',
    );
  });
});

describe('parseCorrectorOutput', () => {
  it('returns null for empty / unparseable / non-stringy input', () => {
    expect(parseCorrectorOutput(null)).toBeNull();
    expect(parseCorrectorOutput('no fence here')).toBeNull();
    expect(parseCorrectorOutput(42)).toBeNull();
  });

  it('extracts amendedSpec from a fenced block', () => {
    const raw = [
      '```json',
      JSON.stringify({ amendedSpec: 'NEW BODY', accepted: ['a'] }),
      '```',
    ].join('\n');
    expect(parseCorrectorOutput(raw)?.amendedSpec).toBe('NEW BODY');
  });

  it('accepts an object payload directly', () => {
    expect(parseCorrectorOutput({ amendedSpec: 'X' })?.amendedSpec).toBe('X');
  });

  it('returns amendedSpec null when the key is absent', () => {
    expect(parseCorrectorOutput('```json\n{"accepted":[]}\n```')?.amendedSpec).toBeNull();
  });
});

describe('phase0b5SpecQualityStep.loop', () => {
  const loop = phase0b5SpecQualityStep.loop!;

  function reviewOutput(
    findings: Array<{ severity: 'info' | 'warn' | 'error' }>,
    verdict: 'APPROVED' | 'NEEDS_REVISION' | 'BLOCKING_AMBIGUITY' = 'NEEDS_REVISION',
    spec = 'irrelevant',
  ) {
    return {
      verdict,
      score: 5,
      findings: findings.map((f, i) => ({
        dimension: `dim_${i}`,
        severity: f.severity,
        comment: 'x',
      })),
      source: 'review' as const,
      spec,
    };
  }

  it('declares a default budget of 5 rounds at 2 passes per round', () => {
    expect(loop.maxIterations).toBe(5);
    expect(loop.passesPerRound).toBe(2);
  });

  it('resolveRole alternates reviewer (even) and corrector (odd)', () => {
    expect(loop.resolveRole!(0)).toBe('reviewer');
    expect(loop.resolveRole!(1)).toBe('corrector');
    expect(loop.resolveRole!(2)).toBe('reviewer');
    expect(loop.resolveRole!(3)).toBe('corrector');
  });

  it('after a review (even) continues only while the verdict is NEEDS_REVISION', async () => {
    const base = { ctx: {} as never, llmOutput: null, previousIterations: [] };
    expect(
      await loop.shouldContinue({
        ...base,
        iteration: 0,
        applyOutput: reviewOutput([{ severity: 'warn' }]),
      }),
    ).toBe(true);
    expect(
      await loop.shouldContinue({
        ...base,
        iteration: 2,
        applyOutput: reviewOutput([], 'APPROVED'),
      }),
    ).toBe(false);
    expect(
      await loop.shouldContinue({
        ...base,
        iteration: 2,
        applyOutput: reviewOutput([{ severity: 'error' }], 'BLOCKING_AMBIGUITY'),
      }),
    ).toBe(false);
  });

  it('after a correction (odd) always re-reviews regardless of the carried verdict', async () => {
    const base = { ctx: {} as never, llmOutput: null, previousIterations: [] };
    expect(
      await loop.shouldContinue({
        ...base,
        iteration: 1,
        applyOutput: {
          verdict: 'NEEDS_REVISION',
          score: 5,
          findings: [],
          source: 'correct' as const,
          spec: 'x',
        },
      }),
    ).toBe(true);
  });

  it('corrector prompt (odd) carries the latest review findings + the working spec', () => {
    const previousIterations: StepLoopPassRecord[] = [
      {
        iteration: 0,
        llmOutput: null,
        applyOutput: reviewOutput(
          [{ severity: 'error' }, { severity: 'warn' }],
          'NEEDS_REVISION',
          'WORKING BODY',
        ),
        continueRequested: true,
      },
    ];
    const prompt = loop.buildIterationPrompt!({
      detected: { spec: 'ORIGINAL', specSummary: '', specLength: 0, currentBudget: 3 },
      formValues: {},
      iteration: 1,
      previousIterations,
    });
    expect(prompt).toContain('CORRECTION phase');
    expect(prompt).toContain('blindly trust');
    expect(prompt).toContain('Findings from iteration 1');
    expect(prompt).toContain('[error]');
    expect(prompt).toContain('WORKING BODY');
  });

  it('reviewer prompt (even re-review) assesses the latest corrected spec, amending nothing', () => {
    const previousIterations: StepLoopPassRecord[] = [
      {
        iteration: 0,
        llmOutput: null,
        applyOutput: { ...reviewOutput([{ severity: 'warn' }]), spec: '' },
        continueRequested: true,
      },
      {
        iteration: 1,
        llmOutput: null,
        applyOutput: {
          verdict: 'NEEDS_REVISION',
          score: 5,
          findings: [],
          source: 'correct' as const,
          spec: 'CORRECTED BODY',
        },
        continueRequested: true,
      },
    ];
    const prompt = loop.buildIterationPrompt!({
      detected: { spec: 'ORIGINAL', specSummary: '', specLength: 0, currentBudget: 3 },
      formValues: {},
      iteration: 2,
      previousIterations,
    });
    expect(prompt).toContain('REVIEW phase');
    expect(prompt).toContain('CORRECTED BODY');
    expect(prompt).not.toContain('ORIGINAL');
  });

  it('buildIterationPrompt falls back to the original spec when no prior body is present', () => {
    const previousIterations: StepLoopPassRecord[] = [
      {
        iteration: 0,
        llmOutput: null,
        applyOutput: { ...reviewOutput([{ severity: 'warn' }]), spec: '' },
        continueRequested: true,
      },
    ];
    const prompt = loop.buildIterationPrompt!({
      detected: { spec: 'FALLBACK BODY', specSummary: '', specLength: 0, currentBudget: 3 },
      formValues: {},
      iteration: 1,
      previousIterations,
    });
    expect(prompt).toContain('FALLBACK BODY');
  });
});

describe('phase0b5SpecQualityStep.apply', () => {
  const fakeCtx = { logger: logger.child({ test: 'spec-quality' }) } as never;

  function reviewPass(
    score: number,
    verdict: 'APPROVED' | 'NEEDS_REVISION' | 'BLOCKING_AMBIGUITY' = 'NEEDS_REVISION',
    spec = 'PRIOR BODY',
  ) {
    return {
      verdict,
      score,
      findings: [{ dimension: 'd', severity: 'warn' as const, comment: 'x' }],
      source: 'review' as const,
      spec,
    };
  }
  function correctPass(spec: string, score = 5) {
    return {
      verdict: 'NEEDS_REVISION' as const,
      score,
      findings: [],
      source: 'correct' as const,
      spec,
    };
  }

  it('review pass: keeps the higher-ranked prior review when the current regresses', async () => {
    const previousIterations: StepLoopPassRecord[] = [
      {
        iteration: 0,
        llmOutput: null,
        applyOutput: reviewPass(8, 'NEEDS_REVISION', 'PRIOR BODY'),
        continueRequested: true,
      },
      {
        iteration: 1,
        llmOutput: null,
        applyOutput: correctPass('PRIOR BODY', 8),
        continueRequested: true,
      },
    ];
    const result = (await phase0b5SpecQualityStep.apply(fakeCtx, {
      detected: { spec: 'ORIGINAL', specSummary: '', specLength: 8, currentBudget: 5 },
      llmOutput: { verdict: 'NEEDS_REVISION', score: 4, findings: [] },
      formValues: {},
      iteration: 2,
      previousIterations,
    } as never)) as { verdict: string; score: number; spec: string; source: string };
    expect(result.source).toBe('review');
    expect(result.score).toBe(8);
    expect(result.spec).toBe('PRIOR BODY');
  });

  it('review pass: accepts the current review when it ranks higher (APPROVED beats NEEDS_REVISION)', async () => {
    const previousIterations: StepLoopPassRecord[] = [
      {
        iteration: 0,
        llmOutput: null,
        applyOutput: reviewPass(9, 'NEEDS_REVISION', 'WORKING'),
        continueRequested: true,
      },
      {
        iteration: 1,
        llmOutput: null,
        applyOutput: correctPass('WORKING', 9),
        continueRequested: true,
      },
    ];
    const result = (await phase0b5SpecQualityStep.apply(fakeCtx, {
      detected: { spec: 'ORIGINAL', specSummary: '', specLength: 8, currentBudget: 5 },
      llmOutput: { verdict: 'APPROVED', score: 6, findings: [] },
      formValues: {},
      iteration: 2,
      previousIterations,
    } as never)) as { verdict: string; spec: string };
    expect(result.verdict).toBe('APPROVED');
    // A review never amends; it approves the latest corrected working spec.
    expect(result.spec).toBe('WORKING');
  });

  it('review pass: stub + correct passes never win the guard, so a lower-scored real review wins', async () => {
    const stub = {
      verdict: 'NEEDS_REVISION' as const,
      score: 5,
      findings: [{ dimension: 'general', severity: 'info' as const, comment: 'stub' }],
      source: 'stub' as const,
      spec: 'ORIGINAL',
    };
    const previousIterations: StepLoopPassRecord[] = [
      { iteration: 0, llmOutput: null, applyOutput: stub, continueRequested: true },
      {
        iteration: 1,
        llmOutput: null,
        applyOutput: correctPass('CORRECTED', 5),
        continueRequested: true,
      },
    ];
    const result = (await phase0b5SpecQualityStep.apply(fakeCtx, {
      detected: { spec: 'ORIGINAL', specSummary: '', specLength: 8, currentBudget: 5 },
      llmOutput: {
        verdict: 'NEEDS_REVISION',
        score: 4,
        findings: [{ dimension: 'goal_clarity', severity: 'warn', comment: 'real' }],
      },
      formValues: {},
      iteration: 2,
      previousIterations,
    } as never)) as { score: number; spec: string; source: string; findings: unknown[] };
    expect(result.source).toBe('review');
    expect(result.score).toBe(4);
    expect(result.spec).toBe('CORRECTED');
    expect(result.findings).toHaveLength(1);
  });

  it('correct pass: produces the amended spec and carries the latest review verdict/score forward', async () => {
    const previousIterations: StepLoopPassRecord[] = [
      {
        iteration: 0,
        llmOutput: null,
        applyOutput: reviewPass(6, 'NEEDS_REVISION', 'ORIGINAL'),
        continueRequested: true,
      },
    ];
    const result = (await phase0b5SpecQualityStep.apply(fakeCtx, {
      detected: { spec: 'ORIGINAL', specSummary: '', specLength: 8, currentBudget: 5 },
      llmOutput: { amendedSpec: 'AMENDED BODY', accepted: ['x'], rejected: [] },
      formValues: {},
      iteration: 1,
      previousIterations,
    } as never)) as { verdict: string; score: number; spec: string; source: string };
    expect(result.source).toBe('correct');
    expect(result.spec).toBe('AMENDED BODY');
    expect(result.verdict).toBe('NEEDS_REVISION');
    expect(result.score).toBe(6);
  });

  it('correct pass: keeps the working spec when the corrector output is unparseable', async () => {
    const previousIterations: StepLoopPassRecord[] = [
      {
        iteration: 0,
        llmOutput: null,
        applyOutput: reviewPass(6, 'NEEDS_REVISION', 'WORKING'),
        continueRequested: true,
      },
    ];
    const result = (await phase0b5SpecQualityStep.apply(fakeCtx, {
      detected: { spec: 'ORIGINAL', specSummary: '', specLength: 8, currentBudget: 5 },
      llmOutput: 'no json here',
      formValues: {},
      iteration: 1,
      previousIterations,
    } as never)) as { spec: string; source: string };
    expect(result.source).toBe('correct');
    expect(result.spec).toBe('WORKING');
  });
});
