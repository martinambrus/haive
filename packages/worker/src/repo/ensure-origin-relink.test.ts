import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { gitRun } from './git-exec.js';
import { ensureOrigin } from './git-push.js';
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
it('relink replaces every fetch URL and removes every planted push URL', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 't417-relink-'));
  dirs.push(root);
  const git = async (args: string[]) => {
    const result = await gitRun(root, args);
    expect(result.code, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  await git(['init']);
  await git(['remote', 'add', 'origin', 'https://old.test/r']);
  await git(['config', '--add', 'remote.origin.url', 'https://extra.test/r']);
  await git(['config', '--add', 'remote.origin.pushurl', 'https://planted.test/r']);
  await git(['config', '--add', 'remote.origin.pushurl', 'https://planted2.test/r']);
  await ensureOrigin(root, 'https://new.test/r');
  expect(await git(['remote', 'get-url', '--all', 'origin'])).toBe('https://new.test/r');
  expect(await git(['remote', 'get-url', '--push', '--all', 'origin'])).toBe('https://new.test/r');
  expect((await gitRun(root, ['config', '--get-all', 'remote.origin.pushurl'])).code).toBe(1);
});
