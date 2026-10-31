import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

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
  return { ...actual, walkFilesNoFollow: vi.fn(actual.walkFilesNoFollow) };
});
import { WALK_MAX_DEPTH, walkFilesNoFollow } from '@haive/shared/fs-safe';
import { Hono } from 'hono';
import { bundleRoutes } from '../src/routes/bundles.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const BUNDLE = '00000000-0000-4000-8000-0000000000c1';
const saved = process.env.BUNDLE_STORAGE_ROOT;
let storage: string;
let tree: string;
const app = new Hono<AppEnv>();
app.route('/', bundleRoutes);
app.onError(errorHandler);

beforeEach(async () => {
  storage = await mkdtemp(path.join(tmpdir(), 'bundle-walk-limits-'));
  process.env.BUNDLE_STORAGE_ROOT = storage;
  tree = path.join(storage, USER, BUNDLE, 'extracted');
  await mkdir(path.join(tree, 'a'), { recursive: true });
  await writeFile(path.join(tree, 'a', 'first'), 'x');
  h.db = {
    query: {
      customBundles: { findFirst: async () => ({ id: BUNDLE, userId: USER, storageRoot: tree }) },
    },
  };
});
afterEach(async () => {
  if (saved === undefined) delete process.env.BUNDLE_STORAGE_ROOT;
  else process.env.BUNDLE_STORAGE_ROOT = saved;
  await rm(storage, { recursive: true, force: true });
});

// A listing that cannot be finished is the api's 500 shape, never a 200 that reads as the whole tree.
const SERVER_ERROR = { error: 'Internal server error' };

it('answers 500 for a tree nested deeper than the walk allows', async () => {
  const levels = Array.from({ length: WALK_MAX_DEPTH + 1 }, () => 'd').join('/');
  await mkdir(path.join(tree, levels), { recursive: true });

  const res = await app.request(`/${BUNDLE}/files`);

  expect(res.status).toBe(500);
  expect(await res.json()).toEqual(SERVER_ERROR);
});

it('answers 500, not a partial list, when the walk runs out of descriptors part-way', async () => {
  vi.mocked(walkFilesNoFollow).mockImplementationOnce(async function* () {
    yield { path: 'a/first', size: 1 };
    throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
  });

  const res = await app.request(`/${BUNDLE}/files`);

  expect(res.status).toBe(500);
  expect(await res.json()).toEqual(SERVER_ERROR);
});
