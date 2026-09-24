import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KB_DIR, LEARNINGS_DIR } from '@haive/shared/knowledge-paths';
import { readExistingLearnings } from '../src/step-engine/steps/workflow/11-phase-8-learning.js';
import { buildFileEntry } from '../src/step-engine/steps/workflow/_commit-diff.js';
import { listSkillDirs } from '../src/step-engine/steps/onboarding/09_6-skill-verification.js';
import { readDiskSkillSummaries } from '../src/step-engine/steps/onboarding/09_5b-skill-repair.js';
import { listKbFiles } from '../src/step-engine/steps/onboarding/09_5-skill-generation.js';
import { listFilesMatching } from '../src/step-engine/steps/onboarding/_helpers.js';

const FILES: Record<string, string> = {
  [`${LEARNINGS_DIR}/a.md`]: '# A learning\n\nbody\n',
  [`${KB_DIR}/ARCH.md`]: '# Architecture\n\n## Parts\n',
  '.claude/skills/demo/SKILL.md': '---\nname: demo\ndescription: A demo skill\n---\n# Demo\n',
  'notes.md': 'hello\n',
};

/** A repository root whose worktree `wt` is a real directory, or a link to `elsewhere/` holding the
 *  same files. A read anchored on the worktree's own path follows that link. */
async function fixture(linked: boolean): Promise<{ root: string; worktree: string }> {
  const root = await mkdtemp(join(tmpdir(), 'worktree-anchor-'));
  const worktree = join(root, '.haive/worktrees/wt');
  const tree = linked ? join(root, 'elsewhere') : worktree;
  for (const [rel, content] of Object.entries(FILES)) {
    await mkdir(join(tree, rel, '..'), { recursive: true });
    await writeFile(join(tree, rel), content);
  }
  if (linked) {
    await mkdir(join(root, '.haive/worktrees'), { recursive: true });
    await symlink(join(root, 'elsewhere'), worktree);
  }
  return { root, worktree };
}

const noGit = async (): Promise<never> => {
  throw new Error('an untracked file needs no git');
};
const untracked = { x: '?', y: '?', path: 'notes.md' } as Parameters<typeof buildFileEntry>[2];

/** Each read, what it returns on a real worktree, and what it returns behind a linked one. */
const READS: [string, (worktree: string) => Promise<unknown>, unknown, unknown][] = [
  ['learnings', async (w) => (await readExistingLearnings(w)).map((l) => l.id), ['a'], []],
  ['skill dirs', (w) => listSkillDirs(w, '.claude/skills'), ['demo'], []],
  [
    'file walk',
    (w) => listFilesMatching(w, (rel, isDir) => !isDir && rel === 'notes.md'),
    ['notes.md'],
    [],
  ],
  [
    'skill summaries',
    (w) => readDiskSkillSummaries(w, '.claude/skills'),
    [{ id: 'demo', title: 'demo', description: 'A demo skill' }],
    [],
  ],
  [
    'KB files',
    async (w) => (await listKbFiles(w)).map((k) => k.relPath),
    [`${KB_DIR}/ARCH.md`],
    [],
  ],
  [
    'commit diff file',
    async (w) => (await buildFileEntry(w, noGit, untracked, 1_000_000)).newContent,
    'hello\n',
    '',
  ],
];

describe('reads inside a worktree go through the repository root', () => {
  let root = '';
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each(READS)('%s: reads a real worktree', async (_name, read, real) => {
    const f = await fixture(false);
    root = f.root;
    expect(await read(f.worktree)).toEqual(real);
  });

  it.each(READS)(
    '%s: reads nothing through a linked worktree',
    async (_name, read, _real, linked) => {
      const f = await fixture(true);
      root = f.root;
      expect(await read(f.worktree)).toEqual(linked);
    },
  );
});
