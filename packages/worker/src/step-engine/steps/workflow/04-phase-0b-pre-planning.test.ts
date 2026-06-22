import { describe, it, expect } from 'vitest';
import { logger } from '@haive/shared';
import type { StepContext } from '../../step-definition.js';
import { RetryableParseError } from '../../step-definition.js';
import { phase0bPrePlanningStep } from './04-phase-0b-pre-planning.js';

const base = {
  taskTitle: 'Add a logout button',
  taskDescription: 'Users need to log out.',
  discoverySummary: 'auth lives in middleware',
  businessRequirements: '',
  relevantKbIds: [] as string[],
  kbReferences: [] as { id: string; title: string; exists: boolean }[],
  priorRejectionFeedback: '',
};
const ctx = {} as unknown as StepContext;

describe('04 pre-planning revise (gate-1 reject → re-draft)', () => {
  it('auto-submits with the pre-filled feedback when revising', () => {
    const schema = phase0bPrePlanningStep.form!(ctx, {
      ...base,
      priorRejectionFeedback: 'add an error-handling section',
    });
    expect(schema!.autoSubmit).toBe(true);
    const scope = schema!.fields.find((f) => f.id === 'scope') as {
      default?: string;
      label?: string;
    };
    expect(scope.default).toBe('add an error-handling section');
    expect(scope.label).toMatch(/revision feedback/i);
  });

  it('does not auto-submit on the first run', () => {
    const schema = phase0bPrePlanningStep.form!(ctx, base);
    expect(schema!.autoSubmit).toBeUndefined();
  });

  it('frames the feedback as reviewer feedback in the revise prompt', () => {
    const prompt = phase0bPrePlanningStep.llm!.buildPrompt({
      detected: { ...base, priorRejectionFeedback: 'tighten the acceptance criteria' },
      formValues: { scope: 'tighten the acceptance criteria' },
    });
    expect(prompt).toContain('Reviewer feedback to address in this revised spec');
    expect(prompt).toContain('tighten the acceptance criteria');
    expect(prompt).not.toContain('Scope guidance:');
  });

  it('uses the scope-guidance framing on the first run', () => {
    const prompt = phase0bPrePlanningStep.llm!.buildPrompt({
      detected: base,
      formValues: { scope: 'no DB changes' },
    });
    expect(prompt).toContain('Scope guidance: no DB changes');
    expect(prompt).not.toContain('Reviewer feedback to address');
  });
});

describe('04 pre-planning retry-then-degrade', () => {
  const applyCtx = { logger: logger.child({ test: '04-apply' }) } as unknown as StepContext;
  function runApply(llmOutput: unknown, isFinalLlmAttempt: boolean) {
    return phase0bPrePlanningStep.apply(applyCtx, {
      detected: base,
      formValues: {},
      llmOutput,
      iteration: 0,
      previousIterations: [],
      isFinalLlmAttempt,
    } as unknown as Parameters<typeof phase0bPrePlanningStep.apply>[1]);
  }

  it('throws RetryableParseError on unparseable output when NOT the final attempt', async () => {
    await expect(runApply('just prose, no json at all', false)).rejects.toBeInstanceOf(
      RetryableParseError,
    );
  });

  it('degrades to a stub spec (no throw) on the final attempt', async () => {
    const out = await runApply('just prose, no json at all', true);
    expect(out.source).toBe('stub');
    expect(out.spec.length).toBeGreaterThan(0);
  });

  it('returns the parsed spec when output is valid (never retries)', async () => {
    const raw = '```json\n{"summary":"s","spec":"# Spec\\n\\nbody"}\n```';
    const out = await runApply(raw, false);
    expect(out.source).toBe('llm');
    expect(out.spec).toContain('# Spec');
  });
});
