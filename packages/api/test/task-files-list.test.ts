import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { state } = vi.hoisted(() => ({
  state: {
    task: {} as Record<string, unknown>,
    repo: null as Record<string, unknown> | null,
  },
}));

vi.mock('../src/db.js', () => ({
  getDb: () => ({
    query: {
      tasks: { findFirst: async () => state.task },
      repositories: { findFirst: async () => state.repo },
      taskSteps: { findFirst: async () => undefined },
    },
  }),
}));
vi.mock('@haive/shared/fs-safe', async (original) => {
  const actual = await original<typeof import('@haive/shared/fs-safe')>();
  return {
    ...actual,
    lstatNoFollow: vi.fn(actual.lstatNoFollow),
    readdirSizesNoFollow: vi.fn(actual.readdirSizesNoFollow),
  };
});
import { lstatNoFollow, readdirSizesNoFollow } from '@haive/shared/fs-safe';
import { Hono } from 'hono';
import { fileRoutes } from '../src/routes/tasks/files.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const TASK = 'task-1';
const USER = 'user-1';
const run = promisify(execFile);

const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  c.set('userId', USER);
  await next();
});
app.route('/', fileRoutes);
app.onError(errorHandler);

let storage: string;
let outside: string;
let worktree: string;

beforeEach(async () => {
  storage = await mkdtemp(path.join(tmpdir(), 'files-list-'));
  outside = await mkdtemp(path.join(tmpdir(), 'files-list-out-'));
  const repo = path.join(storage, USER, 'repo-1');
  worktree = path.join(repo, '.haive', 'worktrees', 'wt');
  await mkdir(path.join(worktree, 'src'), { recursive: true });
  await writeFile(path.join(worktree, '.hidden'), 'abc');
  await writeFile(path.join(worktree, 'a.txt'), 'hello');
  await writeFile(path.join(worktree, 'B.md'), '');
  await writeFile(path.join(outside, 'secret'), 'elsewhere');
  await symlink(path.join(outside, 'secret'), path.join(worktree, 'link-file'));
  await symlink(outside, path.join(worktree, 'link-dir'));
  await run('mkfifo', [path.join(worktree, 'pipe')]);
  state.task = {
    id: TASK,
    userId: USER,
    repositoryId: 'repo-1',
    worktreePath: worktree,
    type: 'workflow',
    metadata: {},
  };
  state.repo = { storagePath: repo, localPath: null, source: 'clone', writable: true };
  vi.mocked(lstatNoFollow).mockClear();
  vi.mocked(readdirSizesNoFollow).mockClear();
});

afterEach(async () => {
  await rm(storage, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

it('lists a workspace directory with the entries, sizes and order it always had', async () => {
  const res = await app.request(`/${TASK}/files`);

  expect(res.status).toBe(200);
  const entry = (name: string, isDirectory: boolean, size: number | null) => ({
    name,
    path: path.join(worktree, name),
    isDirectory,
    hidden: name.startsWith('.'),
    size,
  });
  expect(await res.json()).toEqual({
    path: worktree,
    parent: null,
    root: worktree,
    entries: [
      entry('src', true, null),
      entry('.hidden', false, 3),
      entry('a.txt', false, 5),
      entry('B.md', false, 0),
      // A link, a FIFO: neither file nor directory, so no size (a link's target is never read).
      entry('link-dir', false, null),
      entry('link-file', false, null),
      entry('pipe', false, null),
    ],
  });
});

it('reads the sizes through the listed directory, not by resolving each file from the anchor', async () => {
  const res = await app.request(`/${TASK}/files`);

  expect(res.status).toBe(200);
  // Resolving the workspace stats the worktree once; the three regular files must add none.
  expect(vi.mocked(lstatNoFollow).mock.calls.length).toBeLessThanOrEqual(1);
});

// The process's own condition, so the api's 500: a 400 would blame the path the client asked for.
it.each(['EMFILE', 'ENFILE'])(
  'answers 500, never a client error or a list with null sizes, when the listing fails with %s',
  async (code) => {
    vi.mocked(readdirSizesNoFollow).mockRejectedValueOnce(
      Object.assign(new Error(`${code}: too many open files`), { code }),
    );

    const res = await app.request(`/${TASK}/files`);

    expect(res.status).toBe(500);
    expect(await res.json()).not.toHaveProperty('entries');
  },
);
