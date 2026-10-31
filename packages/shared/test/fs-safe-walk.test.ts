import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { walkFilesNoFollow } from '../src/fs-safe.js';

let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  root = await mkdtemp(path.join(tmpdir(), 'safe-walk-'));
  await mkdir(path.join(root, 'tree/a/deep'), { recursive: true });
  await mkdir(path.join(root, 'outside'));
  await writeFile(path.join(root, 'outside/secret'), 'secret');
  await writeFile(path.join(root, 'tree/a/deep/z'), 'abc');
  await writeFile(path.join(root, 'tree/b'), 'hello');
  await symlink(path.join(root, 'outside'), path.join(root, 'tree/linked-dir'));
  await symlink(path.join(root, 'outside/secret'), path.join(root, 'tree/linked-file'));
  await symlink('missing', path.join(root, 'tree/dangling'));
}
it('walks sorted files with sizes, skipping links and excluded names', async () => {
  await fixture();
  await mkdir(path.join(root, 'tree/.git'));
  await writeFile(path.join(root, 'tree/.git/HEAD'), 'hidden');
  await writeFile(path.join(root, 'tree/.DS_Store'), 'hidden');
  const found = [];
  for await (const entry of walkFilesNoFollow(root, 'tree', { skipNames: ['.git', '.DS_Store'] }))
    found.push(entry);
  expect(found).toEqual([
    { path: 'a/deep/z', size: 3 },
    { path: 'b', size: 5 },
  ]);
});
it('does not enter a linked root or an intermediate link', async () => {
  await fixture();
  for (const rel of ['tree/linked-dir', 'tree/linked-dir/sub', 'missing']) {
    const found = [];
    for await (const entry of walkFilesNoFollow(root, rel)) found.push(entry);
    expect(found).toEqual([]);
  }
});
it('refuses a held directory moved outside the tree between yields', async () => {
  await fixture();
  await writeFile(path.join(root, 'tree/a/deep/zz'), 'later');
  const walk = walkFilesNoFollow(root, 'tree');
  expect((await walk.next()).value).toEqual({ path: 'a/deep/z', size: 3 });
  await rename(path.join(root, 'tree/a'), path.join(root, 'outside/moved'));
  await symlink(path.join(root, 'outside'), path.join(root, 'tree/a'));
  const remaining = [];
  for await (const entry of walk) remaining.push(entry);
  expect(remaining).toEqual([{ path: 'b', size: 5 }]);
});
it('rejects invalid relative paths', async () => {
  await fixture();
  await expect(walkFilesNoFollow(root, '../outside').next()).rejects.toMatchObject({
    reason: 'invalid-path',
  });
});
