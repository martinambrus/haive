import { describe, it, expect } from 'vitest';
import { logger } from '@haive/shared';
import type { StepContext } from '../../step-definition.js';
import { RetryableParseError } from '../../step-definition.js';
import {
  phase0bPrePlanningStep,
  planIndexOmissionNotice,
  trimPlanIndexToWholeNodes,
} from './04-phase-0b-pre-planning.js';

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

// The plan component index is the dominant term in a planned run's spec prompt, so
// the bound has to actually bind. Depth alone cannot do it: depth 1 is the floor,
// and a plan that is merely WIDE is over budget at every depth — MEASURED on a
// 1,001-node flat plan, a 273,104-char depth-one index reached the prompt intact.
describe('trimPlanIndexToWholeNodes', () => {
  const node = (n: number) => `## Component ${n}\n\`node:${'0'.repeat(8)}-${n}\`\nbody line\n`;

  it('returns the input untouched when it already fits', () => {
    const text = node(1) + node(2);
    expect(trimPlanIndexToWholeNodes(text, 10_000)).toEqual({ text, omitted: 0 });
  });

  it('enforces the budget a wide plan blows through at every depth', () => {
    const wide = Array.from({ length: 500 }, (_, i) => node(i)).join('');
    const out = trimPlanIndexToWholeNodes(wide, 2_000);
    expect(out.text.length).toBeLessThanOrEqual(2_000);
    expect(out.omitted).toBeGreaterThan(0);
  });

  it('cuts on node boundaries, never mid-token — a half `node:<uuid>` would be quoted back as whole', () => {
    const wide = Array.from({ length: 200 }, (_, i) => node(i)).join('');
    const out = trimPlanIndexToWholeNodes(wide, 500);
    // Every ref that survived is a COMPLETE line, and no heading is left bodyless.
    for (const line of out.text.split('\n')) {
      if (line.startsWith('`node:')) expect(line.endsWith('`')).toBe(true);
    }
    expect(out.text.endsWith('body line') || out.text.endsWith('')).toBe(true);
  });

  it('counts every omitted node, so the prompt can state the omission', () => {
    const wide = Array.from({ length: 10 }, (_, i) => node(i)).join('');
    const kept = trimPlanIndexToWholeNodes(wide, wide.length / 2);
    expect(kept.omitted).toBeGreaterThan(0);
    expect(kept.omitted).toBeLessThan(10);
  });
});

// The notice is part of what reaches the prompt, so the reserve held back for it has
// to actually cover it — otherwise a full-width trim returns MORE than the cap the
// notice announces (measured: content trimmed to 119,999 came back 120,256).
describe('planIndexOmissionNotice', () => {
  it('fits the reserve at its longest — deepest reduction and a 6-digit omitted count', () => {
    const longest = planIndexOmissionNotice(1, 999_999);
    expect(longest.length).toBeLessThan(400);
  });

  it('states BOTH reductions when both happened', () => {
    const notice = planIndexOmissionNotice(1, 42);
    expect(notice).toContain('bounded to 1 level');
    expect(notice).toContain('42 further component(s) omitted');
  });

  it('names only the reduction that happened', () => {
    expect(planIndexOmissionNotice(3, 7)).not.toContain('bounded to');
    expect(planIndexOmissionNotice(1, 0)).not.toContain('omitted for size');
  });

  it('always warns against inventing an id for a component it could not list', () => {
    expect(planIndexOmissionNotice(1, 5)).toContain('do not invent an id');
  });

  it('trim plus notice stays inside the cap it announces', () => {
    const node = (n: number) => `## Component ${n}\n\`node:aaaaaaaa-${n}\`\nbody\n`;
    const wide = Array.from({ length: 4000 }, (_, i) => node(i)).join('');
    const { text, omitted } = trimPlanIndexToWholeNodes(wide, 120_000 - 400);
    expect(`${text}${planIndexOmissionNotice(1, omitted)}`.length).toBeLessThanOrEqual(120_000);
  });
});
