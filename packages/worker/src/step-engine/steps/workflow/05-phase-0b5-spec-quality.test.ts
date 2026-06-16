import { describe, it, expect } from 'vitest';
import {
  phase0b5SpecQualityStep,
  resolveReviewResult,
  parseSpecQualityOutput,
  type SpecQualityApply,
} from './05-phase-0b5-spec-quality.js';
import type { StepContext, StepApplyArgs, StepLoopPassRecord } from '../../step-definition.js';

const ctx = { logger: { info: () => {} } } as unknown as StepContext;

function review(over: Partial<SpecQualityApply>): SpecQualityApply {
  return {
    verdict: 'NEEDS_REVISION',
    score: 5,
    findings: [],
    source: 'review',
    spec: 'SPEC',
    ...over,
  };
}

function pass(applyOutput: SpecQualityApply): StepLoopPassRecord {
  return { iteration: 0, llmOutput: '', applyOutput, continueRequested: true };
}

describe('resolveReviewResult (regression guard)', () => {
  it('keeps a lower-scored re-review that surfaces a NEW error finding (no spec rollback)', () => {
    // Reproduces the live it6 bug: re-review of the corrected spec scored 6 with a new
    // error finding, but the prior review scored 7. The guard must NOT revert to the
    // prior (older, shorter) spec — the error finding must drive another correction.
    const current = review({
      score: 6,
      findings: [{ dimension: 'acceptance_criteria', severity: 'error', comment: 'AC4 fails' }],
      spec: 'CORRECTED SPEC (longer)',
    });
    const best = review({ score: 7, findings: [], spec: 'OLD SHORTER SPEC' });
    const result = resolveReviewResult(current, best);
    expect(result).toBe(current);
    expect(result.spec).toBe('CORRECTED SPEC (longer)');
    expect(result.score).toBe(6);
    expect(result.findings[0]?.severity).toBe('error');
  });

  it('borrows the prior verdict/score on a pure no-error wobble but keeps the corrected spec', () => {
    const current = review({
      verdict: 'NEEDS_REVISION',
      score: 5,
      findings: [{ dimension: 'documentation_updates', severity: 'warn', comment: 'minor' }],
      spec: 'CORRECTED SPEC',
    });
    const best = review({ verdict: 'APPROVED', score: 8, findings: [], spec: 'OLD SPEC' });
    const result = resolveReviewResult(current, best);
    expect(result.verdict).toBe('APPROVED');
    expect(result.score).toBe(8);
    // spec + findings stay the CURRENT ones — only verdict/score are borrowed.
    expect(result.spec).toBe('CORRECTED SPEC');
    expect(result.findings[0]?.severity).toBe('warn');
  });

  it('returns the current review unchanged when it already ranks at least as high', () => {
    const current = review({ verdict: 'APPROVED', score: 9, spec: 'CURRENT' });
    const best = review({ verdict: 'NEEDS_REVISION', score: 7, spec: 'OLD' });
    expect(resolveReviewResult(current, best)).toBe(current);
  });

  it('never lets a BLOCKING_AMBIGUITY be overridden by a prior APPROVED', () => {
    const current = review({
      verdict: 'BLOCKING_AMBIGUITY',
      score: 3,
      findings: [],
      spec: 'CURRENT',
    });
    const best = review({ verdict: 'APPROVED', score: 9, spec: 'OLD' });
    const result = resolveReviewResult(current, best);
    expect(result).toBe(current);
    expect(result.verdict).toBe('BLOCKING_AMBIGUITY');
  });

  it('returns current when there is no prior review', () => {
    const current = review({ score: 4 });
    expect(resolveReviewResult(current, null)).toBe(current);
  });
});

describe('parseSpecQualityOutput', () => {
  it('parses a valid JSON review', () => {
    const raw =
      '```json\n{"verdict":"NEEDS_REVISION","score":6,"findings":[{"dimension":"x","severity":"error","comment":"c"}]}\n```';
    const parsed = parseSpecQualityOutput(raw);
    expect(parsed?.verdict).toBe('NEEDS_REVISION');
    expect(parsed?.score).toBe(6);
    expect(parsed?.findings).toHaveLength(1);
  });

  it('returns null for a YAML review (the real stub trigger)', () => {
    // The live reviewer emitted YAML like this twice; it has no JSON object to parse.
    const yaml = [
      'severity: warn',
      'dimension: Stability',
      'required_revisions:',
      '  - fix it',
    ].join('\n');
    expect(parseSpecQualityOutput(yaml)).toBeNull();
  });
});

describe('apply review pass (stub on parse failure)', () => {
  it('yields source=stub with EMPTY findings so the corrector is not poisoned', async () => {
    const detected = { specSummary: '', spec: 'SPEC BODY', specLength: 9, currentBudget: 5 };
    const args = {
      detected,
      formValues: {},
      llmOutput: 'not json at all\nseverity: warn',
      iteration: 0,
      previousIterations: [],
    } as unknown as StepApplyArgs<typeof detected>;
    const out = (await phase0b5SpecQualityStep.apply(ctx, args)) as SpecQualityApply;
    expect(out.source).toBe('stub');
    expect(out.findings).toHaveLength(0);
    expect(out.verdict).toBe('NEEDS_REVISION');
    expect(out.spec).toBe('SPEC BODY');
  });
});

describe('corrector prompt (review-to-corrector handoff)', () => {
  const detected = { specSummary: '', spec: 'ORIG SPEC', specLength: 9, currentBudget: 5 };
  const buildIterationPrompt = phase0b5SpecQualityStep.loop!.buildIterationPrompt!;

  it('falls back to self-review when the preceding review was a lost stub', () => {
    const prompt = buildIterationPrompt({
      detected,
      formValues: { focusAreas: '' },
      iteration: 1, // odd = corrector
      previousIterations: [pass(review({ source: 'stub', findings: [], spec: 'S' }))],
    });
    expect(prompt).toContain('No usable reviewer findings this round');
    expect(prompt).not.toContain('=== Findings from iteration');
  });

  it('passes the real review findings to the corrector when the review parsed', () => {
    const prompt = buildIterationPrompt({
      detected,
      formValues: { focusAreas: '' },
      iteration: 1,
      previousIterations: [
        pass(
          review({
            source: 'review',
            score: 6,
            findings: [
              { dimension: 'acceptance_criteria', severity: 'error', comment: 'AC4 fails' },
            ],
            spec: 'S',
          }),
        ),
      ],
    });
    expect(prompt).toContain('=== Findings from iteration 1 ===');
    expect(prompt).toContain('[error] acceptance_criteria: AC4 fails');
    expect(prompt).not.toContain('No usable reviewer findings');
  });
});

describe('REVIEW prompt hardening', () => {
  it('re-review prompt forbids YAML and demands a single JSON object', () => {
    const prompt = phase0b5SpecQualityStep.loop!.buildIterationPrompt!({
      detected: { specSummary: '', spec: 'SPEC', specLength: 4, currentBudget: 5 },
      formValues: { focusAreas: '' },
      iteration: 2, // even = reviewer
      previousIterations: [],
    });
    expect(prompt).toContain('reply with a SINGLE JSON object');
    expect(prompt).toContain('YAML');
  });
});
