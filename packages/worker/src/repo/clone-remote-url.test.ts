import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { lstatNoFollow } from '@haive/shared/fs-safe';
import { gitClone } from './clone.js';
import { gitRun } from './git-exec.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
it.each(['path', 'file URL'])(
  'rejects a stored clone %s before creating a checkout',
  async (shape) => {
    const root = await mkdtemp(path.join(tmpdir(), 't417-clone-'));
    dirs.push(root);
    expect((await gitRun(root, ['init', '--bare', 'source'])).code).toBe(0);
    const url = shape === 'path' ? `${root}/source` : `file://${root}/source`;
    await expect(gitClone(url, `${root}/dest`)).rejects.toMatchObject({ name: 'OriginUrlError' });
    expect(await lstatNoFollow(root, 'dest')).toBeNull();
  },
);
it('blocks an allowed URL rewritten to file by inherited git config', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 't417-clone-rewrite-'));
  dirs.push(root);
  expect((await gitRun(root, ['init', '--bare', 'source'])).code).toBe(0);
  await expect(
    gitClone('https://example.test/source', `${root}/dest`, undefined, {
      argv: ['-c', `url.file://${root}/.insteadOf=https://example.test/`],
      env: {},
      secret: '',
    }),
  ).rejects.toThrow();
  expect(await lstatNoFollow(root, 'dest')).toBeNull();
});
