import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ db: undefined as unknown }));
const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set(key: string, value: string): void }, next: () => unknown) => {
    c.set('userId', '00000000-0000-4000-8000-0000000000a1');
    await next();
  },
}));
import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { hardenGitArgs } from '@haive/shared/git-args';
import { ensureDirNoFollow } from '@haive/shared/fs-safe';
import { repoRoutes } from '../src/routes/repos.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';
const exec = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const git = async (cwd: string, args: string[]) =>
  (await exec('git', hardenGitArgs(args), { cwd })).stdout.trim();
async function setup(nested = false) {
  const root = await mkdtemp(path.join(tmpdir(), 't417-api-'));
  dirs.push(root);
  await git(root, ['init']);
  await git(root, ['remote', 'add', 'origin', 'https://old.test/r']);
  const fake = createFakeDb({ repositories: schema.repositories });
  if (nested) await ensureDirNoFollow(root, 'nested');
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: 'repo',
    localPath: nested ? `${root}/nested` : root,
    remoteUrl: null,
  });
  h.db = fake.db;
  const app = new Hono<AppEnv>();
  app.route('/', repoRoutes);
  app.onError(errorHandler);
  const link = () =>
    app.request(`/${REPO}/remote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remoteUrl: 'https://new.test/r' }),
    });
  return { root, fake, link };
}
it('relink clears planted push URLs and extra fetch URLs in real git', async () => {
  const { root, link, fake } = await setup();
  await git(root, ['config', '--add', 'remote.origin.url', 'https://extra.test/r']);
  await git(root, ['config', '--add', 'remote.origin.pushurl', 'https://planted.test/r']);
  await git(root, ['config', '--add', 'remote.origin.pushurl', 'https://planted2.test/r']);
  const response = await link();
  expect(response.status, await response.text()).toBe(200);
  expect(await git(root, ['remote', 'get-url', '--all', 'origin'])).toBe('https://new.test/r');
  expect(await git(root, ['remote', 'get-url', '--push', '--all', 'origin'])).toBe(
    'https://new.test/r',
  );
  expect(fake.rows(schema.repositories)[0]!.remoteUrl).toBe('https://new.test/r');
});
it('does not relink the parent of a nested non-repository', async () => {
  const { root, link, fake } = await setup(true);
  expect((await link()).status).toBe(409);
  expect(await git(root, ['remote', 'get-url', 'origin'])).toBe('https://old.test/r');
  expect(fake.rows(schema.repositories)[0]!.remoteUrl).toBeNull();
});
it('relinks a nested directory when it has its own repository', async () => {
  const { root, link } = await setup(true);
  await git(`${root}/nested`, ['init']);
  const response = await link();
  expect(response.status, await response.text()).toBe(200);
  expect(await git(`${root}/nested`, ['remote', 'get-url', 'origin'])).toBe('https://new.test/r');
  expect(await git(root, ['remote', 'get-url', 'origin'])).toBe('https://old.test/r');
});

it('does not discover a parent through an empty .git directory', async () => {
  const { root, link, fake } = await setup(true);
  await ensureDirNoFollow(root, 'nested/.git');
  expect((await link()).status).toBe(409);
  expect(await git(root, ['remote', 'get-url', 'origin'])).toBe('https://old.test/r');
  expect(fake.rows(schema.repositories)[0]!.remoteUrl).toBeNull();
});
it.each(['worktree', 'submodule'])('links its own %s gitfile', async (kind) => {
  const { root, link } = await setup(true);
  await git(root, [
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@example.test',
    'commit',
    '--allow-empty',
    '-m',
    'seed',
  ]);
  if (kind === 'worktree') {
    await ensureDirNoFollow(root, 'owner');
    await git(`${root}/owner`, ['init']);
    await git(`${root}/owner`, [
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@example.test',
      'commit',
      '--allow-empty',
      '-m',
      'seed',
    ]);
    await git(`${root}/owner`, ['worktree', 'add', '--detach', `${root}/nested`]);
  } else {
    await git(`${root}/nested`, ['init']);
    await git(`${root}/nested`, [
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@example.test',
      'commit',
      '--allow-empty',
      '-m',
      'seed',
    ]);
    await git(root, ['submodule', 'add', 'https://submodule.test/r', 'nested']);
    await git(root, ['submodule', 'absorbgitdirs', 'nested']);
  }
  const response = await link();
  expect(response.status, await response.text()).toBe(200);
  expect(await git(`${root}/nested`, ['remote', 'get-url', 'origin'])).toBe('https://new.test/r');
  expect(await git(root, ['remote', 'get-url', 'origin'])).toBe('https://old.test/r');
});
