import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { SANDBOX_WORKDIR } from '../../sandbox/sandbox-runner.js';
import { worktreeDirName, sandboxWorktreePath } from '../../repo/worktree-paths.js';
import {
  makePointerFixture,
  pointerDb,
  POINTER_BRANCH,
  type PointerFixture,
} from '../../../test/support/worktree-pointer-db.js';
import { resolveTaskSandboxWorkdir } from './resolvers.js';

vi.hoisted(() => {
  process.env.REPO_STORAGE_ROOT = `${process.env.TMPDIR ?? '/tmp'}/wt-pointer-workdir-${process.pid}-${Math.random().toString(36).slice(2)}`;
});

function mkDb(stepOutput: unknown, worktreeBranch: string | null): Database {
  return {
    query: {
      taskSteps: { findFirst: async () => (stepOutput ? { output: stepOutput } : undefined) },
      tasks: { findFirst: async () => ({ worktreeBranch }) },
    },
  } as unknown as Database;
}

describe('worktree path naming', () => {
  it('flattens a namespaced branch into one directory level', () => {
    expect(worktreeDirName('feature/add-ddev-environment')).toBe('feature-add-ddev-environment');
    expect(sandboxWorktreePath('/haive/workdir', 'fix/a/b')).toBe(
      '/haive/workdir/.haive/worktrees/fix-a-b',
    );
  });
});

describe('resolveTaskSandboxWorkdir', () => {
  it('uses the step output when present', async () => {
    const db = mkDb({ sandboxWorktreePath: '/haive/workdir/.haive/worktrees/feat' }, null);
    expect(await resolveTaskSandboxWorkdir(db, 't1')).toBe('/haive/workdir/.haive/worktrees/feat');
  });

  // A Retry cascade nulls the step output while the worktree stays on disk. Falling
  // through to the repo root would run the agent in the PARENT checkout.
  it('rebuilds the path from the task row when the step output was reset', async () => {
    const db = mkDb(null, 'feature/add-ddev-environment');
    expect(await resolveTaskSandboxWorkdir(db, 't1')).toBe(
      '/haive/workdir/.haive/worktrees/feature-add-ddev-environment',
    );
  });

  it('falls back to the repo root when no worktree was ever created', async () => {
    const db = mkDb(null, null);
    expect(await resolveTaskSandboxWorkdir(db, 't1')).toBe(SANDBOX_WORKDIR);
  });
});

// The Terminal's cwd must follow the worktree the task works in NOW, not the one the audit columns
// remember.
describe('resolveTaskSandboxWorkdir against a recorded worktree pointer', () => {
  const FEATURE_CWD = '/haive/workdir/.haive/worktrees/feature-x';
  let fx: PointerFixture;
  beforeEach(async () => {
    fx = await makePointerFixture();
  });
  afterEach(async () => {
    await fx.cleanup();
  });

  const repo = () => ({ source: 'clone', storagePath: fx.repoRoot, localPath: null });
  const recorded = () => ({ worktreeBranch: POINTER_BRANCH, worktreePath: fx.worktreePath });

  // C2 (#214)
  it('C2 opens the sandbox root when the latest 01 round is skipped', async () => {
    await fx.mkWorktree();
    const db = pointerDb({
      task: recorded(),
      repo: repo(),
      steps: [{ status: 'skipped', output: null }],
    });
    expect(await resolveTaskSandboxWorkdir(db, 't1')).toBe(SANDBOX_WORKDIR);
  });

  // C4 (#221): 01 is done and still carries sandboxWorktreePath, the directory is gone.
  it('C4 refuses a worktree whose directory was removed', async () => {
    const db = pointerDb({
      task: recorded(),
      repo: repo(),
      steps: [
        {
          status: 'done',
          output: {
            mode: 'worktree',
            worktreePath: fx.worktreePath,
            branchName: POINTER_BRANCH,
            sandboxWorktreePath: FEATURE_CWD,
          },
        },
      ],
    });
    await expect(resolveTaskSandboxWorkdir(db, 't1')).rejects.toThrow(/worktree.*removed/is);
  });

  // G2
  it('G2 keeps the worktree for a Retry state (output null, 01 not skipped, directory present)', async () => {
    await fx.mkWorktree();
    const db = pointerDb({
      task: recorded(),
      repo: repo(),
      steps: [{ status: 'waiting_form', output: null }],
    });
    expect(await resolveTaskSandboxWorkdir(db, 't1')).toBe(FEATURE_CWD);
  });

  // G4
  it('G4 opens the sandbox root when no worktree was ever recorded', async () => {
    const db = pointerDb({
      task: { worktreeBranch: null, worktreePath: null },
      repo: repo(),
      steps: [],
    });
    expect(await resolveTaskSandboxWorkdir(db, 't1')).toBe(SANDBOX_WORKDIR);
  });
});

// p2: a local-path repository (storagePath null) keeps its worktrees under its own localPath.
describe('resolveTaskSandboxWorkdir against a local-path repository', () => {
  const FEATURE_CWD = '/haive/workdir/.haive/worktrees/feature-x';
  let localPath: string;
  beforeEach(async () => {
    localPath = await mkdtemp(path.join(tmpdir(), 'wt-localpath-workdir-'));
  });
  afterEach(async () => {
    await rm(localPath, { recursive: true, force: true });
  });

  const wtDir = () => path.join(localPath, '.haive', 'worktrees', 'feature-x');
  const db = () =>
    pointerDb({
      task: { worktreeBranch: POINTER_BRANCH, worktreePath: wtDir() },
      repo: { source: 'local', storagePath: null, localPath },
      steps: [{ status: 'done', output: null }],
    });

  it('P2 answers the worktree sandbox path when its directory exists under localPath', async () => {
    await mkdir(wtDir(), { recursive: true });
    expect(await resolveTaskSandboxWorkdir(db(), 't1')).toBe(FEATURE_CWD);
  });

  it('P2 still refuses a worktree whose directory is absent under localPath', async () => {
    await expect(resolveTaskSandboxWorkdir(db(), 't1')).rejects.toThrow(/worktree.*removed/is);
  });

  it('P2 refuses a worktree directory that is a link as not a directory, not as removed', async () => {
    await mkdir(path.dirname(wtDir()), { recursive: true });
    await symlink(tmpdir(), wtDir());
    const err = await resolveTaskSandboxWorkdir(db(), 't1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).not.toBe('WorktreeRemovedError');
    expect((err as Error).message).toMatch(/not a directory/i);
  });
});
