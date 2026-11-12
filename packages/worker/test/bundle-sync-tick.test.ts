import { beforeEach, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { runBundleGitSyncTick } from '../src/repo/bundle-sync.js';

vi.mock('../src/repo/git-push.js', () => ({
  originGitRun: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
  scrubSecret: (text: string) => text,
}));
vi.mock('../src/repo/bundle-git.js', () => ({
  bundleGitAuth: vi.fn(async () => ({ argv: [], env: {} })),
}));
vi.mock('../src/repo/git-exec.js', () => ({
  gitRun: vi.fn(async () => ({ code: 0, stdout: 'remote', stderr: '' })),
}));
vi.mock('../src/repo/bundle-ingest.js', () => ({
  gitRevParseHead: vi.fn(async () => 'local'),
}));

beforeEach(() => vi.clearAllMocks());

it('refreshes git metadata without changing the admission generation or touching ZIP bundles', async () => {
  const fake = createFakeDb({ customBundles: schema.customBundles });
  const updatedAt = new Date('2026-01-01');
  for (const [id, sourceType] of [
    ['00000000-0000-4000-8000-000000000001', 'git'],
    ['00000000-0000-4000-8000-000000000002', 'zip'],
  ] as const) {
    fake.insert(schema.customBundles, {
      id,
      sourceType,
      userId: '00000000-0000-4000-8000-000000000003',
      status: 'active',
      storageRoot: '/bundle',
      lastSyncCommit: 'previous',
      updatedAt,
    });
  }
  expect(await runBundleGitSyncTick(fake.db as unknown as Database)).toEqual({
    scanned: 1,
    updated: 1,
    errors: 0,
  });
  expect(fake.rows(schema.customBundles)).toEqual([
    expect.objectContaining({ sourceType: 'git', lastSyncCommit: 'local', updatedAt }),
    expect.objectContaining({ sourceType: 'zip', lastSyncCommit: 'previous', updatedAt }),
  ]);
});
