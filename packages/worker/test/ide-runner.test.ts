import { describe, expect, it } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { resolveIdeWorkspaceSubpath } from '../src/sandbox/ide-runner.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const TASK = '00000000-0000-4000-8000-000000000001';
const ROW = '00000000-0000-4000-8000-0000000000c1';

const REPO_PATH = `/var/lib/haive/repos/${USER}/${REPO}`;

describe('resolveIdeWorkspaceSubpath', () => {
  // ensureIdeRunnerStarted recreates the editor whenever this subpath differs from the one its
  // running container mounts.
  it('opens the worktree the task column names after a Retry reset the 01 output', async () => {
    const fake = createFakeDb({
      tasks: schema.tasks,
      taskSteps: schema.taskSteps,
      repositories: schema.repositories,
    });
    fake.insert(schema.repositories, {
      id: REPO,
      userId: USER,
      storagePath: REPO_PATH,
      localPath: null,
    });
    fake.insert(schema.tasks, {
      id: TASK,
      userId: USER,
      repositoryId: REPO,
      type: 'workflow',
      worktreePath: `${REPO_PATH}/.haive/worktrees/feature-x`,
    });
    fake.insert(schema.taskSteps, {
      id: ROW,
      taskId: TASK,
      stepId: '01-worktree-setup',
      round: 0,
      status: 'waiting_form',
      output: null,
    });

    const subpath = await resolveIdeWorkspaceSubpath(fake.db as unknown as Database, TASK);

    expect(subpath).toBe(`${USER}/${REPO}/.haive/worktrees/feature-x`);
  });
});
