import { describe, expect, it } from 'vitest';
import { logger } from '@haive/shared';
import {
  parseSpecQualityOutput,
  phase0b5SpecQualityStep,
} from '../src/step-engine/steps/workflow/05-phase-0b5-spec-quality.js';
import type { StepLoopPassRecord } from '../src/step-engine/step-definition.js';

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
    // Omitted verdict + a warn/error finding -> NEEDS_REVISION.
    expect(
      parseSpecQualityOutput(
        '```json\n{"score":5,"findings":[{"severity":"warn","comment":"x"}]}\n```',
      )?.verdict,
    ).toBe('NEEDS_REVISION');
    // Omitted verdict + clean findings -> APPROVED.
    expect(parseSpecQualityOutput('```json\n{"score":9,"findings":[]}\n```')?.verdict).toBe(
      'APPROVED',
    );
  });
});

describe('phase0b5SpecQualityStep.loop', () => {
  // Loop hook lives directly on the step definition; assertions below
  // exercise it with synthetic apply outputs that mirror what the runner
  // would produce in real execution.
  const loop = phase0b5SpecQualityStep.loop!;

  function applyOutput(
    findings: Array<{ severity: 'info' | 'warn' | 'error' }>,
    verdict: 'APPROVED' | 'NEEDS_REVISION' | 'BLOCKING_AMBIGUITY' = 'NEEDS_REVISION',
  ) {
    return {
      verdict,
      score: 5,
      findings: findings.map((f, i) => ({
        dimension: `dim_${i}`,
        severity: f.severity,
        comment: 'x',
      })),
      source: 'llm' as const,
      spec: 'irrelevant',
    };
  }

  it('declares maxIterations default of 10', () => {
    expect(loop.maxIterations).toBe(10);
  });

  it('shouldContinue continues only while the verdict is NEEDS_REVISION', async () => {
    const args = {
      ctx: {} as never,
      llmOutput: null,
      iteration: 0,
      previousIterations: [],
    };
    expect(
      await loop.shouldContinue({
        ...args,
        applyOutput: applyOutput([{ severity: 'warn' }], 'NEEDS_REVISION'),
      }),
    ).toBe(true);
  });

  it('shouldContinue stops on APPROVED and BLOCKING_AMBIGUITY', async () => {
    const args = {
      ctx: {} as never,
      llmOutput: null,
      iteration: 1,
      previousIterations: [],
    };
    expect(await loop.shouldContinue({ ...args, applyOutput: applyOutput([], 'APPROVED') })).toBe(
      false,
    );
    expect(
      await loop.shouldContinue({
        ...args,
        applyOutput: applyOutput([{ severity: 'error' }], 'BLOCKING_AMBIGUITY'),
      }),
    ).toBe(false);
  });

  it('buildIterationPrompt includes the latest amended spec from prior iterations', () => {
    const previousIterations: StepLoopPassRecord[] = [
      {
        iteration: 0,
        llmOutput: null,
        applyOutput: { ...applyOutput([{ severity: 'warn' }]), spec: 'AMENDED V1 BODY' },
        continueRequested: true,
      },
    ];
    const prompt = loop.buildIterationPrompt!({
      detected: { spec: 'ORIGINAL', specSummary: '', specLength: 0, currentBudget: 3 },
      formValues: {},
      iteration: 1,
      previousIterations,
    });
    // The amended body from iteration 0 should win over the original spec
    expect(prompt).toContain('AMENDED V1 BODY');
    expect(prompt).not.toContain('ORIGINAL');
    expect(prompt).toContain('iteration 2');
  });

  it('buildIterationPrompt surfaces prior findings as bullets in the prompt', () => {
    const previousIterations: StepLoopPassRecord[] = [
      {
        iteration: 0,
        llmOutput: null,
        applyOutput: {
          ...applyOutput([{ severity: 'error' }, { severity: 'warn' }]),
          spec: 'body',
        },
        continueRequested: true,
      },
    ];
    const prompt = loop.buildIterationPrompt!({
      detected: { spec: 'body', specSummary: '', specLength: 0, currentBudget: 3 },
      formValues: {},
      iteration: 1,
      previousIterations,
    });
    expect(prompt).toContain('Findings from iteration 1');
    expect(prompt).toContain('[error]');
    expect(prompt).toContain('[warn]');
  });

  it('buildIterationPrompt falls back to the original spec when no prior amend is present', () => {
    const previousIterations: StepLoopPassRecord[] = [
      {
        iteration: 0,
        llmOutput: null,
        // applyOutput.spec is empty so latestSpec walks back to detected.spec
        applyOutput: { ...applyOutput([{ severity: 'warn' }]), spec: '' },
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

describe('phase0b5SpecQualityStep.apply regression guard', () => {
  const fakeCtx = { logger: logger.child({ test: 'spec-quality' }) } as never;

  it('keeps the higher-ranked prior iteration when the current pass regresses', async () => {
    const prior = {
      verdict: 'NEEDS_REVISION' as const,
      score: 8,
      findings: [{ dimension: 'd', severity: 'warn' as const, comment: 'x' }],
      source: 'llm' as const,
      spec: 'PRIOR BODY',
    };
    const previousIterations: StepLoopPassRecord[] = [
      { iteration: 0, llmOutput: null, applyOutput: prior, continueRequested: true },
    ];
    const result = (await phase0b5SpecQualityStep.apply(fakeCtx, {
      detected: { spec: 'ORIGINAL', specSummary: '', specLength: 8, currentBudget: 3 },
      llmOutput: { verdict: 'NEEDS_REVISION', score: 4, findings: [] },
      formValues: {},
      iteration: 1,
      previousIterations,
    } as never)) as { verdict: string; score: number; spec: string };
    expect(result.score).toBe(8);
    expect(result.spec).toBe('PRIOR BODY');
  });

  it('accepts the current pass when it ranks higher (APPROVED beats a NEEDS_REVISION prior)', async () => {
    const prior = {
      verdict: 'NEEDS_REVISION' as const,
      score: 9,
      findings: [],
      source: 'llm' as const,
      spec: 'PRIOR',
    };
    const previousIterations: StepLoopPassRecord[] = [
      { iteration: 0, llmOutput: null, applyOutput: prior, continueRequested: true },
    ];
    const result = (await phase0b5SpecQualityStep.apply(fakeCtx, {
      detected: { spec: 'ORIGINAL', specSummary: '', specLength: 8, currentBudget: 3 },
      llmOutput: { verdict: 'APPROVED', score: 6, findings: [], amendedSpec: 'NEW BODY' },
      formValues: {},
      iteration: 1,
      previousIterations,
    } as never)) as { verdict: string; score: number; spec: string };
    expect(result.verdict).toBe('APPROVED');
    expect(result.spec).toBe('NEW BODY');
  });

  it('discards stub iterations so a lower-scored real review still wins (regression)', async () => {
    // The task behind the fenced-JSON fix accumulated stub iterations (parse
    // failures) at the stub's fixed score 5. Once parsing worked, the real review
    // scored 4 (NEEDS_REVISION); the guard must not resurrect a stub over it, or the
    // loop stays frozen on "1 info finding, no amendment" until the budget is spent.
    const stub = {
      verdict: 'NEEDS_REVISION' as const,
      score: 5,
      findings: [{ dimension: 'general', severity: 'info' as const, comment: 'stub' }],
      source: 'stub' as const,
      spec: 'ORIGINAL',
    };
    const previousIterations: StepLoopPassRecord[] = Array.from({ length: 3 }, (_, i) => ({
      iteration: i,
      llmOutput: null,
      applyOutput: stub,
      continueRequested: true,
    }));
    const result = (await phase0b5SpecQualityStep.apply(fakeCtx, {
      detected: { spec: 'ORIGINAL', specSummary: '', specLength: 8, currentBudget: 5 },
      llmOutput: {
        verdict: 'NEEDS_REVISION',
        score: 4,
        findings: [{ dimension: 'goal_clarity', severity: 'warn', comment: 'real' }],
        amendedSpec: 'AMENDED',
      },
      formValues: {},
      iteration: 3,
      previousIterations,
    } as never)) as { score: number; spec: string; source: string; findings: unknown[] };
    expect(result.source).toBe('llm');
    expect(result.score).toBe(4);
    expect(result.spec).toBe('AMENDED');
    expect(result.findings).toHaveLength(1);
  });
});
