import { chmod, mkdtemp, readdir, rename, rm, symlink } from 'node:fs/promises';
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
const { applyLearningOps, phase8LearningStep, planLearningReconciliation, readExistingLearnings } =
  await import('./11-phase-8-learning.js');

let worktree: string;
afterEach(async () => {
  if (worktree) await rm(worktree, { recursive: true, force: true });
});

async function deletedLearning() {
  worktree = await mkdtemp(path.join(tmpdir(), 'learning-deletion-read-'));
  await applyLearningOps(
    worktree,
    planLearningReconciliation(
      [{ id: 'rule', title: 'Rule', body: 'Original src/a.ts:7.', op: 'insert' }],
      [],
    ),
    undefined,
    { taskId: 'original-task', date: '2026-11-14T01:02:03.000Z' },
  );
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
          id: 'rule',
          title: 'Rule',
          body: 'Correction src/a.ts:9.',
          op: 'update',
          targetId: 'rule',
        },
        { op: 'delete', targetId: 'rule' },
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
