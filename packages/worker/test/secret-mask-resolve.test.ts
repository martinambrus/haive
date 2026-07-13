import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { configService } from '@haive/shared';

// WORKER_REPO_STORAGE_ROOT is read from the environment once, at import time, so the
// fixture root has to exist and be exported before secret-mask.js is pulled in.
const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'haive-repo-storage-'));
process.env.REPO_STORAGE_ROOT = storageRoot;

const { resolveSecretMasks, SecretMaskError } =
  await import('../src/queues/cli-exec/secret-mask.js');

const USER_ID = '11111111-1111-1111-1111-111111111111';
const REPO_ID = '22222222-2222-2222-2222-222222222222';
const TASK_ID = '33333333-3333-3333-3333-333333333333';

type Row = Record<string, unknown> | undefined;

/** Minimal stand-in for the two `db.query.*.findFirst` calls resolveSecretMasks makes. */
function fakeDb(task: Row, repo: Row): Database {
  return {
    query: {
      tasks: { findFirst: () => Promise.resolve(task) },
      repositories: { findFirst: () => Promise.resolve(repo) },
    },
  } as unknown as Database;
}

const enabledRepo = {
  storagePath: null,
  localPath: null,
  secretMaskEnabled: true,
  secretMaskAllow: null,
  secretMaskDenyExtend: null,
};

beforeEach(async () => {
  vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
  await rm(path.join(storageRoot, USER_ID), { recursive: true, force: true });
  await mkdir(path.join(storageRoot, USER_ID, REPO_ID), { recursive: true });
});

afterAll(async () => {
  await rm(storageRoot, { recursive: true, force: true });
});

describe('resolveSecretMasks', () => {
  it('scans the named-volume subpath when the repo row carries no storage_path', async () => {
    // resolveTaskRepoMount mounts `${userId}/${repositoryId}` from the haive_repos
    // volume whenever the path is not a /host-fs bind — including when storage_path was
    // never written. Bailing to [] here left that tree mounted and unmasked.
    await writeFile(path.join(storageRoot, USER_ID, REPO_ID, '.env'), 'SECRET=1\n');

    const masks = await resolveSecretMasks(
      fakeDb({ userId: USER_ID, repositoryId: REPO_ID }, enabledRepo),
      TASK_ID,
    );

    expect(masks).toEqual([{ containerPath: '/haive/workdir/.env', content: '' }]);
  });

  it('scans the worktree subpath (not the repo root) when the mount is a worktree', async () => {
    // Per-invocation isolation mounts the worktree ALONE at the workdir root; the mask must
    // scan THAT tree's own untracked secrets and target the mount root.
    const wtDir = path.join(storageRoot, USER_ID, REPO_ID, '.haive', 'worktrees', 'feature-x');
    await mkdir(wtDir, { recursive: true });
    await writeFile(path.join(wtDir, '.env'), 'SECRET=1\n');

    const masks = await resolveSecretMasks(
      fakeDb({ userId: USER_ID, repositoryId: REPO_ID }, enabledRepo),
      TASK_ID,
      {
        source: 'haive_repos',
        target: '/haive/workdir',
        subpath: `${USER_ID}/${REPO_ID}/.haive/worktrees/feature-x`,
      },
    );

    expect(masks).toEqual([{ containerPath: '/haive/workdir/.env', content: '' }]);
  });

  it('throws rather than reporting a clean scan when the repo tree is not where we look', async () => {
    // A wrong REPO_STORAGE_ROOT, an unmounted volume, or a repo whose files were never
    // written all look like "this repo has no secrets" to the scan, while the sandbox
    // mount still binds the real tree.
    await rm(path.join(storageRoot, USER_ID), { recursive: true, force: true });

    const err = await resolveSecretMasks(
      fakeDb({ userId: USER_ID, repositoryId: REPO_ID }, enabledRepo),
      TASK_ID,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SecretMaskError);
    expect((err as Error).message).toContain('is not a readable directory');
  });

  it('throws rather than reporting a clean scan when the task row is missing', async () => {
    const err = await resolveSecretMasks(fakeDb(undefined, enabledRepo), TASK_ID).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SecretMaskError);
    expect((err as Error).message).toContain(`task ${TASK_ID} not found`);
  });

  it('throws rather than reporting a clean scan when the repository row is missing', async () => {
    const err = await resolveSecretMasks(
      fakeDb({ userId: USER_ID, repositoryId: REPO_ID }, undefined),
      TASK_ID,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretMaskError);
    expect((err as Error).message).toContain(`repository ${REPO_ID}`);
  });

  it('returns no masks for a repo-less task: nothing is mounted, nothing to hide', async () => {
    const masks = await resolveSecretMasks(
      fakeDb({ userId: USER_ID, repositoryId: null }, undefined),
      TASK_ID,
    );
    expect(masks).toEqual([]);
  });

  it('returns no masks when masking is off for the repo', async () => {
    await writeFile(path.join(storageRoot, USER_ID, REPO_ID, '.env'), 'SECRET=1\n');
    const masks = await resolveSecretMasks(
      fakeDb(
        { userId: USER_ID, repositoryId: REPO_ID },
        { ...enabledRepo, secretMaskEnabled: false },
      ),
      TASK_ID,
    );
    expect(masks).toEqual([]);
  });

  it('returns no masks when the global kill-switch is off', async () => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    const masks = await resolveSecretMasks(fakeDb(undefined, undefined), TASK_ID);
    expect(masks).toEqual([]);
  });
});
