import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { logger, normalizeContent, sha256Hex } from '@haive/shared';
import { skillGenerationStep } from '../src/step-engine/steps/onboarding/09_5-skill-generation.js';
import type { StepContext } from '../src/step-engine/step-definition.js';

/**
 * What 09_5 RECORDS about the bytes it wrote.
 *
 * The onboarding reset reads these to tell a generated skill the user has edited from one still
 * holding what Haive put there. Every test on the reading side feeds the fields synthetically, so
 * without this the step could stop emitting them — or hash the wrong string — and the whole api
 * suite would stay green while the gate quietly stopped firing.
 */

const DIRS = ['.claude/skills', '.gemini/skills'];

let repoRoot: string;

beforeEach(async () => {
  // A fresh directory per test rather than a fixed path: a leftover tree from an earlier run
  // passes off a stale result and then fails only on a clean runner.
  repoRoot = await mkdtemp(path.join(os.tmpdir(), 'haive-skill-hash-'));
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true }).catch(() => {});
});

const ctxFor = (): StepContext =>
  ({
    repoPath: repoRoot,
    logger: logger.child({ test: 'skill-generation-hashes' }),
    db: undefined as never,
  }) as unknown as StepContext;

const detected = {
  framework: 'general',
  language: 'php',
  kbFiles: [],
  requiredDomains: [],
  skillTargetDirs: DIRS,
  bundleSkills: [],
};

/** `bodySuffix` is how a test makes the written bytes NOT normalise-stable. */
function skill(id: string, bodySuffix = '') {
  return {
    id,
    title: `${id} title`,
    description: `${id} description`,
    overview: 'What this domain covers.',
    subSkills: [
      {
        slug: 'alpha',
        name: `${id}-alpha`,
        title: 'Alpha',
        description: 'd',
        summary: 's',
        body: '## Purpose\n\nx' + (bodySuffix ? `\n\n${bodySuffix}` : ''),
      },
    ],
  };
}

type GenOut = {
  written: { id: string }[];
  skillHashes?: Record<string, string>;
  skillSubSkillHashes?: Record<string, Record<string, string>>;
  skillReadmeHashes?: Record<string, string>;
};

function callApply(over: Record<string, unknown>): Promise<GenOut> {
  return skillGenerationStep.apply(ctxFor(), {
    detected,
    formValues: {},
    iteration: 0,
    previousIterations: [],
    isFinalLlmAttempt: true,
    ...over,
  } as unknown as Parameters<typeof skillGenerationStep.apply>[1]) as Promise<GenOut>;
}

describe('skillGenerationStep.apply — recorded content hashes', () => {
  it('records the NORMALISED hash of each file, against the bytes on disk', async () => {
    // The trailing spaces and blank-line run are deliberate. Generated markdown is mostly
    // normalise-stable, and a fixture built from it pins nothing — both digests agree and
    // dropping `normalizeContent` survives. `sanitizeSubSkills` passes a body through untouched.
    const out = await callApply({
      llmOutput: { skills: [skill('conventions', 'trailing   \n\n\n\nmore')] },
    });

    const first = DIRS[0]!;
    const skillMd = await readFile(
      path.join(repoRoot, ...first.split('/'), 'conventions', 'SKILL.md'),
      'utf8',
    );
    expect(out.skillHashes?.conventions).toBe(sha256Hex(normalizeContent(skillMd)));

    const leaf = await readFile(
      path.join(repoRoot, ...first.split('/'), 'conventions', 'sub-skills', 'alpha.md'),
      'utf8',
    );
    // The fixture must bite, or the assertion under it proves nothing.
    expect(normalizeContent(leaf)).not.toBe(leaf);
    expect(out.skillSubSkillHashes?.conventions?.alpha).toBe(sha256Hex(normalizeContent(leaf)));
    expect(out.skillSubSkillHashes?.conventions?.alpha).not.toBe(sha256Hex(leaf));
  });

  it('records ONE hash for every mirror, because the mirrors are byte-identical', async () => {
    // What makes a single hash sound: SKILL.md and the sub-skill bodies are rendered ABOVE the
    // target-dir loop and neither renderer takes a directory.
    await callApply({ llmOutput: { skills: [skill('conventions')] } });

    const read = (dir: string) =>
      readFile(path.join(repoRoot, ...dir.split('/'), 'conventions', 'SKILL.md'), 'utf8');
    expect(await read(DIRS[0]!)).toBe(await read(DIRS[1]!));
  });

  it('keys the README hash BY DIRECTORY, because that render interpolates its own path', async () => {
    const out = await callApply({ llmOutput: { skills: [skill('conventions')] } });

    for (const dir of DIRS) {
      const readme = await readFile(path.join(repoRoot, ...dir.split('/'), 'README.md'), 'utf8');
      expect(out.skillReadmeHashes?.[dir]).toBe(sha256Hex(normalizeContent(readme)));
    }
    // Different directories genuinely produce different bytes, which is why one hash will not do.
    expect(out.skillReadmeHashes?.[DIRS[0]!]).not.toBe(out.skillReadmeHashes?.[DIRS[1]!]);
  });

  it('carries a prior pass’s hashes forward, as it carries the skills themselves', async () => {
    // Each pass returns the CUMULATIVE library and never rewrites an earlier pass's skill, so its
    // hash stays valid and must survive. Dropping the carry would leave every skill but the last
    // one claimed by path alone — the exact gap this closes.
    const firstPass = await callApply({ llmOutput: { skills: [skill('first')] } });

    const second = await callApply({
      llmOutput: { skills: [skill('second')] },
      iteration: 1,
      previousIterations: [
        { iteration: 0, llmOutput: null, applyOutput: firstPass, continueRequested: true },
      ],
    });

    expect(second.written.map((w) => w.id).sort()).toEqual(['first', 'second']);
    expect(second.skillHashes?.first).toBe(firstPass.skillHashes?.first);
    expect(second.skillHashes?.second).toBeDefined();
  });
});
