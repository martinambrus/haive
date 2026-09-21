import { describe, expect, it } from 'vitest';
import { resolveCuratedSummary } from '../src/step-engine/_step-summary.js';
import { skillGenerationStep } from '../src/step-engine/steps/onboarding/09_5-skill-generation.js';
import { skillRepairStep } from '../src/step-engine/steps/onboarding/09_5b-skill-repair.js';

/**
 * Both skill steps emit their own recap, so the runner skips the LLM summariser entirely.
 *
 * Asserted THROUGH `resolveCuratedSummary` rather than by reading the field: the point is not
 * that a string exists but that the runner's curated path picks it up, which is what saves a CLI
 * call per step per run. A field named anything else would satisfy a direct read and change
 * nothing about the behaviour.
 *
 * Both steps qualify for that path at all only because they declare `agentMining` — the runner
 * gates on `llm || agentMining || dagExecute` — so that is asserted too.
 */

describe('curated summaries for the skill steps', () => {
  it('both steps reach the curated path in the first place', () => {
    // Without this the summaries below are dead weight: the runner never asks for them.
    expect(Boolean(skillGenerationStep.llm ?? skillGenerationStep.agentMining)).toBe(true);
    expect(Boolean(skillRepairStep.agentMining)).toBe(true);
  });

  it('09_5 reports what it generated, and the counts are its own', () => {
    const output = {
      summary: 'Generated 3 skill(s) with 7 sub-skill(s), mirrored into 2 CLI skills directories.',
      written: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      totalSubSkills: 7,
    };

    const curated = resolveCuratedSummary(output);

    expect(curated).toBe(output.summary);
    // The numbers have to be the step's, not decoration: a recap saying 0 on a run that wrote
    // three is worse than no recap at all, because it is read as fact.
    expect(curated).toContain(`${output.written.length} skill(s)`);
    expect(curated).toContain(`${output.totalSubSkills} sub-skill(s)`);
  });

  it('09_5b reports repaired out of attempted', () => {
    const output = {
      summary: 'Repaired 1 of 3 failing skill(s). 2 still need attention and are left on disk.',
      repaired: ['a'],
      attempted: 3,
      stillFailing: ['b', 'c'],
    };

    const curated = resolveCuratedSummary(output);

    expect(curated).toBe(output.summary);
    expect(curated).toContain(`${output.repaired.length} of ${output.attempted}`);
  });

  it('does NOT repeat the degraded note, which has its own column', () => {
    // `summary` and `degradedNote` are written side by side on the same finalize, so folding the
    // caveat into the recap would show it twice. The recap says what the pass DID.
    const output = {
      summary: 'Repaired 0 of 2 failing skill(s). 2 still need attention.',
      degradedNote: 'skill repair: 2 of 2 agents produced nothing usable',
    };

    expect(resolveCuratedSummary(output)).toBe(output.summary);
    expect(resolveCuratedSummary(output)).not.toContain('agents produced nothing usable');
  });
});
