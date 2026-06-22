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

describe('skill-generation coverage floor', () => {
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

  it('throws (retriable) when fewer than 3 skills are produced for a >=3-domain project', async () => {
    // The skill carries a valid sub-skill so it survives the sub-skill floor and
    // the assertion isolates the coverage (count) floor.
    await expect(
      skillGenerationStep.apply(fakeCtx, {
        detected,
        llmOutput: {
          skills: [
            {
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
            },
          ],
        },
        formValues: {},
      } as unknown as Parameters<typeof skillGenerationStep.apply>[1]),
    ).rejects.toThrow(/business capabilities/);
  });

  it('throws (retriable) when the LLM emitted skill output but none parsed, even with a bundle present', async () => {
    // Malformed/empty LLM result masked by a bundle skill must still surface for
    // retry instead of silently shipping only the bundle.
    await expect(
      skillGenerationStep.apply(fakeCtx, {
        detected: {
          ...detected,
          requiredDomains: [],
          bundleSkills: [{ id: 'bundled', title: 'Bundled', description: 'd', overview: 'o' }],
        },
        llmOutput: '```json\n{"skills":["not an object"]}\n```',
        formValues: {},
      } as unknown as Parameters<typeof skillGenerationStep.apply>[1]),
    ).rejects.toThrow(/none parsed|malformed/);
  });
});
