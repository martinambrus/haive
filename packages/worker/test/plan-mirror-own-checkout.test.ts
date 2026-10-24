import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ db: undefined as unknown, root: '', seed: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/secrets/user-git-identity.js', () => ({ resolveGitEnv: async () => ({}) }));
vi.mock('../src/plan/mirror.js', async (original) => ({
  ...(await original<typeof import('../src/plan/mirror.js')>()),
  flushPlanMirrorForRepository: async () => ({ repoPath: h.root, files: ['.haive-data/plan.md'] }),
  seedPlanBaseFromCheckout: h.seed,
  recordPlanMirrorError: async () => {},
}));
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { gitRun } from '../src/repo/git-exec.js';
import { pull, save } from '../src/queues/plan-mirror-queue.js';
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
it.each([
  ['save', save, false],
  ['pull', pull, false],
  ['save', save, true],
  ['pull', pull, true],
] as const)('%s refuses a nested checkout', async (_name, run, emptyGit) => {
  const base = await mkdtemp(path.join(tmpdir(), 'plan-own-'));
  dirs.push(base);
  const git = async (args: string[]) => {
    const result = await gitRun(base, args);
    expect(result.code, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  await git(['init', '-b', 'main']);
  await git([
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@example.test',
    'commit',
    '--allow-empty',
    '-m',
    'parent',
  ]);
  await git(['remote', 'add', 'origin', 'https://parent.test/r']);
  const before = await git(['rev-parse', 'HEAD']);
  h.root = path.join(base, 'nested');
  await mkdir(path.join(h.root, '.haive-data'), { recursive: true });
  if (emptyGit) await mkdir(path.join(h.root, '.git'));
  await writeFile(path.join(h.root, '.haive-data/plan.md'), 'plan');
  await writeFile(path.join(h.root, '.haive-data/plan.json'), '{}');
  const fake = createFakeDb({
    repositories: schema.repositories,
    tasks: schema.tasks,
    planMirrorState: schema.planMirrorState,
  });
  fake.insert(schema.repositories, {
    id: '00000000-0000-4000-8000-000000000001',
    userId: '00000000-0000-4000-8000-000000000002',
    storagePath: h.root,
  });
  fake.insert(schema.planMirrorState, {
    repositoryId: '00000000-0000-4000-8000-000000000001',
    revision: 1,
    writtenRevision: 1,
  });
  h.db = fake.db;
  h.seed.mockReset().mockRejectedValue(new Error('passed checkout boundary'));
  await expect(
    run({
      repositoryId: '00000000-0000-4000-8000-000000000001',
      userId: '00000000-0000-4000-8000-000000000002',
      push: false,
    }),
  ).rejects.toThrow(emptyGit ? /git cannot use it/ : /not a Git checkout/);
  expect(h.seed).not.toHaveBeenCalled();
  expect(await git(['rev-parse', 'HEAD'])).toBe(before);
  expect(await git(['diff', '--cached', '--name-only'])).toBe('');
  expect(await git(['remote', 'get-url', 'origin'])).toBe('https://parent.test/r');
});
