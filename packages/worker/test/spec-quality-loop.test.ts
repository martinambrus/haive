import { describe, expect, it } from 'vitest';
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
});

describe('phase0b5SpecQualityStep.loop', () => {
  // Loop hook lives directly on the step definition; assertions below
  // exercise it with synthetic apply outputs that mirror what the runner
  // would produce in real execution.
  const loop = phase0b5SpecQualityStep.loop!;

  function applyOutput(findings: Array<{ severity: 'info' | 'warn' | 'error' }>) {
    return {
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

  it('shouldContinue returns true when ANY finding is warn or error', async () => {
    const args = {
      ctx: {} as never,
      llmOutput: null,
      iteration: 0,
      previousIterations: [],
    };
    expect(
      await loop.shouldContinue({ ...args, applyOutput: applyOutput([{ severity: 'warn' }]) }),
    ).toBe(true);
    expect(
      await loop.shouldContinue({ ...args, applyOutput: applyOutput([{ severity: 'error' }]) }),
    ).toBe(true);
    expect(
      await loop.shouldContinue({
        ...args,
        applyOutput: applyOutput([
          { severity: 'info' },
          { severity: 'warn' },
          { severity: 'info' },
        ]),
      }),
    ).toBe(true);
  });

  it('shouldContinue returns false when only info findings (or none) remain', async () => {
    const args = {
      ctx: {} as never,
      llmOutput: null,
      iteration: 1,
      previousIterations: [],
    };
    expect(await loop.shouldContinue({ ...args, applyOutput: applyOutput([]) })).toBe(false);
    expect(
      await loop.shouldContinue({
        ...args,
        applyOutput: applyOutput([{ severity: 'info' }, { severity: 'info' }]),
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
