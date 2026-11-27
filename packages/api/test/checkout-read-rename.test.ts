import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  beforeOpen: undefined as ((path: string) => Promise<void>) | undefined,
  beforeReadlink: undefined as ((path: string) => Promise<void>) | undefined,
  afterHeld: undefined as (() => Promise<void>) | undefined,
}));
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      await h.beforeOpen?.(String(args[0]));
      return real.open(...args);
    },
    readlink: async (...args: Parameters<typeof real.readlink>) => {
      await h.beforeReadlink?.(String(args[0]));
      return real.readlink(...args);
    },
  };
});
vi.mock('@haive/shared/fs-safe', async (original) => {
  const real = await original<typeof import('@haive/shared/fs-safe')>();
  return {
    ...real,
    openFileNoFollow: async (...args: Parameters<typeof real.openFileNoFollow>) => {
      const held = await real.openFileNoFollow(...args);
      if (held && h.afterHeld) await h.afterHeld();
      return held;
    },
  };
});
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { attachmentRoutes } from '../src/routes/tasks/attachments.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';
const USER = '00000000-0000-4000-8000-000000007820';
const REPO = '00000000-0000-4000-8000-000000007821';
const TASK = '00000000-0000-4000-8000-000000007822';
const FILE = '00000000-0000-4000-8000-000000007823';
const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  c.set('userId', USER);
  await next();
});
app.route('/', attachmentRoutes);
app.onError(errorHandler);
let temp: string;
let root: string;
let fake: ReturnType<typeof createFakeDb>;
beforeEach(async () => {
  h.beforeOpen = undefined;
  h.beforeReadlink = undefined;
  h.afterHeld = undefined;
  temp = await mkdtemp(join(tmpdir(), 'checkout-read-'));
  root = join(temp, 'repo');
  const dir = join(root, '.haive/task-uploads', TASK);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'spec.md'), 'old bytes');
  await writeFile(join(temp, 'outside'), 'secret outside');
  fake = createFakeDb({
    repositories: schema.repositories,
    tasks: schema.tasks,
    taskAttachments: schema.taskAttachments,
  });
  fake.insert(schema.repositories, { id: REPO, userId: USER, status: 'ready', storagePath: root });
  fake.insert(schema.tasks, { id: TASK, userId: USER, repositoryId: REPO });
  fake.insert(schema.taskAttachments, {
    id: FILE,
    taskId: TASK,
    userId: USER,
    filename: 'spec.md',
    storedPath: join(dir, 'spec.md'),
  });
  h.db = fake.db;
});
afterEach(async () => {
  h.beforeOpen = undefined;
  h.beforeReadlink = undefined;
  h.afterHeld = undefined;
  await rm(temp, { force: true, recursive: true });
});
async function replace() {
  fake.patch(schema.repositories, REPO, { status: 'cloning' });
  await rename(root, join(temp, 'aside'));
}
const download = () => app.request(`/${TASK}/attachments/${FILE}/raw`);
it('answers unavailable when rename occurs immediately before anchor open; never recreates it', async () => {
  h.beforeOpen = async (path) => {
    if (path === root) {
      h.beforeOpen = undefined;
      await replace();
    }
  };
  const response = await download();
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'checkout_unavailable' });
  await expect(readFile(join(root, '.haive/task-uploads', TASK, 'spec.md'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});
it('answers unavailable for rename during descriptor verification and never follows a replacement link', async () => {
  let count = 0;
  h.beforeReadlink = async () => {
    if (++count === 2) {
      h.beforeReadlink = undefined;
      await replace();
      await symlink(temp, root);
    }
  };
  const response = await download();
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'checkout_unavailable' });
});
it('lets an acquired verified handle finish with its old bytes after rename', async () => {
  h.afterHeld = async () => {
    h.afterHeld = undefined;
    await replace();
  };
  const response = await download();
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('old bytes');
  expect((await download()).status).toBe(409);
});
