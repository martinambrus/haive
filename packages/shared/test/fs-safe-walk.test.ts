import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { walkFilesNoFollow } from '../src/fs-safe.js';

const run = promisify(execFile);
let root: string;
const sockets: Server[] = [];
afterEach(async () => {
  await Promise.all(sockets.splice(0).map((socket) => new Promise((done) => socket.close(done))));
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
  // Entries that are neither a regular file nor a directory, and links below the first level: a
  // FIFO opened for reading would block the walk, and only a link at the root was ever planted.
  await run('mkfifo', [path.join(root, 'tree/pipe')]);
  const socket = createServer();
  sockets.push(socket);
  await new Promise<void>((listening) => socket.listen(path.join(root, 'tree/sock'), listening));
  await symlink(path.join(root, 'outside/secret'), path.join(root, 'tree/a/linked-nested-file'));
  await symlink(path.join(root, 'outside'), path.join(root, 'tree/a/deep/linked-nested-dir'));
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
it('lists nothing from a child directory replaced by a link after its parent was listed', async () => {
  await fixture();
  await mkdir(path.join(root, 'swap/a'), { recursive: true });
  await mkdir(path.join(root, 'swap/b'));
  await writeFile(path.join(root, 'swap/a/f'), 'f');
  await writeFile(path.join(root, 'swap/b/g'), 'g');
  const walk = walkFilesNoFollow(root, 'swap');
  expect((await walk.next()).value).toEqual({ path: 'a/f', size: 1 });
  await rm(path.join(root, 'swap/b'), { recursive: true });
  await symlink(path.join(root, 'outside'), path.join(root, 'swap/b'));
  const remaining = [];
  for await (const entry of walk) remaining.push(entry);
  expect(remaining).toEqual([]);
});
// A FileHandle that is reclaimed unclosed is fatal on Node 26, so a walk that is left early (a
// `break`, a throw in the loop body) must still close every directory it holds, at every level.
const openFds = () => readdirSync('/proc/self/fd').length;
async function deepTree() {
  root = await mkdtemp(path.join(tmpdir(), 'safe-walk-'));
  await mkdir(path.join(root, 'deep/a/b/c'), { recursive: true });
  await writeFile(path.join(root, 'deep/a/b/c/one'), '1');
  await writeFile(path.join(root, 'deep/a/b/c/two'), '2');
}
it('closes every held directory when the walk runs to its end', async () => {
  await deepTree();
  const before = openFds();
  const found = [];
  for await (const entry of walkFilesNoFollow(root, 'deep')) found.push(entry.path);
  expect(found).toEqual(['a/b/c/one', 'a/b/c/two']);
  expect(openFds()).toBe(before);
});
it('closes every held directory when the loop breaks three levels down', async () => {
  await deepTree();
  const before = openFds();
  for await (const entry of walkFilesNoFollow(root, 'deep')) {
    expect(entry.path).toBe('a/b/c/one');
    // The levels are held while the walk is suspended, so a count that never moved proves nothing.
    expect(openFds()).toBeGreaterThan(before);
    break;
  }
  expect(openFds()).toBe(before);
});
it('closes every held directory when the loop body throws', async () => {
  await deepTree();
  const before = openFds();
  const failing = async () => {
    for await (const entry of walkFilesNoFollow(root, 'deep')) throw new Error(`at ${entry.path}`);
  };
  await expect(failing()).rejects.toThrow('at a/b/c/one');
  expect(openFds()).toBe(before);
});
it('has no strict mode: a refused root lists nothing', async () => {
  await fixture();
  // @ts-expect-error `strict` belongs to the single-path primitives; the walk only has the lenient rule
  const walk = walkFilesNoFollow(root, 'tree/linked-dir', { strict: true });
  const found = [];
  for await (const entry of walk) found.push(entry);
  expect(found).toEqual([]);
});
it('rejects invalid relative paths', async () => {
  await fixture();
  await expect(walkFilesNoFollow(root, '../outside').next()).rejects.toMatchObject({
    reason: 'invalid-path',
  });
});
