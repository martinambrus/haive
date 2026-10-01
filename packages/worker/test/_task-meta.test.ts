import { describe, expect, it } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { resolveDdevWorkspace } from '../src/step-engine/steps/workflow/_task-meta.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const OTHER_REPO = '00000000-0000-4000-8000-0000000000b2';
const TASK = '00000000-0000-4000-8000-000000000001';
const ROW = '00000000-0000-4000-8000-0000000000c1';

const REPO_PATH = `/var/lib/haive/repos/${USER}/${REPO}`;
const WORKTREE = `${REPO_PATH}/.haive/worktrees/feature-x`;
const NEWER_WORKTREE = `${REPO_PATH}/.haive/worktrees/feature-y`;
const OUTSIDE = `/var/lib/haive/repos/${USER}/${OTHER_REPO}/.haive/worktrees/feature-x`;
const ROOT_SUBPATH = `${USER}/${REPO}`;
const WORKTREE_SUBPATH = `${ROOT_SUBPATH}/.haive/worktrees/feature-x`;
const NEWER_SUBPATH = `${ROOT_SUBPATH}/.haive/worktrees/feature-y`;

const appliedOutput = (worktreePath: string) => ({
  mode: 'worktree',
  worktreePath,
  sandboxWorktreePath: '/haive/workdir/.haive/worktrees/feature-x',
  branchName: 'feature/x',
  baseBranch: 'main',
});

interface State {
  task?: Record<string, unknown>;
  step?: { status: string; output: unknown };
}

/** `tasks.worktree_path` is stamped by 01's apply; a Retry that resets 01 clears the step row's
 *  output, not the task row. */
function resolve(state: State) {
  const fake = createFakeDb({ tasks: schema.tasks, taskSteps: schema.taskSteps });
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    repositoryId: REPO,
    worktreePath: null,
    ...state.task,
  });
  if (state.step) {
    fake.insert(schema.taskSteps, {
      id: ROW,
      taskId: TASK,
      stepId: '01-worktree-setup',
      round: 0,
      ...state.step,
    });
  }
  return resolveDdevWorkspace(fake.db as unknown as Database, TASK, REPO_PATH);
}

describe('resolveDdevWorkspace', () => {
  describe('a worktree named by the task row', () => {
    it.each(['waiting_form', 'pending', 'running', 'failed'])(
      'is the workspace while the 01 row is %s with its output reset',
      async (status) => {
        const ws = await resolve({
          task: { worktreePath: WORKTREE },
          step: { status, output: null },
        });
        expect(ws).toMatchObject({ workspace: WORKTREE, repoSubpath: WORKTREE_SUBPATH });
      },
    );

    it('is the workspace when the 01 output still names an older worktree', async () => {
      const ws = await resolve({
        task: { worktreePath: NEWER_WORKTREE },
        step: { status: 'done', output: appliedOutput(WORKTREE) },
      });
      expect(ws).toMatchObject({ workspace: NEWER_WORKTREE, repoSubpath: NEWER_SUBPATH });
    });
  });

  describe('the other states of a task', () => {
    it("keeps the repository root when the 01 row was skipped (run_app's Skip)", async () => {
      const ws = await resolve({
        task: { worktreePath: WORKTREE },
        step: { status: 'skipped', output: null },
      });
      expect(ws).toMatchObject({ workspace: REPO_PATH, repoSubpath: ROOT_SUBPATH });
    });

    it('reads the 01 output for a task from before the column existed', async () => {
      const ws = await resolve({ step: { status: 'done', output: appliedOutput(WORKTREE) } });
      expect(ws).toMatchObject({ workspace: WORKTREE, repoSubpath: WORKTREE_SUBPATH });
    });

    it('answers that worktree when the column and the output agree', async () => {
      const ws = await resolve({
        task: { worktreePath: WORKTREE },
        step: { status: 'done', output: appliedOutput(WORKTREE) },
      });
      expect(ws).toMatchObject({ workspace: WORKTREE, repoSubpath: WORKTREE_SUBPATH });
    });

    const NOTHING: [string, State][] = [
      ['a reset 01 output', { step: { status: 'waiting_form', output: null } }],
      ['a legacy in-place 01 output', { step: { status: 'done', output: { mode: 'inplace' } } }],
      ['no 01 row', {}],
    ];
    it.each(NOTHING)('answers the repository root for %s and no column', async (_name, state) => {
      const ws = await resolve(state);
      expect(ws).toMatchObject({ workspace: REPO_PATH, repoSubpath: ROOT_SUBPATH });
    });

    it('answers null for a task with no repository, whatever the column holds', async () => {
      expect(await resolve({ task: { repositoryId: null, worktreePath: WORKTREE } })).toBeNull();
    });

    it('answers null for a task that does not exist', async () => {
      const fake = createFakeDb({ tasks: schema.tasks, taskSteps: schema.taskSteps });
      const ws = await resolveDdevWorkspace(fake.db as unknown as Database, TASK, REPO_PATH);
      expect(ws).toBeNull();
    });
  });

  describe('a worktree outside the repository root', () => {
    // A subpath carrying `..` would address another repository's tree on the shared volume.
    const OUTSIDE_CASES: [string, State][] = [
      [
        'the task column',
        { task: { worktreePath: OUTSIDE }, step: { status: 'waiting_form', output: null } },
      ],
      ['the 01 output', { step: { status: 'done', output: appliedOutput(OUTSIDE) } }],
    ];
    it.each(OUTSIDE_CASES)('is left out of the subpath when %s names it', async (_name, state) => {
      const ws = await resolve(state);
      expect(ws?.repoSubpath).toBe(ROOT_SUBPATH);
    });
    // `classifyRuntime` reads `.ddev/config.yaml` under the workspace, so it must be the root too.
    it.each(OUTSIDE_CASES)(
      'is left out of the workspace when %s names it',
      async (_name, state) => {
        const ws = await resolve(state);
        expect(ws?.workspace).toBe(REPO_PATH);
      },
    );
  });
});
