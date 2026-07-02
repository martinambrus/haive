import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentMiningResult, StepContext } from '../src/step-engine/step-definition.js';
import { skillRepairStep } from '../src/step-engine/steps/onboarding/09_5b-skill-repair.js';
import { checkSkill } from '../src/step-engine/steps/onboarding/09_6-skill-verification.js';

const DIRS = ['.claude/skills', '.gemini/skills'];

/** A valid repair JSON payload (fenced, as a CLI would emit) for skill `id` with 3
 *  sub-skills whose bodies clear the verification body floor. */
function repairJson(id: string): string {
  const sub = (slug: string) => ({
    slug,
    name: `${id}-${slug}`,
    title: `Title ${slug}`,
    description: `activation description for ${slug}`,
    summary: `summary for ${slug}`,
    body: `## Purpose\n\nThe ${slug} leaf explains one facet in enough prose to clear the body floor and then some, citing lib/x.ts:1-9.`,
  });
  const obj = {
    skills: [
      {
        id,
        title: `${id} Repaired`,
        description: `A repaired ${id} skill.`,
        overview: 'What this domain covers and when an agent invokes it.',
        subSkills: [sub('alpha'), sub('beta'), sub('gamma')],
      },
    ],
  };
  return '```json\n' + JSON.stringify(obj) + '\n```';
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function writeSkillDir(
  repo: string,
  dir: string,
  id: string,
  skillMd: string,
  subs: Record<string, string>,
): Promise<void> {
  const base = path.join(repo, ...dir.split('/'), id);
  await mkdir(base, { recursive: true });
  await writeFile(path.join(base, 'SKILL.md'), skillMd, 'utf8');
  if (Object.keys(subs).length > 0) {
    const subDir = path.join(base, 'sub-skills');
    await mkdir(subDir, { recursive: true });
    for (const [name, body] of Object.entries(subs)) {
      await writeFile(path.join(subDir, name), body, 'utf8');
    }
  }
}

const VALID_SKILL_MD = [
  '---',
  'name: keepme',
  'description: a kept skill',
  '---',
  '',
  '# Keep',
  '',
  '## Overview',
  '',
  'Body.',
  '',
].join('\n');
const VALID_LEAF_MD = [
  '---',
  'name: keepme-leaf',
  'description: a kept leaf',
  '---',
  '',
  '# Leaf',
  '',
  '## Identification',
  '',
  '- **Parent**: [keepme/SKILL.md](../SKILL.md)',
  '',
  '## Purpose',
  '',
  'This kept leaf has enough prose to clear the body floor comfortably without any trouble.',
  '',
].join('\n');

const miningResult = (agentId: string, output: unknown): AgentMiningResult => ({
  agentId,
  agentTitle: agentId,
  status: 'done',
  output,
  rawOutput: typeof output === 'string' ? output : null,
  errorMessage: null,
});

function detectStub(
  failing: { skillId: string; issues: string[] }[],
  targetDirs: string[] = DIRS,
): unknown {
  return {
    failingSkills: failing.map((f) => ({ ...f, skillMdExcerpt: null })),
    skillTargetDirs: targetDirs,
    framework: null,
    language: null,
    kbFiles: [],
  };
}

const ctxFor = (repo: string): StepContext =>
  ({ repoPath: repo, logger: { info: () => {} } }) as unknown as StepContext;

describe('skillRepairStep.apply', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), 'skill-repair-'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('repairs only failing skills across all mirror dirs, clears stale leaves, and passes verification', async () => {
    // 'broken' exists in both mirrors with a STALE bad leaf (the truncated-generation state).
    for (const dir of DIRS) {
      await writeSkillDir(repo, dir, 'broken', '# Broken\n\n(no overview)\n', {
        'stale-bad.md': 'not a real sub-skill',
      });
      // 'keepme' is a passing skill that is NOT in the failing set — must be untouched.
      await writeSkillDir(repo, dir, 'keepme', VALID_SKILL_MD, { 'keep-leaf.md': VALID_LEAF_MD });
    }

    const out = (await skillRepairStep.apply(ctxFor(repo), {
      detected: detectStub([
        {
          skillId: 'broken',
          issues: ['no sub-skills (likely truncated generation — re-run 09_5)'],
        },
      ]),
      formValues: {},
      agentMiningResults: [miningResult('broken', repairJson('broken'))],
      iteration: 0,
      previousIterations: [],
    })) as { repaired: string[]; stillFailing: string[]; attempted: number };

    expect(out.repaired).toEqual(['broken']);
    expect(out.stillFailing).toEqual([]);
    expect(out.attempted).toBe(1);

    for (const dir of DIRS) {
      const base = path.join(repo, ...dir.split('/'), 'broken');
      // Stale leaf gone; fresh leaves written.
      expect(await exists(path.join(base, 'sub-skills', 'stale-bad.md'))).toBe(false);
      expect(await exists(path.join(base, 'sub-skills', 'alpha.md'))).toBe(true);
      expect(await readFile(path.join(base, 'SKILL.md'), 'utf8')).toContain('broken Repaired');
      // Repaired skill now passes the SAME verification 09_6 runs, in every mirror.
      expect((await checkSkill(repo, dir, 'broken')).passed).toBe(true);
      // Untouched passing skill kept its original leaf.
      const keepLeaf = path.join(repo, ...dir.split('/'), 'keepme', 'sub-skills', 'keep-leaf.md');
      expect(await readFile(keepLeaf, 'utf8')).toBe(VALID_LEAF_MD);
      // README rebuilt from the on-disk set.
      const readme = await readFile(path.join(repo, ...dir.split('/'), 'README.md'), 'utf8');
      expect(readme).toContain('broken');
      expect(readme).toContain('keepme');
    }
  });

  it('leaves an un-repairable failing skill in place and reports it as stillFailing', async () => {
    await writeSkillDir(repo, DIRS[0]!, 'unfixable', '# Unfixable\n\noriginal content\n', {});

    const out = (await skillRepairStep.apply(ctxFor(repo), {
      detected: detectStub([{ skillId: 'unfixable', issues: ['SKILL.md empty'] }], [DIRS[0]!]),
      formValues: {},
      // Agent returned nothing parseable → no valid skill → left as-is.
      agentMiningResults: [miningResult('unfixable', 'sorry, I could not produce JSON')],
      iteration: 0,
      previousIterations: [],
    })) as { repaired: string[]; stillFailing: string[] };

    expect(out.repaired).toEqual([]);
    expect(out.stillFailing).toEqual(['unfixable']);
    // Original file untouched.
    const smd = await readFile(
      path.join(repo, ...DIRS[0]!.split('/'), 'unfixable', 'SKILL.md'),
      'utf8',
    );
    expect(smd).toContain('original content');
  });
});

describe('skillRepairStep.shouldRun', () => {
  const dbStub = (rows: unknown[]) =>
    ({
      select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
    }) as unknown as StepContext['db'];

  const ctx = (round: number, rows: unknown[]): StepContext =>
    ({ round, taskId: 't', db: dbStub(rows) }) as unknown as StepContext;

  it('never runs on the original pass (round 0)', async () => {
    expect(await skillRepairStep.shouldRun!(ctx(0, []))).toBe(false);
  });

  it('runs when a step.revise event targets this step for the current round', async () => {
    const rows = [{ payload: { targetStepId: '09_5b-skill-repair', round: 1 } }];
    expect(await skillRepairStep.shouldRun!(ctx(1, rows))).toBe(true);
  });

  it('does not run for a regenerate revise (targets 09_5)', async () => {
    const rows = [{ payload: { targetStepId: '09_5-skill-generation', round: 1 } }];
    expect(await skillRepairStep.shouldRun!(ctx(1, rows))).toBe(false);
  });

  it('does not run when the matching revise is for a different round', async () => {
    const rows = [{ payload: { targetStepId: '09_5b-skill-repair', round: 2 } }];
    expect(await skillRepairStep.shouldRun!(ctx(1, rows))).toBe(false);
  });
});
