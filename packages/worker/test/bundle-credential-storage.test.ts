// Host and CI only: the HTTP fixture needs git http-backend.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ensureDirNoFollow, writeFileNoFollow } from '@haive/shared/fs-safe';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { gitRun } from '../src/repo/git-exec.js';
import { handleIngestGit, handleResyncGit } from '../src/repo/bundle-ingest.js';
import { runBundleGitSyncTick } from '../src/repo/bundle-sync.js';
import { bundleResyncStep } from '../src/step-engine/steps/onboarding-upgrade/00-bundle-resync.js';
import { startGitHttpServer } from './support/git-http-fixture.js';
const h = vi.hoisted(() => ({ host: '' }));
vi.mock('../src/repo/credentials.js', () => ({
  getDecryptedCredentials: async () => ({
    username: 'fixture-user',
    secret: 'fixture-password',
    host: h.host,
  }),
}));
vi.mock('../src/bundle-parser/index.js', () => ({
  parseBundle: async () => ({ items: [], ambiguous: [], dropped: [] }),
  persistBundleItems: async () => ({ inserted: 0, updated: 0, removed: 0 }),
}));
let root: string;
let fixture: Awaited<ReturnType<typeof startGitHttpServer>>;
afterEach(async () => {
  await fixture?.close();
  if (root) await rm(root, { recursive: true, force: true });
});
it('keeps clone and every resync authenticated without URL credentials, cleaning legacy origins', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'haive-bundle-credential-'));
  await ensureDirNoFollow(root, 'seed');
  const seed = path.join(root, 'seed');
  const bare = path.join(root, 'bare');
  await gitRun(seed, ['init', '-b', 'main']);
  await writeFileNoFollow(root, 'seed/README.md', '# fixture');
  await gitRun(seed, ['add', '.']);
  await gitRun(seed, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-m',
    'seed',
  ]);
  expect(
    (await gitRun(root, ['clone', '--bare', seed, bare], undefined, { allowFileTransport: true }))
      .code,
  ).toBe(0);
  fixture = await startGitHttpServer(root, {
    username: 'fixture-user',
    password: 'fixture-password',
  });
  const clean = fixture.httpOrigin(bare);
  h.host = new URL(clean).host;
  const fake = createFakeDb({ customBundles: schema.customBundles, tasks: schema.tasks });
  const bundleId = '00000000-0000-4000-8000-000000000001';
  const userId = '00000000-0000-4000-8000-000000000002';
  const repositoryId = '00000000-0000-4000-8000-000000000003';
  const taskId = '00000000-0000-4000-8000-000000000004';
  fake.insert(schema.customBundles, {
    id: bundleId,
    userId,
    repositoryId,
    name: 'fixture',
    sourceType: 'git',
    gitUrl: clean,
    gitCredentialsId: '00000000-0000-4000-8000-000000000005',
    gitBranch: 'main',
    storageRoot: '',
  });
  fake.insert(schema.tasks, { id: taskId, userId, repositoryId });
  const payload = { bundleId, userId };
  await handleIngestGit(payload, fake.db as never, root);
  const dest = path.join(root, userId, bundleId, 'extracted');
  const config = async () =>
    (await gitRun(dest, ['config', '--get', 'remote.origin.url'])).stdout.trim();
  expect((await config()) === clean).toBe(true);
  const legacy = new URL(clean);
  legacy.username = 'fixture-user';
  legacy.password = 'retired-fixture-password';
  for (const mode of ['pull', 'tick', 'detect']) {
    await gitRun(dest, ['config', '--replace-all', 'remote.origin.url', legacy.toString()]);
    const before = await fixture.authCount();
    if (mode === 'pull') await handleResyncGit(payload, fake.db as never, root);
    if (mode === 'tick') expect((await runBundleGitSyncTick(fake.db as never)).errors).toBe(0);
    if (mode === 'detect') {
      const detected = await bundleResyncStep.detect!({ db: fake.db, taskId, userId } as never);
      expect(detected.candidates[0]?.fetchError).toBeNull();
    }
    expect((await config()) === clean).toBe(true);
    expect(await fixture.authCount()).toBeGreaterThan(before);
  }
});
