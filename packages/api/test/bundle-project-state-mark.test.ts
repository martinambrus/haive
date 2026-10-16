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
import { createFakeDb, type FakeDbHandle } from '@haive/database/testing';
import { configService, logger } from '@haive/shared';
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
  vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
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
    // The fake defaults only id and createdAt, so the mapper fails on updatedAt after the commit.
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

interface Write {
  kind: 'insert' | 'update';
  table: unknown;
  values: Record<string, unknown>;
}
let writes: Write[];

function recording(handle: FakeDbHandle): FakeDbHandle {
  return {
    ...handle,
    insert: (table) => ({
      values: (values) => {
        const row = values as Record<string, unknown>;
        writes.push({ kind: 'insert', table, values: row });
        // The fake defaults only id and createdAt; the response mapper reads a bundle's updatedAt.
        return handle
          .insert(table)
          .values(table === schema.customBundles ? { updatedAt: new Date(), ...row } : row);
      },
    }),
    update: (table) => ({
      set: (values) => {
        writes.push({ kind: 'update', table, values });
        return handle.update(table).set(values);
      },
    }),
    transaction: (fn) => handle.transaction((tx) => fn(recording(tx))),
  };
}

describe('a bundle row is inserted with its storage_root', () => {
  beforeEach(() => {
    writes = [];
    h.db = recording(h.db as FakeDbHandle);
  });

  const bundleWrites = (kind: Write['kind']) =>
    writes.filter((w) => w.kind === kind && w.table === schema.customBundles);
  const rootOf = (id: string) => path.join(storage, USER, id, 'extracted');

  async function createFromGit(): Promise<string> {
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repositoryId: REPO,
        name: 'kit',
        gitUrl: 'https://example.com/kit.git',
        enabledKinds: ['agent', 'skill'],
      }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { bundle: { id: string } }).bundle.id;
  }

  async function completeUpload(): Promise<string> {
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
    const res = await app.request(`/uploads/${SESSION}/complete`, { method: 'POST' });
    expect(res.status).toBe(201);
    return ((await res.json()) as { bundle: { id: string } }).bundle.id;
  }

  describe('on create from a git source', () => {
    it('in the insert, for the id the response returns', async () => {
      const id = await createFromGit();

      expect(bundleWrites('insert').map((w) => w.values.storageRoot)).toEqual([rootOf(id)]);
    });

    it('and no later update sets it', async () => {
      await createFromGit();

      expect(bundleWrites('update').flatMap((w) => Object.keys(w.values))).not.toContain(
        'storageRoot',
      );
    });
  });

  describe('on create from an uploaded archive', () => {
    it('in the insert, for the id the response returns', async () => {
      const id = await completeUpload();

      expect(bundleWrites('insert').map((w) => w.values.storageRoot)).toEqual([rootOf(id)]);
    });

    it('and with the archive path, so no later update touches the bundle', async () => {
      const id = await completeUpload();

      expect(bundleWrites('insert').map((w) => w.values.archivePath)).toEqual([
        path.join(storage, USER, id, 'source.zip'),
      ]);
      expect(bundleWrites('update')).toEqual([]);
    });
  });
});

describe('an upload session is inserted with its archive path', () => {
  beforeEach(() => {
    writes = [];
    h.db = recording(h.db as FakeDbHandle);
  });

  const uploadWrites = (kind: Write['kind']) =>
    writes.filter((w) => w.kind === kind && w.table === schema.customBundleUploads);
  const partialOf = (id: string) => path.join(storage, '_uploads', USER, `${id}.zip.partial`);
  const post = (url: string, body: unknown) =>
    app.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const inits: [string, () => Response | Promise<Response>][] = [
    [
      'a bundle upload',
      () =>
        post('/uploads/init', {
          repositoryId: REPO,
          name: 'kit',
          enabledKinds: ['agent', 'skill'],
          filename: 'kit.zip',
          totalSize: 9,
          chunkSize: 4,
        }),
    ],
    [
      'an archive replacement',
      () => {
        fake.insert(schema.customBundles, {
          id: BUNDLE,
          userId: USER,
          repositoryId: REPO,
          name: 'kit',
          sourceType: 'zip',
          enabledKinds: ['agent', 'skill'],
          storageRoot: '/bundles/kit',
        });
        return post(`/${BUNDLE}/replace/init`, { filename: 'kit.zip', totalSize: 9, chunkSize: 4 });
      },
    ],
  ];

  describe.each(inits)('on the init of %s', (_name, init) => {
    async function start() {
      const res = await init();
      expect(res.status).toBe(201);
      return ((await res.json()) as { session: { id: string } }).session;
    }

    it('in the insert, for the session id the response returns', async () => {
      const { id } = await start();

      expect(uploadWrites('insert').map((w) => w.values.archivePath)).toEqual([partialOf(id)]);
    });

    it('and no later update sets it', async () => {
      await start();

      expect(uploadWrites('update').flatMap((w) => Object.keys(w.values))).not.toContain(
        'archivePath',
      );
    });

    it('and the response keeps its fields', async () => {
      const session = await start();

      expect(session).toEqual({
        id: expect.any(String),
        repositoryId: REPO,
        name: 'kit',
        enabledKinds: ['agent', 'skill'],
        filename: 'kit.zip',
        archiveFormat: 'zip',
        totalSize: 9,
        bytesReceived: 0,
        chunkSize: 4,
        status: 'uploading',
      });
    });
  });
});
