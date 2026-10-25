import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  CODE_SERVER_IMAGE,
  SHARED_VOLUME,
  ideRunnerName,
  repoIdeSessionId,
  volumeName,
} from '@haive/shared';

const h = vi.hoisted(() => ({ exec: vi.fn(), boundary: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: h.exec }) };
});
vi.mock('../src/sandbox/sandbox-core-image.js', () => ({ ensureSandboxCoreImage: async () => {} }));
vi.mock('../src/queues/cli-exec/gitfile-mask.js', () => ({ repoGitDataBoundary: h.boundary }));
vi.mock('../src/sandbox/docker-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/docker-runner.js')>()),
  defaultDockerRunner: {
    volumeExists: async () => true,
    run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  },
}));

import { ensureIdeRunnerStarted, ensureRepoIdeRunnerStarted } from '../src/sandbox/ide-runner.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const SUBPATH = `${USER}/${REPO}`;

beforeEach(() => {
  h.exec.mockReset().mockImplementation(async (_command, args: string[]) => {
    if (args[0] === 'inspect') throw new Error('container missing');
    return { stdout: '{"status":"alive"}', stderr: '' };
  });
  h.boundary.mockReset().mockResolvedValue({
    mounts: [
      {
        source: volumeName(SHARED_VOLUME.repos),
        target: '/workspace/.git',
        subpath: `${SUBPATH}/.git`,
        readOnly: true,
      },
    ],
  });
});

describe('repository editor launch', () => {
  it('mounts only the repository checkout writable and protects its git data', async () => {
    const fake = createFakeDb({ repositories: schema.repositories });
    fake.insert(schema.repositories, {
      id: REPO,
      userId: USER,
      source: 'git_url',
      status: 'ready',
      storagePath: `/var/lib/haive/repos/${SUBPATH}`,
    });
    const db = fake.db as unknown as Database;
    const [first, second] = await Promise.all([
      ensureRepoIdeRunnerStarted(db, REPO, USER, '{}'),
      ensureRepoIdeRunnerStarted(db, REPO, USER, '{}'),
    ]);
    expect(first).toEqual({ container: ideRunnerName(repoIdeSessionId(REPO)) });
    expect(second).toEqual(first);
    const runs = h.exec.mock.calls.filter(([, args]) => args[0] === 'run' && args[1] === '-d');
    expect(runs).toHaveLength(1);
    const args = runs[0]![1] as string[];
    const mounts = args.filter((_arg, index) => args[index - 1] === '--mount');
    expect(mounts).toEqual([
      `type=volume,source=${volumeName(SHARED_VOLUME.repos)},destination=/workspace/.git,volume-subpath=${SUBPATH}/.git,volume-nocopy=true,readonly`,
      `type=volume,source=${volumeName(SHARED_VOLUME.repos)},destination=/workspace,volume-subpath=${SUBPATH},volume-nocopy=true`,
    ]);
    expect(args.indexOf(CODE_SERVER_IMAGE)).toBeGreaterThan(-1);
    expect(args.indexOf('--disable-proxy')).toBeGreaterThan(args.indexOf(CODE_SERVER_IMAGE));
    expect(args.slice(args.indexOf('--disable-proxy'))).toEqual(['--disable-proxy', '/workspace']);
    expect(args).toContain(`haive.repo.id=${REPO}`);
    expect(args.some((arg) => arg.startsWith('haive.task.id='))).toBe(false);
    expect(h.boundary).toHaveBeenCalledWith(
      { source: volumeName(SHARED_VOLUME.repos), target: '/workspace', subpath: SUBPATH },
      { hasWorktree: false, hasRepo: true },
    );
  });
});

describe('task editor launch', () => {
  it('passes --disable-proxy to code-server after the Docker image', async () => {
    const taskId = '00000000-0000-4000-8000-0000000000c1';
    const fake = createFakeDb({
      repositories: schema.repositories,
      tasks: schema.tasks,
      taskSteps: schema.taskSteps,
    });
    fake.insert(schema.repositories, {
      id: REPO,
      userId: USER,
      storagePath: `/var/lib/haive/repos/${SUBPATH}`,
    });
    fake.insert(schema.tasks, { id: taskId, userId: USER, repositoryId: REPO, type: 'workflow' });
    expect(
      await ensureIdeRunnerStarted(fake.db as unknown as Database, taskId, USER, '{}'),
    ).toEqual({ container: ideRunnerName(taskId) });
    const runs = h.exec.mock.calls.filter(([, args]) => args[0] === 'run' && args[1] === '-d');
    expect(runs).toHaveLength(1);
    const args = runs[0]![1] as string[];
    expect(args).toContain(`haive.task.id=${taskId}`);
    expect(args.indexOf(CODE_SERVER_IMAGE)).toBeGreaterThan(-1);
    expect(args.indexOf('--disable-proxy')).toBeGreaterThan(args.indexOf(CODE_SERVER_IMAGE));
    expect(args.slice(args.indexOf('--disable-proxy'))).toEqual(['--disable-proxy', '/workspace']);
  });
});
