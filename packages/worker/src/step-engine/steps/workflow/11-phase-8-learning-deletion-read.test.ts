import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StepApplyArgs, StepContext } from '../../step-definition.js';

// Keep the filesystem primitives real: only database-backed dependencies are replaced.
vi.mock('../onboarding/_helpers.js', async (original) => ({
  ...(await original<typeof import('../onboarding/_helpers.js')>()),
  loadPreviousStepOutput: async () => null,
}));
vi.mock('./_learning-feedback.js', () => ({
  recordLearningAccepted: async () => {},
}));
vi.mock('../_global-kb-promote.js', async (original) => ({
  ...(await original<typeof import('../_global-kb-promote.js')>()),
  clearTaskPromotedDrafts: async () => {},
}));
const { phase8LearningStep, readExistingLearnings } = await import('./11-phase-8-learning.js');

let worktree: string;
afterEach(async () => {
  if (worktree) await rm(worktree, { recursive: true, force: true });
});

async function deletedLearning(id = 'rule') {
  worktree = await mkdtemp(path.join(tmpdir(), 'learning-deletion-read-'));
  const learnings = path.join(worktree, '.haive-data/learnings');
  await mkdir(learnings, { recursive: true });
  await writeFile(path.join(learnings, `${id}.md`), '# Rule\n\nOriginal src/a.ts:7.');
  const ctx = {
    taskId: 'task-id',
    taskStepId: 'step-id',
    userId: 'user-id',
    round: 0,
    workspacePath: worktree,
    repoPath: worktree,
    db: {
      insert: () => ({ values: () => ({ onConflictDoNothing: async () => {} }) }),
    },
    logger: { info: vi.fn(), warn: vi.fn() },
  } as unknown as StepContext;
  const args = {
    detected: { existingLearnings: [], existingSkills: [], isBugFix: false },
    llmOutput: {
      entries: [
        {
          id,
          title: 'Rule',
          body: 'Correction src/a.ts:9.',
          op: 'update',
          targetId: id,
        },
        { op: 'delete', targetId: id },
      ],
    },
    llmInvocationId: 'invocation-id',
    formValues: {},
  } as unknown as StepApplyArgs<any>;
  const apply = () => phase8LearningStep.apply(ctx, args);
  await apply();
  expect(await readExistingLearnings(worktree)).toEqual([]);
  const root = path.join(worktree, '.haive/learning-deletions');
  const [applyId] = await readdir(root);
  const applyDir = path.join(root, applyId!);
  const [filename] = await readdir(applyDir);
  return { apply, applyDir, record: path.join(applyDir, filename!) };
}

describe('deletion recovery refuses unreadable intent on the real filesystem', () => {
  for (const fault of ['record link', 'unreadable record', 'apply directory link', '.haive link']) {
    // Root bypasses mode bits; the link controls also run in a root worker container.
    it.skipIf(fault === 'unreadable record' && process.getuid?.() === 0)(
      `fails apply without resurrecting a learning when intent has: ${fault}`,
      async () => {
        const { apply, applyDir, record } = await deletedLearning();
        if (fault === 'unreadable record') {
          await chmod(record, 0o000);
        } else {
          const target =
            fault === 'record link'
              ? record
              : fault === 'apply directory link'
                ? applyDir
                : path.join(worktree, '.haive');
          await rename(target, `${target}-original`);
          await symlink(`${target}-original`, target);
        }
        await expect(apply()).rejects.toMatchObject(
          fault === 'unreadable record'
            ? { code: 'EACCES' }
            : { code: 'EPATHCONTAINMENT', reason: 'link' },
        );
        expect(await readExistingLearnings(worktree)).toEqual([]);
      },
    );
  }
});

describe('deletion recovery validates stored target slugs', () => {
  it.each(['nested/rule', '../rule', '', '.', '..', 'a\\b', 'a\0b'])(
    'fails apply for the invalid stored id %j',
    async (id) => {
      const { apply, record } = await deletedLearning();
      const intent = JSON.parse(await readFile(record, 'utf8'));
      intent.target.id = id;
      await writeFile(record, JSON.stringify(intent));
      await expect(apply()).rejects.toMatchObject({
        issues: [expect.objectContaining({ path: ['target', 'id'] })],
      });
      expect(await readExistingLearnings(worktree)).toEqual([]);
    },
  );

  it.each([
    'rule-2',
    `${'a'.repeat(47)}-`,
    `${'a'.repeat(47)}--2`,
    'Auth_Notes',
    'BUSINESS_LOGIC',
    '-rule',
  ])('keeps accepting the learning id %j on replay', async (id) => {
    const { apply, record } = await deletedLearning(id);
    const intent = await readFile(record, 'utf8');
    await expect(apply()).resolves.toMatchObject({
      written: [`.haive-data/learnings/${id}.md`],
      deleted: [`.haive-data/learnings/${id}.md`],
    });
    expect(await readFile(record, 'utf8')).toBe(intent);
    expect(await readExistingLearnings(worktree)).toEqual([]);
  });
});
