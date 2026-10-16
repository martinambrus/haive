import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { Hono } from 'hono';
import { bundleRoutes } from '../src/routes/bundles.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const BUNDLE = '00000000-0000-4000-8000-0000000000c1';
const CAP = 5000;

const app = new Hono<AppEnv>();
app.route('/', bundleRoutes);
app.onError(errorHandler);

let storage: string;
let saved: string | undefined;
let tree: string;

beforeEach(async () => {
  storage = await mkdtemp(path.join(tmpdir(), 'bundle-files-cap-'));
  saved = process.env.BUNDLE_STORAGE_ROOT;
  process.env.BUNDLE_STORAGE_ROOT = storage;
  tree = path.join(storage, USER, BUNDLE, 'extracted');
  await mkdir(path.join(tree, 'a'), { recursive: true });
  for (let i = 0; i < CAP; i += 1) {
    await writeFile(path.join(tree, 'a', `f${String(i).padStart(4, '0')}`), 'x');
  }
  h.db = {
    query: {
      customBundles: {
        findFirst: async () => ({ id: BUNDLE, userId: USER, storageRoot: tree }),
      },
    },
  };
}, 60_000);

afterEach(async () => {
  if (saved === undefined) delete process.env.BUNDLE_STORAGE_ROOT;
  else process.env.BUNDLE_STORAGE_ROOT = saved;
  await rm(storage, { recursive: true, force: true });
});

async function listFiles() {
  const res = await app.request(`/${BUNDLE}/files`);
  expect(res.status).toBe(200);
  return (await res.json()) as { files: Array<{ path: string }>; truncated: boolean };
}

describe('the bundle file listing says it is cut only when a listable file was left out', () => {
  it('lists exactly the cap followed only by skipped entries without the flag', async () => {
    await mkdir(path.join(tree, 'z', '.git'), { recursive: true });
    await writeFile(path.join(tree, 'z', '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(path.join(tree, 'z', '.DS_Store'), 'x');
    await mkdir(path.join(tree, 'zz-empty'));
    await symlink(path.join(tree, 'a', 'f0000'), path.join(tree, 'zzz-link'));

    const body = await listFiles();

    expect(body.files).toHaveLength(CAP);
    expect(body.truncated).toBe(false);
  }, 60_000);

  it('flags one listable file past the cap and lists the first 5000', async () => {
    await mkdir(path.join(tree, 'b'));
    await writeFile(path.join(tree, 'b', 'extra'), 'x');

    const body = await listFiles();

    expect(body.files).toHaveLength(CAP);
    expect(body.files.map((f) => f.path)).not.toContain('b/extra');
    expect(body.truncated).toBe(true);
  }, 60_000);

  it('flags a listable file that follows skipped entries past the cap', async () => {
    await mkdir(path.join(tree, 'z'));
    await writeFile(path.join(tree, 'z', '.DS_Store'), 'x');
    await mkdir(path.join(tree, 'zz'));
    await writeFile(path.join(tree, 'zz', 'extra'), 'x');

    const body = await listFiles();

    expect(body.files).toHaveLength(CAP);
    expect(body.files.map((f) => f.path)).not.toContain('zz/extra');
    expect(body.truncated).toBe(true);
  }, 60_000);
});
