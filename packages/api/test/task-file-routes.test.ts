import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { state } = vi.hoisted(() => ({
  state: {
    task: {} as Record<string, unknown>,
    repo: null as Record<string, unknown> | null,
  },
}));

// The routes take their db, and only two rows matter to them: the task (for the workspace and the
// worktree) and its repository (for the anchor). Same shape as `spawn-plan-task-seed.test.ts`.
vi.mock('../src/db.js', () => ({
  getDb: () => ({
    query: {
      tasks: { findFirst: async () => state.task },
      repositories: { findFirst: async () => state.repo },
    },
  }),
}));

import { Hono } from 'hono';
import { fileRoutes } from '../src/routes/tasks/files.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const TASK = 'task-1';
const USER = 'user-1';

// `requireAuth` is what sets `userId` in the real app, and Hono's third `request()` argument is
// the Env rather than the context vars, so the routes are mounted under a middleware that sets it
// — with the api's own error handler, so a route's HttpError is rendered as its real status.
const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  c.set('userId', USER);
  await next();
});
app.route('/', fileRoutes);
app.onError(errorHandler);

async function get(route: string, query: Record<string, string> = {}): Promise<Response> {
  const qs = new URLSearchParams(query).toString();
  return await app.request(`/${TASK}${route}${qs ? `?${qs}` : ''}`);
}

/**
 * The three read routes, against a real tree.
 *
 * The api runs as root over a volume that repositories and sandboxed agents write, so what these
 * routes must never do is serve a file through a link — and what they must keep doing is serve the
 * repository's own files, including through a worktree, which is where every task's workspace is.
 */
describe('task file read routes', () => {
  let storage: string;
  let repo: string;
  let worktree: string;
  let outside: string;

  beforeEach(async () => {
    storage = await mkdtemp(path.join(tmpdir(), 'files-routes-'));
    outside = await mkdtemp(path.join(tmpdir(), 'files-out-'));
    repo = path.join(storage, USER, 'repo-1');
    worktree = path.join(repo, '.haive', 'worktrees', 'wt');
    await mkdir(path.join(worktree, 'src'), { recursive: true });
    await writeFile(path.join(worktree, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
    await writeFile(path.join(worktree, 'README.md'), '# readme\n', 'utf8');
    await writeFile(path.join(outside, 'secret.md'), 'elsewhere\n', 'utf8');
    await symlink(path.join(outside, 'secret.md'), path.join(worktree, 'link.md'));
    await symlink(outside, path.join(worktree, 'linkdir'));

    state.task = {
      id: TASK,
      userId: USER,
      repositoryId: 'repo-1',
      worktreePath: worktree,
      type: 'workflow',
      metadata: {},
    };
    state.repo = { storagePath: repo, localPath: null, source: 'clone', writable: true };
  });

  afterEach(async () => {
    await rm(storage, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  describe('GET /files', () => {
    it('lists the workspace, with a link as neither file nor directory', async () => {
      const res = await get('/files');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        root: string;
        entries: { name: string; isDirectory: boolean; size: number | null }[];
      };
      expect(body.root).toBe(worktree);
      const byName = new Map(body.entries.map((e) => [e.name, e]));
      expect([...byName.keys()].sort()).toEqual(['README.md', 'link.md', 'linkdir', 'src']);
      expect(byName.get('README.md')).toMatchObject({ isDirectory: false, size: 9 });
      expect(byName.get('src')).toMatchObject({ isDirectory: true, size: null });
      // Neither the link's target size nor a directory: the listing describes the link itself.
      expect(byName.get('link.md')).toMatchObject({ isDirectory: false, size: null });
      expect(byName.get('linkdir')).toMatchObject({ isDirectory: false, size: null });
    });

    it('refuses a directory reached through a link, and one outside the workspace', async () => {
      expect((await get('/files', { path: path.join(worktree, 'linkdir') })).status).toBe(403);
      expect((await get('/files', { path: outside })).status).toBe(403);
    });
  });

  describe('GET /files/content', () => {
    it('returns a text file', async () => {
      const res = await get('/files/content', { path: path.join(worktree, 'src', 'a.ts') });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        binary: false,
        truncated: false,
        content: 'export const a = 1;\n',
      });
    });

    it('refuses a link, a path through a linked directory, and one outside', async () => {
      expect((await get('/files/content', { path: path.join(worktree, 'link.md') })).status).toBe(
        403,
      );
      expect(
        (await get('/files/content', { path: path.join(worktree, 'linkdir', 'secret.md') })).status,
      ).toBe(403);
      expect((await get('/files/content', { path: path.join(outside, 'secret.md') })).status).toBe(
        403,
      );
    });

    it('404s a missing file and 400s a directory', async () => {
      expect((await get('/files/content', { path: path.join(worktree, 'nope.md') })).status).toBe(
        404,
      );
      expect((await get('/files/content', { path: path.join(worktree, 'src') })).status).toBe(400);
    });
  });

  describe('GET /files/raw', () => {
    it('streams the file with its own length', async () => {
      const res = await get('/files/raw', { path: path.join(worktree, 'README.md') });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-length')).toBe('9');
      await expect(res.text()).resolves.toBe('# readme\n');
    });

    it('refuses a link and serves nothing from outside the workspace', async () => {
      expect((await get('/files/raw', { path: path.join(worktree, 'link.md') })).status).toBe(403);
      expect((await get('/files/raw', { path: path.join(outside, 'secret.md') })).status).toBe(403);
    });
  });

  it('refuses every route once the worktree directory is itself a link', async () => {
    await rm(worktree, { recursive: true, force: true });
    await symlink(outside, worktree);
    expect((await get('/files')).status).toBe(403);
    expect((await get('/files/content', { path: path.join(worktree, 'secret.md') })).status).toBe(
      403,
    );
    expect((await get('/files/raw', { path: path.join(worktree, 'secret.md') })).status).toBe(403);
  });
});
