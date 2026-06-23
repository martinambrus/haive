import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StepContext } from '../src/step-engine/step-definition.js';
import {
  checkSkill,
  skillVerificationStep,
  type SkillCheck,
  type SkillVerificationDetect,
} from '../src/step-engine/steps/onboarding/09_6-skill-verification.js';

const SKILLS_DIR = '.claude/skills';

const VALID_SKILL_MD = [
  '---',
  'name: example',
  'description: An example skill for verification tests.',
  '---',
  '',
  '# Example',
  '',
  '## Overview',
  '',
  'Body.',
  '',
].join('\n');

// Mirrors what 09_5's subSkillToMarkdown emits: frontmatter name+description, an
// H1 title, a ## Identification block, and a real body past the floor.
const VALID_SUBSKILL_MD = [
  '---',
  'name: example-leaf',
  'description: a leaf facet of the example skill',
  '---',
  '',
  '# Leaf',
  '',
  '## Identification',
  '',
  '- **Function**: `lib/example.ts::leaf`',
  '- **Parent**: [example/SKILL.md](../SKILL.md)',
  '',
  '## Purpose',
  '',
  'This sub-skill explains the leaf facet in enough prose to clear the body floor easily.',
  '',
].join('\n');

async function writeSkill(
  repo: string,
  id: string,
  subSkills: Record<string, string>,
  opts: { dir?: string; skillMd?: string } = {},
): Promise<void> {
  const dir = path.join(repo, ...(opts.dir ?? SKILLS_DIR).split('/'), id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), opts.skillMd ?? VALID_SKILL_MD, 'utf8');
  if (Object.keys(subSkills).length > 0) {
    const subDir = path.join(dir, 'sub-skills');
    await mkdir(subDir, { recursive: true });
    for (const [name, body] of Object.entries(subSkills)) {
      await writeFile(path.join(subDir, name), body, 'utf8');
    }
  }
}

const validSubs = (...slugs: string[]): Record<string, string> =>
  Object.fromEntries(slugs.map((s) => [`${s}.md`, VALID_SUBSKILL_MD]));

describe('checkSkill', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), 'skill-verify-'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('passes a structurally valid skill with valid sub-skills', async () => {
    await writeSkill(repo, 'good', validSubs('a', 'b', 'c'));
    const check = await checkSkill(repo, SKILLS_DIR, 'good');
    expect(check.passed).toBe(true);
    expect(check.subSkillCount).toBe(3);
    expect(check.issues).toEqual([]);
    expect(check.skillsDir).toBe(SKILLS_DIR);
  });

  it('fails when a sub-skill file is present but garbage (gap 1)', async () => {
    await writeSkill(repo, 'good', {
      'a.md': VALID_SUBSKILL_MD,
      'broken.md': 'not a real sub-skill',
    });
    const check = await checkSkill(repo, SKILLS_DIR, 'good');
    expect(check.passed).toBe(false);
    // the leaf file still counts, but its content is rejected
    expect(check.subSkillCount).toBe(2);
    expect(check.issues.some((i) => i.includes('broken.md'))).toBe(true);
    expect(check.issues.some((i) => i.includes('frontmatter missing name'))).toBe(true);
  });

  it('fails a sub-skill missing its ## Identification block (gap 1)', async () => {
    const noIdent = VALID_SUBSKILL_MD.replace('## Identification', '## Notes');
    await writeSkill(repo, 'good', { 'a.md': noIdent });
    const check = await checkSkill(repo, SKILLS_DIR, 'good');
    expect(check.passed).toBe(false);
    expect(check.issues.some((i) => i.includes('missing ## Identification'))).toBe(true);
  });

  it('fails a valid SKILL.md that has zero sub-skills (truncated generation)', async () => {
    await writeSkill(repo, 'truncated', {});
    const check = await checkSkill(repo, SKILLS_DIR, 'truncated');
    expect(check.passed).toBe(false);
    expect(check.subSkillCount).toBe(0);
    expect(check.issues).toContain('no sub-skills (likely truncated generation — re-run 09_5)');
  });

  it('reports a missing SKILL.md with subSkillCount 0 and the missing issue (gap 2)', async () => {
    const check = await checkSkill(repo, '.agents/skills', 'absent');
    expect(check.passed).toBe(false);
    expect(check.subSkillCount).toBe(0);
    expect(check.issues).toContain('SKILL.md missing');
    expect(check.skillsDir).toBe('.agents/skills');
  });

  it('does not flag a bundle skill (isBundle=true) that has zero sub-skills', async () => {
    await writeSkill(repo, 'flat-bundle', {});
    const check = await checkSkill(repo, SKILLS_DIR, 'flat-bundle', true);
    expect(check.subSkillCount).toBe(0);
    expect(check.passed).toBe(true);
    expect(check.issues).toEqual([]);
  });
});

function detectStub(checks: SkillCheck[]): SkillVerificationDetect {
  return {
    checks,
    missingFileIds: checks
      .filter((c) => c.issues.includes('SKILL.md missing'))
      .map((c) => c.skillId),
    brokenStructureIds: checks
      .filter((c) => !c.passed && !c.issues.includes('SKILL.md missing'))
      .map((c) => c.skillId),
    deficientSubSkillIds: [],
    skillTargetDirs: [SKILLS_DIR],
  };
}

function makeCheck(partial: Partial<SkillCheck>): SkillCheck {
  return {
    skillId: 'x',
    skillsDir: SKILLS_DIR,
    skillPath: '/x/SKILL.md',
    passed: true,
    issues: [],
    subSkillCount: 3,
    ...partial,
  };
}

const ctxStub = { logger: { info: () => {} } } as unknown as StepContext;

describe('skillVerificationStep gate (gap 3)', () => {
  it('form returns null when every check passes', () => {
    expect(skillVerificationStep.form!(ctxStub, detectStub([makeCheck({})]))).toBeNull();
  });

  it('form renders an accept-default review gate when a check fails', () => {
    const detected = detectStub([
      makeCheck({ skillId: 'bad', passed: false, issues: ['missing ## Overview section'] }),
    ]);
    const form = skillVerificationStep.form!(ctxStub, detected);
    expect(form).not.toBeNull();
    const radio = form!.fields.find((f) => f.id === 'decision');
    expect(radio?.type).toBe('radio');
    // 'accept' default => an auto-continue task never auto-selects the uncapped
    // regenerate route.
    expect((radio as { default?: string }).default).toBe('accept');
  });

  it('reviseLoop targets 09_5 only on regenerate', () => {
    const evaluate = skillVerificationStep.reviseLoop!.evaluate;
    expect(evaluate({ checks: [], passed: false, decision: 'regenerate' })).toEqual({
      targetStepId: '09_5-skill-generation',
    });
    expect(evaluate({ checks: [], passed: false, decision: 'accept' })).toBeNull();
    expect(evaluate({ checks: [], passed: true, decision: 'none' })).toBeNull();
  });

  it('apply reports none when clean and the chosen decision when broken', async () => {
    const cleanOut = await skillVerificationStep.apply(ctxStub, {
      detected: detectStub([makeCheck({})]),
      formValues: {},
      iteration: 0,
      previousIterations: [],
    });
    expect(cleanOut.passed).toBe(true);
    expect(cleanOut.decision).toBe('none');

    const broken = detectStub([
      makeCheck({ skillId: 'bad', passed: false, issues: ['SKILL.md empty'] }),
    ]);
    const regen = await skillVerificationStep.apply(ctxStub, {
      detected: broken,
      formValues: { decision: 'regenerate' },
      iteration: 0,
      previousIterations: [],
    });
    expect(regen.passed).toBe(false);
    expect(regen.decision).toBe('regenerate');

    const accept = await skillVerificationStep.apply(ctxStub, {
      detected: broken,
      formValues: {},
      iteration: 0,
      previousIterations: [],
    });
    expect(accept.decision).toBe('accept');
  });
});
