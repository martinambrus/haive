import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkSkill,
  countSubSkillFiles,
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

async function writeSkill(repo: string, id: string, subSkillSlugs: string[]): Promise<void> {
  const dir = path.join(repo, '.claude', 'skills', id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), VALID_SKILL_MD, 'utf8');
  if (subSkillSlugs.length > 0) {
    const subDir = path.join(dir, 'sub-skills');
    await mkdir(subDir, { recursive: true });
    for (const slug of subSkillSlugs) {
      await writeFile(path.join(subDir, `${slug}.md`), `# ${slug}\n`, 'utf8');
    }
  }
}

describe('countSubSkillFiles', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), 'skill-verify-'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('counts only *.md files under the skill sub-skills dir', async () => {
    await writeSkill(repo, 'good', ['a', 'b', 'c']);
    // a non-md file should not be counted
    await writeFile(path.join(repo, '.claude', 'skills', 'good', 'sub-skills', 'notes.txt'), 'x');
    expect(await countSubSkillFiles(repo, SKILLS_DIR, 'good')).toBe(3);
  });

  it('returns 0 when the sub-skills dir is absent', async () => {
    await writeSkill(repo, 'truncated', []);
    expect(await countSubSkillFiles(repo, SKILLS_DIR, 'truncated')).toBe(0);
  });

  it('returns 0 for an unknown skill id', async () => {
    expect(await countSubSkillFiles(repo, SKILLS_DIR, 'missing')).toBe(0);
  });
});

describe('checkSkill', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), 'skill-verify-'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('passes a structurally valid skill that has sub-skills', async () => {
    await writeSkill(repo, 'good', ['a', 'b', 'c']);
    const check = await checkSkill(repo, SKILLS_DIR, 'good');
    expect(check.passed).toBe(true);
    expect(check.subSkillCount).toBe(3);
    expect(check.issues).toEqual([]);
  });

  it('fails a valid SKILL.md that has zero sub-skills (truncated generation)', async () => {
    await writeSkill(repo, 'truncated', []);
    const check = await checkSkill(repo, SKILLS_DIR, 'truncated');
    expect(check.passed).toBe(false);
    expect(check.subSkillCount).toBe(0);
    expect(check.issues).toContain('no sub-skills (likely truncated generation — re-run 09_5)');
  });

  it('reports a missing SKILL.md with subSkillCount 0 and the missing issue', async () => {
    const check = await checkSkill(repo, SKILLS_DIR, 'absent');
    expect(check.passed).toBe(false);
    expect(check.subSkillCount).toBe(0);
    expect(check.issues).toContain('SKILL.md missing');
  });

  it('does not flag a bundle skill (isBundle=true) that has zero sub-skills', async () => {
    await writeSkill(repo, 'flat-bundle', []);
    const check = await checkSkill(repo, SKILLS_DIR, 'flat-bundle', true);
    expect(check.subSkillCount).toBe(0);
    expect(check.passed).toBe(true);
    expect(check.issues).toEqual([]);
  });
});
