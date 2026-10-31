import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getBundleQueue: () => ({ add: async () => ({}) }) }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
}));
vi.mock('@haive/shared/fs-safe', async (original) => {
  const actual = await original<typeof import('@haive/shared/fs-safe')>();
  return { ...actual, lstatNoFollow: vi.fn(actual.lstatNoFollow) };
});
import { lstatNoFollow } from '@haive/shared/fs-safe';
import { Hono } from 'hono';
import { bundleRoutes, FILES_LIST_CAP } from '../src/routes/bundles.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const BUNDLE = '00000000-0000-4000-8000-0000000000c1';
const DIRECTORIES = 10;
const run = promisify(execFile);
let storage: string | undefined;
const sockets: Server[] = [];
const saved = process.env.BUNDLE_STORAGE_ROOT;
afterEach(async () => {
  await Promise.all(sockets.splice(0).map((socket) => new Promise((done) => socket.close(done))));
  if (saved === undefined) delete process.env.BUNDLE_STORAGE_ROOT;
  else process.env.BUNDLE_STORAGE_ROOT = saved;
  if (storage) await rm(storage, { recursive: true, force: true });
});

it('lists a cap-sized tree of nested files identically without resolving each file from the anchor', async () => {
  storage = await mkdtemp(path.join(tmpdir(), 'bundle-walk-'));
  process.env.BUNDLE_STORAGE_ROOT = storage;
  const tree = path.join(storage, USER, BUNDLE, 'extracted');
  const expected: Array<{ path: string; size: number }> = [];
  for (let d = 0; d < DIRECTORIES; d += 1) {
    const rel = `d${d}/nested/deep`;
    await mkdir(path.join(tree, rel), { recursive: true });
    for (let i = 0; i < FILES_LIST_CAP / DIRECTORIES; i += 1) {
      const name = `f${String(i).padStart(4, '0')}`;
      await writeFile(path.join(tree, rel, name), 'hello');
      expected.push({ path: `${rel}/${name}`, size: 5 });
    }
  }
  await mkdir(path.join(tree, '.git'));
  await writeFile(path.join(tree, '.git', 'HEAD'), 'hidden');
  await writeFile(path.join(tree, '.DS_Store'), 'hidden');
  const outside = path.join(storage, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret'), 'must not appear');
  await symlink(outside, path.join(tree, 'linked-directory'));
  await symlink(path.join(outside, 'secret'), path.join(tree, 'linked-file'));
  await symlink('missing', path.join(tree, 'dangling'));
  // Neither a regular file nor a directory, and a link below the first level. A socket path is
  // limited to about 100 bytes and the tree's own is longer, so it is bound under a short name and
  // moved in.
  await run('mkfifo', [path.join(tree, 'pipe')]);
  const bound = await mkdtemp(path.join(tmpdir(), 's-'));
  const socket = createServer();
  sockets.push(socket);
  await new Promise<void>((listening) => socket.listen(path.join(bound, 'sock'), listening));
  await rename(path.join(bound, 'sock'), path.join(tree, 'sock'));
  await rm(bound, { recursive: true, force: true });
  await symlink(path.join(outside, 'secret'), path.join(tree, 'd0', 'linked-nested-file'));
  h.db = {
    query: {
      customBundles: { findFirst: async () => ({ id: BUNDLE, userId: USER, storageRoot: tree }) },
    },
  };
  const app = new Hono<AppEnv>();
  app.route('/', bundleRoutes);
  app.onError(errorHandler);
  vi.mocked(lstatNoFollow).mockClear();
  const response = await app.request(`/${BUNDLE}/files`);
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(body).toEqual({ files: expected, truncated: false, cap: FILES_LIST_CAP });
  expect(vi.mocked(lstatNoFollow).mock.calls.length).toBeLessThanOrEqual(1);
}, 60_000);
