import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { SHARED_VOLUME, volumeName } from '@haive/shared';

const h = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: h.exec }) };
});
vi.mock('../src/sandbox/sandbox-core-image.js', () => ({ ensureSandboxCoreImage: async () => {} }));
vi.mock('../src/sandbox/docker-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/docker-runner.js')>()),
  defaultDockerRunner: {
    volumeExists: async () => true,
    run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  },
}));

// WORKER_REPO_STORAGE_ROOT is read from the environment once, at import time, so the
// fixture root has to exist and be exported before the editor module is pulled in.
const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'haive-ide-boundary-'));
process.env.REPO_STORAGE_ROOT = storageRoot;

const { ensureRepoIdeRunnerStarted } = await import('../src/sandbox/ide-runner.js');

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const SUBPATH = `${USER}/${REPO}`;

afterAll(async () => {
  await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  h.exec.mockReset().mockImplementation(async (_command, args: string[]) => {
    if (args[0] === 'inspect') throw new Error('container missing');
    return { stdout: '{"status":"alive"}', stderr: '' };
  });
  await rm(path.join(storageRoot, SUBPATH), { recursive: true, force: true });
  for (const name of ['state', 'knowledge_base', 'learnings']) {
    await mkdir(path.join(storageRoot, SUBPATH, '.haive-data', name), { recursive: true });
  }
  await mkdir(path.join(storageRoot, SUBPATH, '.git'));
});

describe('the repository editor is a human surface', () => {
  it('carries the read-only .git it always had, and no .haive-data mount', async () => {
    const fake = createFakeDb({ repositories: schema.repositories });
    fake.insert(schema.repositories, {
      id: REPO,
      userId: USER,
      source: 'git_url',
      status: 'ready',
      storagePath: `${storageRoot}/${SUBPATH}`,
    });

    await ensureRepoIdeRunnerStarted(fake.db as unknown as Database, REPO, USER, '{}');

    const runs = h.exec.mock.calls.filter(([, args]) => args[0] === 'run' && args[1] === '-d');
    expect(runs).toHaveLength(1);
    const args = runs[0]![1] as string[];
    const repos = volumeName(SHARED_VOLUME.repos);
    expect(args.filter((_arg, index) => args[index - 1] === '--mount')).toEqual([
      `type=volume,source=${repos},destination=/workspace/.git,volume-subpath=${SUBPATH}/.git,volume-nocopy=true,readonly`,
      `type=volume,source=${repos},destination=/workspace,volume-subpath=${SUBPATH},volume-nocopy=true`,
    ]);
  });
});
