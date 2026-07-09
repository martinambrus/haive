import { describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import { SANDBOX_WORKDIR } from '../../sandbox/sandbox-runner.js';
import { worktreeDirName, sandboxWorktreePath } from '../../repo/worktree-paths.js';
import { resolveTaskSandboxWorkdir } from './resolvers.js';

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
