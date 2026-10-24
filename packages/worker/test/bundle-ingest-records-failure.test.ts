import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/repo/credentials.js', () => ({
  getDecryptedCredentials: async () => {
    throw new Error('credentials cannot be decrypted');
  },
}));

import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import type { BundleJobPayload } from '@haive/shared';
import { gitRun } from '../src/repo/git-exec.js';
import { handleIngestGit, handleIngestZip, handleResyncGit } from '../src/repo/bundle-ingest.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000f1';
const BUNDLE = '00000000-0000-4000-8000-0000000000c1';
const CREDENTIALS = '00000000-0000-4000-8000-0000000000d1';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'bundle-failure-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

type Handler = (payload: BundleJobPayload, db: Database, root: string) => Promise<void>;

const cases: Array<[string, Handler, Record<string, unknown>]> = [
  [
    'handleIngestZip without an archive path',
    handleIngestZip,
    { sourceType: 'zip', archivePath: null, archiveFormat: null },
  ],
  ['handleIngestGit without a git url', handleIngestGit, { gitUrl: null }],
  [
    'handleIngestGit when the credentials cannot be decrypted',
    handleIngestGit,
    { gitUrl: 'https://example.com/kit.git', gitCredentialsId: CREDENTIALS },
  ],
  ['handleResyncGit without a git url', handleResyncGit, { gitUrl: null }],
];

describe('a bundle handler that throws before it starts working', () => {
  it.each(cases)('%s leaves the bundle failed, with the message', async (_name, handler, over) => {
    const fake = createFakeDb({ customBundles: schema.customBundles });
    fake.insert(schema.customBundles, {
      id: BUNDLE,
      userId: USER,
      repositoryId: REPO,
      name: 'kit',
      sourceType: 'git',
      storageRoot: '',
      status: 'syncing',
      updatedAt: new Date(),
      ...over,
    });

    const err = await handler(
      { bundleId: BUNDLE, userId: USER },
      fake.db as unknown as Database,
      root,
    )
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const stored = fake.rows(schema.customBundles)[0]!;
    expect(stored.status).toBe('failed');
    expect(stored.lastSyncError).toBe((err as Error).message);
  });
});

it('a refused bundle URL records failure without wiping its existing extracted tree', async () => {
  const dest = path.join(root, USER, BUNDLE, 'extracted');
  await mkdir(dest, { recursive: true });
  expect((await gitRun(dest, ['init'])).code).toBe(0);
  await writeFile(path.join(dest, 'keep'), 'existing bundle');
  const config = await readFile(path.join(dest, '.git/config'), 'utf8');
  const fake = createFakeDb({ customBundles: schema.customBundles });
  fake.insert(schema.customBundles, {
    id: BUNDLE,
    userId: USER,
    repositoryId: REPO,
    name: 'kit',
    sourceType: 'git',
    gitUrl: 'file:///x',
    status: 'syncing',
  });
  const error = await handleIngestGit(
    { bundleId: BUNDLE, userId: USER },
    fake.db as unknown as Database,
    root,
  ).catch((e: unknown) => e);
  expect(error).toMatchObject({ name: 'OriginUrlError' });
  expect(fake.rows(schema.customBundles)[0]).toMatchObject({
    status: 'failed',
    lastSyncError: (error as Error).message,
  });
  expect(await readFile(path.join(dest, 'keep'), 'utf8')).toBe('existing bundle');
  expect(await readFile(path.join(dest, '.git/config'), 'utf8')).toBe(config);
});
