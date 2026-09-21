import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { logger, normalizeContent, sha256Hex } from '@haive/shared';
import { skillGenerationStep } from '../src/step-engine/steps/onboarding/09_5-skill-generation.js';
import { resolveCuratedSummary } from '../src/step-engine/_step-summary.js';
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

/** Trailing spaces and a blank-line run, placed INSIDE the text rather than at its end:
 *  `skillToMarkdown` trims the overview, so a suffix at the very end would vanish and the file
 *  would stay normalise-stable. Both files this fixture produces must be non-stable, or an
 *  assertion about normalisation passes on content that never needed any. */
const ROUGH = 'first line   \n\n\n\nsecond line';

/** `rough` is how a test makes the written bytes NOT normalise-stable — in BOTH files, since
 *  SKILL.md and the sub-skill are hashed separately and a stable one pins nothing. */
function skill(id: string, rough = false) {
  return {
    id,
    title: `${id} title`,
    description: `${id} description`,
    overview: rough ? `What this domain covers.\n\n${ROUGH}` : 'What this domain covers.',
    subSkills: [
      {
        slug: 'alpha',
        name: `${id}-alpha`,
        title: 'Alpha',
        description: 'd',
        summary: 's',
        body: '## Purpose\n\nx' + (rough ? `\n\n${ROUGH}` : ''),
      },
    ],
  };
}

type GenOut = {
  summary: string;
  written: { id: string }[];
  totalSubSkills: number;
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
    const out = await callApply({ llmOutput: { skills: [skill('conventions', true)] } });

    const first = DIRS[0]!;
    const skillMd = await readFile(
      path.join(repoRoot, ...first.split('/'), 'conventions', 'SKILL.md'),
      'utf8',
    );
    // Each file asserts the fixture BITES before asserting what it proves. Without this on
    // SKILL.md the raw and normalised digests agree, and dropping `normalizeContent` survives —
    // measured, not hypothetical.
    expect(normalizeContent(skillMd)).not.toBe(skillMd);
    expect(out.skillHashes?.conventions).toBe(sha256Hex(normalizeContent(skillMd)));
    expect(out.skillHashes?.conventions).not.toBe(sha256Hex(skillMd));

    const leaf = await readFile(
      path.join(repoRoot, ...first.split('/'), 'conventions', 'sub-skills', 'alpha.md'),
      'utf8',
    );
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

  it('emits a curated summary whose counts are the ones it actually wrote', async () => {
    // Driven through the REAL apply, because the api-side test that asserts the curated path
    // picks a `summary` up feeds a synthetic object — it would stay green if this step stopped
    // emitting one, which is the same hole the hash tests above exist to close.
    const out = await callApply({
      llmOutput: { skills: [skill('conventions'), skill('naming')] },
    });

    expect(resolveCuratedSummary(out)).toBe(out.summary);
    expect(out.summary).toContain(`${out.written.length} skill(s)`);
    expect(out.summary).toContain(`${out.totalSubSkills} sub-skill(s)`);
    // Two mirrors in this fixture, so the plural branch is the one exercised.
    expect(out.summary).toContain(`${DIRS.length} CLI skills directories`);
  });

  it('counts a capped candidate ONCE in the dropped clause', async () => {
    // An over-cap candidate increments `droppedFromCap` AND is pushed to `rejectedIds`, so a
    // recap that sums both reports every capped skill twice. A number in this panel is read as
    // fact, which makes a wrong one worse than none at all.
    const out = await callApply({
      llmOutput: { skills: [skill('first'), skill('second')] },
      formValues: { maxSkills: 1 },
    });

    expect(out.written).toHaveLength(1);
    // One candidate over the cap: the clause says 1, not 2.
    expect(out.summary).toContain('1 candidate(s) were dropped');
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
