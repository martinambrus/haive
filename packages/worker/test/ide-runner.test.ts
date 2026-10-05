import { describe, expect, it } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  resolveIdeWorkspaceSubpath,
  resolveRepoIdeWorkspaceSubpath,
} from '../src/sandbox/ide-runner.js';
import { ideRunnerName, ideUserDataVolumeName, repoIdeSessionId } from '@haive/shared';

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

describe('repository editor workspace', () => {
  function setup(overrides: Record<string, unknown> = {}) {
    const fake = createFakeDb({ repositories: schema.repositories });
    fake.insert(schema.repositories, {
      id: REPO,
      userId: USER,
      source: 'git_url',
      status: 'ready',
      storagePath: REPO_PATH,
      localPath: null,
      ...overrides,
    });
    return fake.db as unknown as Database;
  }

  it('opens the repository root without consulting any task or worktree', async () => {
    expect(await resolveRepoIdeWorkspaceSubpath(setup(), REPO, USER)).toBe(`${USER}/${REPO}`);
  });

  it('refuses a missing repository or another user’s repository', async () => {
    expect(await resolveRepoIdeWorkspaceSubpath(setup(), TASK, USER)).toBeNull();
    expect(await resolveRepoIdeWorkspaceSubpath(setup(), REPO, TASK)).toBeNull();
  });

  it.each([
    { status: 'cloning' },
    { storagePath: null },
    { source: 'local_path', writable: false },
    { storagePath: '/host-fs/project' },
  ])('refuses a workspace that cannot be edited: %j', async (overrides) => {
    expect(await resolveRepoIdeWorkspaceSubpath(setup(overrides), REPO, USER)).toBeNull();
  });

  it('opens a writable local import copied into the repository volume', async () => {
    expect(
      await resolveRepoIdeWorkspaceSubpath(
        setup({ source: 'local_path', writable: true }),
        REPO,
        USER,
      ),
    ).toBe(`${USER}/${REPO}`);
  });

  it('keeps repository containers and editor state separate from tasks and other repositories', () => {
    const otherRepo = REPO.slice(0, -1) + '2';
    const session = repoIdeSessionId(REPO);
    expect(ideRunnerName(session)).not.toBe(ideRunnerName(REPO));
    expect(ideRunnerName(session)).not.toBe(ideRunnerName(repoIdeSessionId(otherRepo)));
    expect(ideUserDataVolumeName(session)).not.toBe(ideUserDataVolumeName(REPO));
    expect(ideUserDataVolumeName(session)).not.toBe(
      ideUserDataVolumeName(repoIdeSessionId(otherRepo)),
    );
  });
});
