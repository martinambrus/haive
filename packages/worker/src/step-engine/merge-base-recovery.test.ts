import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { schema, type Database, type MergeResolveState } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { logger } from '@haive/shared/logger';
import { claimFake, mergeDirClaimOverrides } from '../../test/merge-dir-claim-fake.js';
import { gitTemplate } from '../../test/support/git-template.js';
import { resolveMergePhase } from './merge-resolver.js';
import type { StepContext, StepDefinition } from './step-definition.js';
import type { AdvanceStepParams, TaskStepRow } from './step-runner.js';

const h = vi.hoisted(() => ({ crashAfterMerge: false }));
vi.mock('./merge-dir-claim.js', async (original) => ({
  ...(await original<typeof import('./merge-dir-claim.js')>()),
  ...mergeDirClaimOverrides(),
}));
vi.mock('../repo/git-push.js', async (original) => {
  const actual = await original<typeof import('../repo/git-push.js')>();
  return {
    ...actual,
    gitRun: async (...args: Parameters<typeof actual.gitRun>) => {
      const result = await actual.gitRun(...args);
      if (h.crashAfterMerge && args[1][0] === 'merge' && result.code === 0) {
        h.crashAfterMerge = false;
        throw new Error('worker died after merge before state save');
      }
      return result;
    },
  };
});
const exec = promisify(execFile);
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@test.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@test.local',
};
async function git(dir: string, ...args: string[]) {
  return (await exec('git', args, { cwd: dir, env })).stdout.trim();
}
const template = gitTemplate(async (dir) => {
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'gc.auto', '0');
  await git(dir, 'config', 'maintenance.auto', 'false');
  await writeFile(path.join(dir, 'base'), 'base\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'base');
  const before = await git(dir, 'rev-parse', 'HEAD');
  await git(dir, 'switch', '-c', 'feature');
  await writeFile(path.join(dir, 'feature'), 'feature\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'feature');
  const feature = await git(dir, 'rev-parse', 'HEAD');
  await git(dir, 'switch', 'main');
  return { before, feature };
});

describe('T316 member 5 crash window', () => {
  it('re-enters pending after a landed merge with no saved base, preserving the work exactly once', async () => {
    claimFake.reset();
    const { dir, data } = await template.copy();
    const fake = createFakeDb({
      taskSteps: schema.taskSteps,
      tasks: schema.tasks,
      users: schema.users,
      taskDagIssues: schema.taskDagIssues,
      taskEvents: schema.taskEvents,
    });
    const taskId = randomUUID();
    const stepId = randomUUID();
    const userId = randomUUID();
    const state: MergeResolveState = {
      phase: 'pending',
      mode: 'same-branch',
      baseBranch: 'main',
      featureBranch: 'feature',
      mergeDir: dir,
      sandboxMergeDir: '/workspace',
      fixInvocationId: null,
      conflictRetries: 0,
      pendingQuestion: null,
      pushAfterMerge: false,
      squashAfterMerge: true,
      merged: false,
      skipReason: null,
      pushed: false,
      mergeStage: 'feature',
      baseSyncRounds: 0,
    };
    fake.insert(schema.tasks, { id: taskId, userId, status: 'running', repositoryId: null });
    fake.insert(schema.taskSteps, {
      id: stepId,
      taskId,
      status: 'running',
      mergeResolveState: state,
    });
    const db = fake.db as unknown as Database;
    const step = {
      metadata: { id: '12-worktree-cleanup' },
      mergeResolve: { selectedMerge: () => true, squashable: true },
    } as unknown as StepDefinition;
    const ctx: StepContext = {
      userId,
      taskId,
      taskStepId: stepId,
      repoPath: dir,
      workspacePath: dir,
      sandboxWorkdir: '/workspace',
      cliProviderId: null,
      round: 0,
      db,
      logger: logger as unknown as StepContext['logger'],
      signal: new AbortController().signal,
      emitProgress: async () => {},
      throwIfCancelled: () => {},
    };
    const params = { taskId, stepDef: step } as AdvanceStepParams;
    const run = () =>
      resolveMergePhase(
        db,
        step,
        structuredClone(fake.rows(schema.taskSteps)[0]) as unknown as TaskStepRow,
        ctx,
        params,
      );
    h.crashAfterMerge = true;
    await expect(run()).rejects.toThrow('worker died after merge before state save');
    expect(fake.rows(schema.taskSteps)[0]?.mergeResolveState).toEqual(state);
    const landed = await git(dir, 'rev-parse', 'HEAD');
    expect(await git(dir, 'rev-list', '--parents', '-n', '1', 'HEAD')).toBe(
      `${landed} ${data.before} ${data.feature}`,
    );
    const tree = await git(dir, 'rev-parse', 'HEAD^{tree}');
    const reflog = await git(dir, 'reflog', '--format=%H %gs');
    // New invocation has only the durable pre-crash row and the real on-disk Git state.
    const recovered = await run();
    expect(recovered.resolved).toBe(true);
    // Known limitation filed on the board as T785: replay preserves content once, but
    // silently keeps unsquashed history, omits merge.landed, and records the wrong undo base.
    // A T785 fix should change these expectations.
    expect(fake.rows(schema.taskEvents).filter((row) => row.eventType === 'merge.landed')).toEqual(
      [],
    );
    expect(fake.rows(schema.taskSteps)[0]?.mergeResolveState).toMatchObject({
      phase: 'done',
      baseShaBefore: landed,
      squashCommitSha: null,
    });
    expect(await git(dir, 'rev-parse', 'HEAD')).toBe(landed);
    expect(await git(dir, 'rev-parse', 'HEAD^{tree}')).toBe(tree);
    expect(await git(dir, 'show', 'HEAD:feature')).toBe('feature');
    expect(await git(dir, 'rev-list', '--count', 'HEAD')).toBe('3');
    expect(await git(dir, 'status', '--porcelain')).toBe('');
    expect(await git(dir, 'reflog', '--format=%H %gs')).toBe(reflog);
    expect(claimFake.claims.has(dir)).toBe(false);
  });
});
