import { describe, it, expect } from 'vitest';
import { planMergeStep } from './01-plan-merge.js';
import type { FormSchema } from '@haive/shared';
import type { StepContext } from '../../step-definition.js';

type Detect = Parameters<NonNullable<typeof planMergeStep.form>>[1];

function detect(over: Partial<Detect> = {}): Detect {
  return {
    repositoryId: 'r1',
    branch: 'main',
    worktreePath: '/repo/.haive/worktrees/plan-merge',
    worktreeRelPath: '.haive/worktrees/plan-merge',
    attempts: 0,
    conflicts: [],
    unrelated: false,
    transcript: [],
    pendingGuidance: null,
    mergeOpen: false,
    ...over,
  } as Detect;
}

const formOf = (d: Detect): FormSchema | null =>
  planMergeStep.form!({} as unknown as StepContext, d, undefined);
const skips = (d: Detect): boolean =>
  planMergeStep.llm!.skipIf!({ detected: d, formValues: {}, iteration: 0 });

/**
 * The invariant that keeps one turn to two passes: the pass that runs the agent must
 * not also park, and the pass that parks must not also run the agent. Same shape as
 * plan-chat-passes.test.ts, for the same reason — the engine runs form() before the
 * LLM, so a step that gets this wrong either answers a turn late or never parks.
 */
describe('plan merge: form and llm.skipIf are exact complements', () => {
  const cases: Detect[] = [
    detect(),
    detect({ conflicts: ['README.md'] }),
    detect({ conflicts: ['README.md'], attempts: 3 }),
    detect({ conflicts: ['README.md'], attempts: 4 }),
    detect({ conflicts: ['README.md'], attempts: 9 }),
    detect({ attempts: 4 }),
    detect({ repositoryId: null }),
  ];
  it.each(cases)('offers a form exactly when the agent is skipped (%#)', (d) => {
    if (!d.repositoryId) {
      // No repository is the one case with neither: nothing to merge and nothing to ask.
      expect(formOf(d)).toBeNull();
      return;
    }
    expect(formOf(d) !== null).toBe(skips(d));
  });
});

describe('plan merge: the agent budget', () => {
  it('runs the agent while conflicts remain and the budget holds', () => {
    const d = detect({ conflicts: ['README.md'], attempts: 3 });
    expect(skips(d)).toBe(false);
    expect(formOf(d)).toBeNull();
  });

  it('stops asking the agent once the budget is spent, and parks instead', () => {
    // The bug this pins: without a cap, a resolver that cannot resolve re-entered
    // forever — MEASURED at 17 invocations and 12 identical "Still unresolved" turns
    // on a single README before the budget existed.
    const d = detect({ conflicts: ['README.md'], attempts: 4 });
    expect(skips(d)).toBe(true);
    const form = formOf(d);
    expect(form).not.toBeNull();
    expect(form!.title).toMatch(/could not finish/i);
  });

  it('withholds Confirm while anything is still unmerged', () => {
    // Confirming a conflicted merge would commit the markers into the branch.
    const form = formOf(detect({ conflicts: ['README.md'], attempts: 4 }))!;
    const decision = form.fields.find((f) => f.id === 'decision')!;
    const values = (decision as { options?: { value: string }[] }).options?.map((o) => o.value);
    expect(values).toEqual(['revise']);
  });

  it('offers Confirm once the tree is clean', () => {
    const form = formOf(detect())!;
    const decision = form.fields.find((f) => f.id === 'decision')!;
    const values = (decision as { options?: { value: string }[] }).options?.map((o) => o.value);
    expect(values).toEqual(['confirm', 'revise']);
  });

  it('refills the budget when the user says something new', () => {
    // `attempts` counts assistant turns SINCE the last user message, so guidance buys
    // another round — the same rule merge-resolver applies to a guided retry.
    const d = detect({ conflicts: ['README.md'], attempts: 0, pendingGuidance: 'keep both' });
    expect(skips(d)).toBe(false);
  });
});
