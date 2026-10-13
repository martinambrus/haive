import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { logger } from '@haive/shared';
import { bundleRoutes } from '../src/routes/bundles.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const REPO = '00000000-0000-4000-8000-0000000000f1';
const OTHER = '00000000-0000-4000-8000-0000000000f2';
const SESSION = '00000000-0000-4000-8000-0000000000b1';
const BUNDLE = '00000000-0000-4000-8000-0000000000c1';

const app = new Hono<AppEnv>();
app.route('/', bundleRoutes);
app.onError(errorHandler);

let storage: string;
let saved: string | undefined;
let fake: ReturnType<typeof setup>;

function setup() {
  const db = createFakeDb({
    repositories: schema.repositories,
    customBundles: schema.customBundles,
    customBundleUploads: schema.customBundleUploads,
    projectStateOutbox: schema.projectStateOutbox,
  });
  for (const id of [REPO, OTHER]) {
    db.insert(schema.repositories, { id, userId: USER, name: id, status: 'ready' });
  }
  const noRows = (): unknown => {
    const query: Record<string, unknown> = {};
    for (const method of ['where', 'groupBy']) query[method] = () => query;
    query.then = (ok: (rows: unknown[]) => unknown, bad: (err: unknown) => unknown) =>
      Promise.resolve([]).then(ok, bad);
    return query;
  };
  h.db = {
    ...db.db,
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) =>
        table === schema.customBundleItems ? noRows() : db.db.select(fields).from(table as never),
    }),
  };
  return db;
}

const outbox = (id: string) =>
  fake.rows(schema.projectStateOutbox).find((r) => r.repositoryId === id);

beforeEach(async () => {
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  storage = await mkdtemp(path.join(tmpdir(), 'bundle-mark-'));
  saved = process.env.BUNDLE_STORAGE_ROOT;
  process.env.BUNDLE_STORAGE_ROOT = storage;
  fake = setup();
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (saved === undefined) delete process.env.BUNDLE_STORAGE_ROOT;
  else process.env.BUNDLE_STORAGE_ROOT = saved;
  await rm(storage, { recursive: true, force: true });
});

describe('a bundle change marks the project state record of its repository dirty', () => {
  it('on delete, and only for that repository', async () => {
    fake.insert(schema.customBundles, {
      id: BUNDLE,
      userId: USER,
      repositoryId: REPO,
      name: 'kit',
      sourceType: 'zip',
      storageRoot: '/bundles/kit',
    });

    const res = await app.request(`/${BUNDLE}`, { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(fake.rows(schema.customBundles)).toEqual([]);
    expect(outbox(REPO)).toMatchObject({ revision: 1, writtenRevision: 0 });
    expect(outbox(OTHER)).toBeUndefined();
  });

  it('on create from a git source', async () => {
    // The fake applies no column default, so the response mapper fails on createdAt after the commit.
    await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repositoryId: REPO,
        name: 'kit',
        gitUrl: 'https://example.com/kit.git',
        enabledKinds: ['agent', 'skill'],
      }),
    });

    expect(fake.rows(schema.customBundles)).toHaveLength(1);
    expect(outbox(REPO)).toMatchObject({ revision: 1, writtenRevision: 0 });
  });

  it('on create from an uploaded archive', async () => {
    const uploads = path.join(storage, '_uploads', USER);
    await mkdir(uploads, { recursive: true });
    const archive = path.join(uploads, `${SESSION}.zip`);
    await writeFile(archive, 'zip bytes');
    fake.insert(schema.customBundleUploads, {
      id: SESSION,
      userId: USER,
      repositoryId: REPO,
      name: 'kit',
      enabledKinds: ['agent', 'skill'],
      filename: 'kit.zip',
      archiveFormat: 'zip',
      totalSize: 9,
      bytesReceived: 9,
      chunkSize: 9,
      archivePath: archive,
      status: 'uploading',
    });

    await app.request(`/uploads/${SESSION}/complete`, { method: 'POST' });

    expect(fake.rows(schema.customBundles)).toHaveLength(1);
    expect(outbox(REPO)).toMatchObject({ revision: 1, writtenRevision: 0 });
  });
});
