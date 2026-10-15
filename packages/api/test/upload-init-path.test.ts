import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb, type FakeDbHandle } from '@haive/database/testing';
import { repoRoutes } from '../src/routes/repos.js';
import { dbDumpRoutes } from '../src/routes/db-dumps.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

interface Write {
  kind: 'insert' | 'update';
  table: unknown;
  values: Record<string, unknown>;
}

let writes: Write[];
let storage: string;
let saved: string | undefined;

function recording(handle: FakeDbHandle): FakeDbHandle {
  return {
    ...handle,
    insert: (table) => ({
      values: (values) => {
        writes.push({ kind: 'insert', table, values: values as Record<string, unknown> });
        return handle.insert(table).values(values);
      },
    }),
    update: (table) => ({
      set: (values) => {
        writes.push({ kind: 'update', table, values });
        return handle.update(table).set(values);
      },
    }),
  };
}

const mount = (routes: Hono<AppEnv>): Hono<AppEnv> => {
  const app = new Hono<AppEnv>();
  app.route('/', routes);
  app.onError(errorHandler);
  return app;
};

beforeEach(async () => {
  storage = await mkdtemp(path.join(tmpdir(), 'upload-init-'));
  saved = process.env.REPO_STORAGE_ROOT;
  process.env.REPO_STORAGE_ROOT = storage;
  writes = [];
  h.db = recording(
    createFakeDb({ repoUploads: schema.repoUploads, dbUploads: schema.dbUploads }).db,
  );
});

afterEach(async () => {
  if (saved === undefined) delete process.env.REPO_STORAGE_ROOT;
  else process.env.REPO_STORAGE_ROOT = saved;
  await rm(storage, { recursive: true, force: true });
});

interface Init {
  name: string;
  app: Hono<AppEnv>;
  table: unknown;
  pathColumn: string;
  body: Record<string, unknown>;
  partial: (id: string) => string;
  fields: Record<string, unknown>;
}

const inits: Init[] = [
  {
    name: 'a repository archive',
    app: mount(repoRoutes),
    table: schema.repoUploads,
    pathColumn: 'archivePath',
    body: { filename: 'kit.zip', totalSize: 9, chunkSize: 4 },
    partial: (id) => `${id}.zip.partial`,
    fields: { filename: 'kit.zip', archiveFormat: 'zip' },
  },
  {
    name: 'a database dump',
    app: mount(dbDumpRoutes),
    table: schema.dbUploads,
    pathColumn: 'dumpPath',
    body: { filename: 'kit.sql', totalSize: 9, chunkSize: 4 },
    partial: (id) => `db-${id}.sql.partial`,
    fields: { filename: 'kit.sql', dumpFormat: 'sql' },
  },
];

describe('an upload session is inserted with its path', () => {
  describe.each(inits)(
    'on the init of $name',
    ({ app, table, pathColumn, body, partial, fields }) => {
      const writesTo = (kind: Write['kind']) =>
        writes.filter((w) => w.kind === kind && w.table === table);

      async function start() {
        const res = await app.request('/upload/init', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(201);
        return ((await res.json()) as { session: { id: string } }).session;
      }

      it('in the insert, for the session id the response returns', async () => {
        const { id } = await start();

        expect(writesTo('insert').map((w) => w.values[pathColumn])).toEqual([
          path.join(storage, '_uploads', USER, partial(id)),
        ]);
      });

      it('and no later update sets it', async () => {
        await start();

        expect(writesTo('update').flatMap((w) => Object.keys(w.values))).not.toContain(pathColumn);
      });

      it('and the response keeps its fields', async () => {
        const session = await start();

        expect(session).toEqual({
          id: expect.any(String),
          ...fields,
          totalSize: 9,
          bytesReceived: 0,
          chunkSize: 4,
          status: 'uploading',
        });
      });
    },
  );
});
