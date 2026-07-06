import { describe, expect, it } from 'vitest';
import { logger } from '@haive/shared';
import {
  deriveRequiredDomains,
  skillGenerationStep,
} from '../src/step-engine/steps/onboarding/09_5-skill-generation.js';
import type { KbFileSummary } from '../src/step-engine/steps/onboarding/09-qa.js';
import type { StepContext } from '../src/step-engine/step-definition.js';

function kb(relPath: string, title: string, sectionHeadings: string[]): KbFileSummary {
  return {
    id: relPath.replace(/\.md$/, ''),
    title,
    relPath: `.claude/knowledge_base/${relPath}`,
    sectionHeadings,
  };
}

describe('deriveRequiredDomains', () => {
  it('extracts business capabilities from BUSINESS_LOGIC.md H2 sections', () => {
    const files = [
      kb('ARCHITECTURE.md', 'Architecture', ['Bootstrap', 'Entry Points']),
      kb('BUSINESS_LOGIC.md', 'Business Logic', [
        'Overview',
        'Rank-Based Access Control',
        'Forms Wizard',
        'SEF URL Aliases',
        'Dynamic Module Assignment',
      ]),
    ];
    expect(deriveRequiredDomains(files)).toEqual([
      'Rank-Based Access Control',
      'Forms Wizard',
      'SEF URL Aliases',
      'Dynamic Module Assignment',
    ]);
  });

  it('drops scaffolding sections and de-dupes case-insensitively', () => {
    const files = [
      kb('BUSINESS_LOGIC.md', 'Business Logic', [
        'Index',
        'Payments',
        'payments',
        'Summary',
        'Notes',
        'Source files',
      ]),
    ];
    expect(deriveRequiredDomains(files)).toEqual(['Payments']);
  });

  it('returns [] when no BUSINESS_LOGIC.md exists', () => {
    expect(deriveRequiredDomains([kb('ARCHITECTURE.md', 'Architecture', ['X'])])).toEqual([]);
    expect(deriveRequiredDomains([])).toEqual([]);
  });
});

describe('skill-generation chunked loop apply', () => {
  const fakeCtx = {
    repoPath: '/tmp/haive-skill-floor',
    logger: logger.child({ test: 'skill-floor' }),
    db: undefined as never,
  } as unknown as StepContext;

  const detected = {
    framework: 'general',
    language: 'php',
    kbFiles: [],
    requiredDomains: ['Access Control', 'Forms', 'Modules'],
    skillTargetDirs: ['.claude/skills'],
    bundleSkills: [],
  };

  const goodSkill = {
    id: 'only-one',
    title: 'Only One',
    description: 'd',
    overview: 'o',
    subSkills: [
      {
        slug: 'a',
        name: 'only-one-a',
        title: 'A',
        description: 'd',
        summary: 's',
        body: '## Purpose\n\nx',
      },
    ],
  };

  // A previousIterations entry carrying a cumulative apply output. consecutiveEmpty
  // is set high so the next dry pass is past the give-up threshold regardless of
  // the (internal) MAX_EMPTY_PASSES constant.
  function priorPass(applyOutput: Record<string, unknown>) {
    return { iteration: 0, llmOutput: null, applyOutput, continueRequested: true };
  }

  function callApply(over: Record<string, unknown>) {
    return skillGenerationStep.apply(fakeCtx, {
      detected,
      formValues: {},
      iteration: 0,
      previousIterations: [],
      isFinalLlmAttempt: true,
      ...over,
    } as unknown as Parameters<typeof skillGenerationStep.apply>[1]);
  }

  it('a single bounded pass writes one skill and returns it cumulatively (no throw)', async () => {
    const out = await callApply({ llmOutput: { skills: [goodSkill] } });
    expect(out.written.map((w) => w.id)).toEqual(['only-one']);
    expect(out.llmSkillCount).toBe(1);
    expect(out.lastBatchCount).toBe(1);
    expect(out.mode).toBe('deterministic');
  });

  it('throws (retriable) when the loop gives up below the >=3-capability coverage floor', async () => {
    // A dry pass that pushes consecutiveEmpty past the give-up threshold while only
    // one of three capabilities is covered must surface for failure.
    const prior = {
      written: [
        {
          id: 'only-one',
          title: 'Only One',
          description: 'd',
          filePath: '',
          mirroredDirs: ['.claude/skills'],
          subSkillCount: 1,
        },
      ],
      totalSubSkills: 1,
      droppedFromCap: 0,
      rejectedIds: [],
      droppedForSubSkills: [],
      maxSkills: 15,
      mode: 'deterministic',
      targetCount: 3,
      lastBatchCount: 0,
      llmSkillCount: 1,
      consecutiveEmpty: 5,
    };
    await expect(
      callApply({
        llmOutput: 'no skill json here',
        iteration: 2,
        previousIterations: [priorPass(prior)],
      }),
    ).rejects.toThrow(/business capabilities/);
  });

  it('throws when nothing usable is produced after repeated empty passes', async () => {
    const prior = {
      written: [],
      totalSubSkills: 0,
      droppedFromCap: 0,
      rejectedIds: [],
      droppedForSubSkills: [],
      maxSkills: 15,
      mode: 'discovery',
      targetCount: 0,
      lastBatchCount: 0,
      llmSkillCount: 0,
      consecutiveEmpty: 5,
    };
    await expect(
      callApply({
        detected: { ...detected, requiredDomains: [], bundleSkills: [] },
        llmOutput: '```json\n{"skills":["not an object"]}\n```',
        iteration: 2,
        previousIterations: [priorPass(prior)],
      }),
    ).rejects.toThrow(/no skills/);
  });
});

describe('skill-generation truncation shrink', () => {
  const detected = {
    framework: 'general',
    language: 'php',
    kbFiles: [],
    requiredDomains: ['A', 'B', 'C'],
    skillTargetDirs: ['.claude/skills'],
    bundleSkills: [],
    __fileTree: '(tree)',
  };
  function iterPrompt(truncationRetries: number): string {
    return skillGenerationStep.loop!.buildIterationPrompt!({
      detected,
      formValues: {},
      iteration: 1,
      previousIterations: [],
      truncationRetries,
    });
  }

  it('normal pass requests up to 8 sub-skills with 100-250 line bodies', () => {
    const p = iterPrompt(0);
    expect(p).toMatch(/at most 8/);
    expect(p).toMatch(/100-250 lines/);
    expect(p).not.toMatch(/previous attempt was cut off/i);
  });

  it('shrinks the request after an output-truncation retry', () => {
    const p = iterPrompt(1);
    expect(p).toMatch(/previous attempt was cut off/i);
    expect(p).toMatch(/at most 6/);
    expect(p).toMatch(/80-150/);
    expect(p).not.toMatch(/at most 8/);
  });

  it('shrinks further on repeated truncation, flooring at 3 sub-skills', () => {
    expect(iterPrompt(2)).toMatch(/at most 4/);
    expect(iterPrompt(3)).toMatch(/at most 3/);
  });

  it('does not inline capability sections in the sequential loop path (no pinned capability)', () => {
    const p = skillGenerationStep.loop!.buildIterationPrompt!({
      detected: { ...detected, __capabilitySections: { A: 'Alpha body text' } },
      formValues: {},
      iteration: 1,
      previousIterations: [],
      truncationRetries: 0,
    });
    expect(p).not.toContain('Domain knowledge for');
    expect(p).not.toContain('Alpha body text');
    expect(p).toContain('Use the knowledge base above');
  });
});

describe('skill-generation parallel deterministic', () => {
  const fakeCtx = {
    repoPath: '/tmp/haive-skill-parallel',
    logger: logger.child({ test: 'skill-parallel' }),
    db: undefined as never,
  } as unknown as StepContext;

  const base = {
    framework: 'general',
    language: 'php',
    kbFiles: [],
    skillTargetDirs: ['.claude/skills'],
    bundleSkills: [],
    __fileTree: '(tree)',
  };
  const det = (domains: string[]) => ({ ...base, requiredDomains: domains });

  function mkSkill(id: string) {
    return {
      id,
      title: id,
      description: 'd',
      overview: 'o',
      subSkills: [
        {
          slug: `${id}-s`,
          name: `${id}-s`,
          title: 'S',
          description: 'd',
          summary: 's',
          body: '## Purpose\n\nx',
        },
      ],
    };
  }
  function miningResult(agentId: string, skillId: string) {
    return {
      agentId,
      agentTitle: skillId,
      status: 'done' as const,
      output: { skills: [mkSkill(skillId)] },
      rawOutput: null,
      errorMessage: null,
    };
  }
  function apply(over: Record<string, unknown>) {
    return skillGenerationStep.apply(fakeCtx, {
      detected: det(['Access Control', 'Forms', 'Modules']),
      formValues: {},
      iteration: 0,
      previousIterations: [],
      isFinalLlmAttempt: true,
      ...over,
    } as unknown as Parameters<typeof skillGenerationStep.apply>[1]);
  }
  function withBypass<T>(value: string | undefined, fn: () => T): T {
    const prev = process.env.HAIVE_TEST_BYPASS_LLM;
    if (value === undefined) delete process.env.HAIVE_TEST_BYPASS_LLM;
    else process.env.HAIVE_TEST_BYPASS_LLM = value;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.HAIVE_TEST_BYPASS_LLM;
      else process.env.HAIVE_TEST_BYPASS_LLM = prev;
    }
  }

  it('iteration 0 ingests the parallel agentMining batch and writes every skill', async () => {
    const out = await apply({
      agentMiningResults: [
        miningResult('cap-0-a', 'alpha'),
        miningResult('cap-1-b', 'beta'),
        miningResult('cap-2-c', 'gamma'),
      ],
    });
    expect(out.written.map((w) => w.id).sort()).toEqual(['alpha', 'beta', 'gamma']);
    expect(out.llmSkillCount).toBe(3);
    expect(out.lastBatchCount).toBe(3);
    expect(out.mode).toBe('deterministic');
    const cont = await skillGenerationStep.loop!.shouldContinue!({
      ctx: fakeCtx,
      applyOutput: out,
      llmOutput: undefined,
      iteration: 0,
      previousIterations: [],
    });
    expect(cont).toBe(false); // full coverage -> loop stops immediately
  });

  it('iteration > 0 gap-fill adds only the new skill (cached mining ignored, no double-write)', async () => {
    const prior = {
      written: ['alpha', 'beta', 'gamma'].map((id) => ({
        id,
        title: id,
        description: 'd',
        filePath: '',
        mirroredDirs: ['.claude/skills'],
        subSkillCount: 1,
      })),
      totalSubSkills: 3,
      droppedFromCap: 0,
      rejectedIds: [],
      droppedForSubSkills: [],
      maxSkills: 15,
      mode: 'deterministic',
      targetCount: 4,
      lastBatchCount: 3,
      llmSkillCount: 3,
      consecutiveEmpty: 0,
    };
    const out = await apply({
      detected: det(['Access Control', 'Forms', 'Modules', 'Routing']),
      iteration: 1,
      previousIterations: [
        { iteration: 0, llmOutput: null, applyOutput: prior, continueRequested: true },
      ],
      agentMiningResults: [
        miningResult('cap-0-a', 'alpha'),
        miningResult('cap-1-b', 'beta'),
        miningResult('cap-2-c', 'gamma'),
      ],
      llmOutput: { skills: [mkSkill('delta')] },
    });
    expect(out.written.map((w) => w.id).sort()).toEqual(['alpha', 'beta', 'delta', 'gamma']);
    expect(out.lastBatchCount).toBe(1);
    expect(out.llmSkillCount).toBe(4);
  });

  it('selectAgents returns one unique dispatch per capability when deterministic', async () => {
    const dispatches = await withBypass(undefined, () =>
      skillGenerationStep.agentMining!.selectAgents({
        ctx: fakeCtx,
        detected: det(['A', 'B', 'C', 'D', 'E']),
        formValues: {},
        llmOutput: undefined,
      }),
    );
    expect(dispatches).toHaveLength(5);
    expect(new Set(dispatches.map((d) => d.agentId)).size).toBe(5);
    expect(dispatches[0]!.prompt).toMatch(/EXACTLY ONE skill for this specific capability/);
  });

  it('inlines only the pinned capability BUSINESS_LOGIC.md section into each agent prompt', async () => {
    const dispatches = await withBypass(undefined, () =>
      skillGenerationStep.agentMining!.selectAgents({
        ctx: fakeCtx,
        detected: {
          ...det(['Alpha', 'Beta', 'Gamma']),
          __capabilitySections: {
            Alpha: 'Alpha syncs the boat catalogue via alpha_service.',
            Beta: 'Beta renders the fleet search form.',
          },
        },
        formValues: {},
        llmOutput: undefined,
      }),
    );
    const byCap = (c: string) => dispatches.find((d) => d.agentTitle === c)!.prompt;

    // Alpha's agent gets Alpha's section body + the do-not-re-read step 1...
    expect(byCap('Alpha')).toContain('Domain knowledge for "Alpha"');
    expect(byCap('Alpha')).toContain('Alpha syncs the boat catalogue via alpha_service.');
    expect(byCap('Alpha')).toMatch(/read THAT, do not re-open/);
    // ...and NOT another capability's section — each agent gets one narrow slice.
    expect(byCap('Alpha')).not.toContain('Beta renders the fleet search form.');

    // Gamma has no section → no inlined block, falls back to the read-the-KB step 1.
    expect(byCap('Gamma')).not.toContain('Domain knowledge for');
    expect(byCap('Gamma')).toContain('Use the knowledge base above');
  });

  it('selectAgents returns [] for discovery (<3 capabilities) and under test bypass', async () => {
    const discovery = await withBypass(undefined, () =>
      skillGenerationStep.agentMining!.selectAgents({
        ctx: fakeCtx,
        detected: det(['A', 'B']),
        formValues: {},
        llmOutput: undefined,
      }),
    );
    expect(discovery).toEqual([]);
    const bypassed = await withBypass('1', () =>
      skillGenerationStep.agentMining!.selectAgents({
        ctx: fakeCtx,
        detected: det(['A', 'B', 'C']),
        formValues: {},
        llmOutput: undefined,
      }),
    );
    expect(bypassed).toEqual([]);
  });

  it('skipIf skips the bulk llm call only at iteration 0 in deterministic mode', () => {
    const d = det(['A', 'B', 'C']);
    expect(skillGenerationStep.llm!.skipIf!({ detected: d, formValues: {}, iteration: 0 })).toBe(
      true,
    );
    expect(skillGenerationStep.llm!.skipIf!({ detected: d, formValues: {}, iteration: 1 })).toBe(
      false,
    );
    // discovery never skips
    expect(
      skillGenerationStep.llm!.skipIf!({ detected: det(['A']), formValues: {}, iteration: 0 }),
    ).toBe(false);
  });

  it('a failed parallel item leaves a gap that the loop will fill', async () => {
    const out = await apply({
      agentMiningResults: [
        miningResult('cap-0-a', 'alpha'),
        {
          agentId: 'cap-1-b',
          agentTitle: 'Forms',
          status: 'failed' as const,
          output: null,
          rawOutput: null,
          errorMessage: 'max_tokens',
        },
        miningResult('cap-2-c', 'gamma'),
      ],
    });
    expect(out.written.map((w) => w.id).sort()).toEqual(['alpha', 'gamma']); // 1 of 3 failed
    expect(out.llmSkillCount).toBe(2);
    const cont = await skillGenerationStep.loop!.shouldContinue!({
      ctx: fakeCtx,
      applyOutput: out,
      llmOutput: undefined,
      iteration: 0,
      previousIterations: [],
    });
    expect(cont).toBe(true); // gap remains -> loop continues to sequential gap-fill
  });
});
