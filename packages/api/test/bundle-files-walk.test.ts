import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
import { bundleRoutes } from '../src/routes/bundles.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const BUNDLE = '00000000-0000-4000-8000-0000000000c1';
let storage: string | undefined;
const saved = process.env.BUNDLE_STORAGE_ROOT;
afterEach(async () => {
  if (saved === undefined) delete process.env.BUNDLE_STORAGE_ROOT;
  else process.env.BUNDLE_STORAGE_ROOT = saved;
  if (storage) await rm(storage, { recursive: true, force: true });
});

it('lists 5000 nested files identically without resolving each file from the anchor', async () => {
  storage = await mkdtemp(path.join(tmpdir(), 'bundle-walk-'));
  process.env.BUNDLE_STORAGE_ROOT = storage;
  const tree = path.join(storage, USER, BUNDLE, 'extracted');
  const expected: Array<{ path: string; size: number }> = [];
  for (let d = 0; d < 10; d += 1) {
    const rel = `d${d}/nested/deep`;
    await mkdir(path.join(tree, rel), { recursive: true });
    for (let i = 0; i < 500; i += 1) {
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
  h.db = {
    query: {
      customBundles: { findFirst: async () => ({ id: BUNDLE, userId: USER, storageRoot: tree }) },
    },
  };
  const app = new Hono<AppEnv>();
  app.route('/', bundleRoutes);
  app.onError(errorHandler);
  vi.mocked(lstatNoFollow).mockClear();
  const start = performance.now();
  const response = await app.request(`/${BUNDLE}/files`);
  const body = await response.json();
  const elapsedMs = performance.now() - start;
  console.info(
    JSON.stringify({ elapsedMs, anchorLstats: vi.mocked(lstatNoFollow).mock.calls.length }),
  );
  if (process.env.BUNDLE_WALK_EVIDENCE_PREFIX) {
    await writeFile(
      `${process.env.BUNDLE_WALK_EVIDENCE_PREFIX}-timing.txt`,
      `Command: BUNDLE_WALK_EVIDENCE_PREFIX=${process.env.BUNDLE_WALK_EVIDENCE_PREFIX} pnpm --filter @haive/api test test/bundle-files-walk.test.ts\n${JSON.stringify({ elapsedMs, anchorLstats: vi.mocked(lstatNoFollow).mock.calls.length })}\n`,
    );
    await writeFile(
      `${process.env.BUNDLE_WALK_EVIDENCE_PREFIX}-listing.txt`,
      `Command: BUNDLE_WALK_EVIDENCE_PREFIX=${process.env.BUNDLE_WALK_EVIDENCE_PREFIX} pnpm --filter @haive/api test test/bundle-files-walk.test.ts\n${JSON.stringify(body, null, 2)}\n`,
    );
  }
  expect(response.status).toBe(200);
  expect(body).toEqual({ files: expected, truncated: false, cap: 5000 });
  expect(vi.mocked(lstatNoFollow).mock.calls.length).toBeLessThanOrEqual(1);
}, 60_000);
