import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@haive/database', async (original) => ({
  ...(await original<typeof import('@haive/database')>()),
  acquireRootClaim: async () => ({ release: async () => {}, lost: () => false }),
}));
vi.mock('../src/plan/mirror.js', async (original) => ({
  ...(await original<typeof import('../src/plan/mirror.js')>()),
  seedPlanBaseFromCheckout: async () => {},
}));
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { gitRun } from '../src/repo/git-exec.js';
import { handleClone } from '../src/repo/clone.js';
import { handleRefresh } from '../src/repo/refresh.js';
const USER = '00000000-0000-4000-8000-000000000001';
const REPO = '00000000-0000-4000-8000-000000000002';
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
it.each([
  ['clone', handleClone],
  ['refresh rebuild', handleRefresh],
] as const)('%s refuses a URL before moving or removing the existing tree', async (_name, run) => {
  const base = await mkdtemp(path.join(tmpdir(), 'clone-order-'));
  dirs.push(base);
  const dest = path.join(base, USER, REPO);
  await mkdir(dest, { recursive: true });
  expect((await gitRun(dest, ['init'])).code).toBe(0);
  await writeFile(path.join(dest, 'keep'), 'existing tree');
  const config = await readFile(path.join(dest, '.git/config'), 'utf8');
  const fake = createFakeDb({ repositories: schema.repositories, tasks: schema.tasks });
  fake.insert(schema.repositories, { id: REPO, userId: USER, storagePath: dest });
  const error = await run(
    { repositoryId: REPO, userId: USER, source: 'git_https', remoteUrl: 'file:///x' },
    fake.db as unknown as Database,
    base,
  ).catch((e: unknown) => e);
  expect(error).toMatchObject({ name: 'OriginUrlError' });
  expect((error as Error).message).toContain(
    _name === 'clone' ? 'retry cloning' : 'retry refreshing',
  );
  expect((error as Error).message).not.toContain('this step');
  expect(await readFile(path.join(dest, 'keep'), 'utf8')).toBe('existing tree');
  expect(await readFile(path.join(dest, '.git/config'), 'utf8')).toBe(config);
  expect(await readdir(path.join(base, USER))).toEqual([REPO]);
});
