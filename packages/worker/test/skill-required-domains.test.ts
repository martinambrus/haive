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
});
