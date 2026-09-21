import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentMiningResult, StepContext } from '../src/step-engine/step-definition.js';
import { skillRepairStep } from '../src/step-engine/steps/onboarding/09_5b-skill-repair.js';
import { checkSkill } from '../src/step-engine/steps/onboarding/09_6-skill-verification.js';
import { normalizeContent, sha256Hex } from '@haive/shared';

const DIRS = ['.claude/skills', '.gemini/skills'];

/** A valid repair JSON payload (fenced, as a CLI would emit) for skill `id` with 3
 *  sub-skills whose bodies clear the verification body floor. */
/** Trailing spaces and a blank-line run, placed INSIDE the text rather than at its end:
 *  `skillToMarkdown` trims the overview, so a suffix at the very end would vanish. */
const ROUGH = 'first line   \n\n\n\nsecond line';

/** `rough` makes the written bytes NOT normalise-stable, in BOTH the SKILL.md and the sub-skill
 *  files — they are hashed separately, and a stable one pins nothing about the normalisation. */
function repairJson(id: string, rough = false): string {
  const sub = (slug: string) => ({
    slug,
    name: `${id}-${slug}`,
    title: `Title ${slug}`,
    description: `activation description for ${slug}`,
    summary: `summary for ${slug}`,
    body:
      `## Purpose\n\nThe ${slug} leaf explains one facet in enough prose to clear the body floor and then some, citing lib/x.ts:1-9.` +
      (rough ? `\n\n${ROUGH}` : ''),
  });
  const obj = {
    skills: [
      {
        id,
        title: `${id} Repaired`,
        description: `A repaired ${id} skill.`,
        overview:
          'What this domain covers and when an agent invokes it.' + (rough ? `\n\n${ROUGH}` : ''),
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
): Parameters<typeof skillRepairStep.apply>[1]['detected'] {
  return {
    // detect's first-round repair size for a failure that was not a truncation.
    failingSkills: failing.map((f) => ({
      ...f,
      skillMdExcerpt: null,
      maxSub: 8,
      bodyLen: '100-250',
      shrunk: false,
    })),
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

  it('records the hash of every file it rewrote, normalised, and one hash per mirror', async () => {
    // Without this the field is only ever fed synthetically by the api-side tests, so the step
    // could stop emitting it — or hash the wrong string — and the whole reset suite stays green.
    for (const dir of DIRS) {
      await writeSkillDir(repo, dir, 'broken', '# Broken\n\n(no overview)\n', {});
    }

    const out = (await skillRepairStep.apply(ctxFor(repo), {
      detected: detectStub([{ skillId: 'broken', issues: ['no sub-skills'] }]),
      formValues: {},
      // `rough` makes the written bytes NOT normalise-stable, in BOTH files: most generated
      // markdown already is, and a fixture built from it pins nothing — the two digests coincide
      // and dropping `normalizeContent` survives. `sanitizeSubSkills` passes a body through
      // untouched, and the overview is only trimmed at its ends, so both reach disk rough.
      agentMiningResults: [miningResult('broken', repairJson('broken', true))],
      iteration: 0,
      previousIterations: [],
    })) as {
      repairedHashes?: Record<string, string>;
      repairedSubSkillHashes?: Record<string, Record<string, string>>;
      repairedReadmeHashes?: Record<string, string>;
    };

    const first = DIRS[0]!;
    const second = DIRS[1]!;
    const skillMd = await readFile(
      path.join(repo, ...first.split('/'), 'broken', 'SKILL.md'),
      'utf8',
    );
    // Each file asserts the fixture BITES before asserting what it proves. Without this on
    // SKILL.md the raw and normalised digests agree and dropping `normalizeContent` survives —
    // measured, and in this PR it survived twice before the fixtures were fixed.
    expect(normalizeContent(skillMd)).not.toBe(skillMd);
    expect(out.repairedHashes?.broken).toBe(sha256Hex(normalizeContent(skillMd)));
    expect(out.repairedHashes?.broken).not.toBe(sha256Hex(skillMd));

    // ONE hash for every mirror, which is only sound because the mirrors are byte-identical.
    const mirrored = await readFile(
      path.join(repo, ...second.split('/'), 'broken', 'SKILL.md'),
      'utf8',
    );
    expect(mirrored).toBe(skillMd);

    const leafPath = path.join(repo, ...first.split('/'), 'broken', 'sub-skills', 'alpha.md');
    const leaf = await readFile(leafPath, 'utf8');
    // The fixture must actually bite, or the normalisation assertion below proves nothing.
    expect(normalizeContent(leaf)).not.toBe(leaf);
    expect(out.repairedSubSkillHashes?.broken?.alpha).toBe(sha256Hex(normalizeContent(leaf)));
    expect(out.repairedSubSkillHashes?.broken?.alpha).not.toBe(sha256Hex(leaf));

    // The README is per DIR, because the render interpolates its own path and is rebuilt from
    // that directory's own on-disk set.
    const readme = await readFile(path.join(repo, ...first.split('/'), 'README.md'), 'utf8');
    expect(out.repairedReadmeHashes?.[first]).toBe(sha256Hex(normalizeContent(readme)));
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
