import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ensureDir = vi.hoisted(() => vi.fn());
vi.mock('@haive/shared/fs-safe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared/fs-safe')>();
  ensureDir.mockImplementation(actual.ensureDirNoFollow);
  return { ...actual, ensureDirNoFollow: ensureDir };
});

// WORKER_REPO_STORAGE_ROOT is read from the environment once, at import time, so the
// fixture root has to exist and be exported before the modules are pulled in.
const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'haive-worktrees-boundary-'));
process.env.REPO_STORAGE_ROOT = storageRoot;

const { worktreesBoundary } = await import('../src/queues/cli-exec/worktrees-boundary.js');

const USER_ID = '11111111-1111-1111-1111-111111111111';
const REPO_ID = '22222222-2222-2222-2222-222222222222';
const SUBPATH = `${USER_ID}/${REPO_ID}`;
const WORKDIR = '/haive/workdir';
const WORKTREES_REL = '.haive/worktrees';
const WORKTREE_REL = `${WORKTREES_REL}/feature`;

const rootMount = { source: 'haive_repos', target: WORKDIR, subpath: SUBPATH };
const worktreeMount = { ...rootMount, subpath: `${SUBPATH}/${WORKTREE_REL}` };
const root = { hasWorktree: false, hasRepo: true };

const repoDir = path.join(storageRoot, SUBPATH);
const haiveDir = path.join(repoDir, '.haive');
const worktreesDir = path.join(repoDir, WORKTREES_REL);
const elsewhere = path.join(repoDir, 'elsewhere');

const rootMounts = [
  { source: 'haive_repos', target: `${WORKDIR}/.haive`, subpath: `${SUBPATH}/.haive` },
  {
    source: 'haive_repos',
    target: `${WORKDIR}/${WORKTREES_REL}`,
    subpath: `${SUBPATH}/${WORKTREES_REL}`,
    readOnly: true,
  },
];

afterAll(async () => {
  await rm(storageRoot, { recursive: true, force: true });
});

// The target of every link below holds a real `worktrees` directory, so a lookup that followed
// the link would find the directory it expects and mount it.
beforeEach(async () => {
  ensureDir.mockClear();
  await rm(repoDir, { recursive: true, force: true });
  await mkdir(path.join(worktreesDir, 'feature'), { recursive: true });
  await mkdir(path.join(elsewhere, 'worktrees'), { recursive: true });
});

describe('worktreesBoundary: what an agent sandbox gets', () => {
  it('pins a repository root’s .haive read-write and mounts only its worktrees read-only', async () => {
    await mkdir(path.join(haiveDir, 'kb-draft'));
    await writeFile(path.join(worktreesDir, 'feature/file'), 'x');

    const mounts = await worktreesBoundary(rootMount, root);

    expect(mounts).toEqual(rootMounts);
    expect(mounts[0]!.readOnly).toBeUndefined();
    expect(mounts[1]!.readOnly).toBe(true);
    expect(ensureDir).not.toHaveBeenCalled();
  });

  it('gives a worktree invocation nothing, and creates nothing', async () => {
    await rm(haiveDir, { recursive: true, force: true });

    expect(await worktreesBoundary(worktreeMount, { hasWorktree: true, hasRepo: true })).toEqual(
      [],
    );
    expect(await readdir(repoDir)).toEqual(['elsewhere']);
    expect(ensureDir).not.toHaveBeenCalled();
  });

  it('claims nothing for a repo-less task, a bound local-path repository or no mount', async () => {
    const scratchSubpath = `${USER_ID}/_scratch/33333333-3333-3333-3333-333333333333`;
    const scratchDir = path.join(storageRoot, scratchSubpath);
    await mkdir(scratchDir, { recursive: true });
    const scratch = { source: 'haive_repos', target: WORKDIR, subpath: scratchSubpath };
    expect(await worktreesBoundary(scratch, { hasWorktree: false, hasRepo: false })).toEqual([]);
    expect(await readdir(scratchDir)).toEqual([]);

    // A read-only local-path repository is a bind with no subpath, already `:ro` whole.
    const bind = { source: '/home/someone/project', target: WORKDIR, readOnly: true };
    expect(await worktreesBoundary(bind, root)).toEqual([]);
    expect(await worktreesBoundary(null, root)).toEqual([]);
    expect(await worktreesBoundary(rootMount, { hasWorktree: false, hasRepo: false })).toEqual([]);
    expect(ensureDir).not.toHaveBeenCalled();
  });
});

describe('worktreesBoundary: what it creates', () => {
  it('creates an absent .haive/worktrees, and .haive, with the mount root’s owner', async () => {
    await rm(haiveDir, { recursive: true, force: true });
    const rootStat = await lstat(repoDir);

    const mounts = await worktreesBoundary(rootMount, root);

    expect(mounts).toEqual(rootMounts);
    expect(ensureDir.mock.calls).toEqual([
      [repoDir, WORKTREES_REL, { owner: { uid: rootStat.uid, gid: rootStat.gid } }],
    ]);
    for (const dir of [haiveDir, worktreesDir]) {
      const made = await lstat(dir);
      expect(made.isDirectory()).toBe(true);
      expect([made.uid, made.gid]).toEqual([rootStat.uid, rootStat.gid]);
    }
    expect(await readdir(haiveDir)).toEqual(['worktrees']);
  });

  it('creates only worktrees when .haive is there without it', async () => {
    await rm(worktreesDir, { recursive: true, force: true });
    await mkdir(path.join(haiveDir, 'kb-draft'));

    expect(await worktreesBoundary(rootMount, root)).toEqual(rootMounts);

    expect(ensureDir).toHaveBeenCalledTimes(1);
    expect(ensureDir.mock.calls[0]![1]).toBe(WORKTREES_REL);
    expect((await readdir(haiveDir)).sort()).toEqual(['kb-draft', 'worktrees']);
    expect(await readdir(worktreesDir)).toEqual([]);
  });

  it('never removes anything, and a second run changes nothing', async () => {
    await writeFile(path.join(worktreesDir, 'feature/file'), '{"keep":true}');

    const first = await worktreesBoundary(rootMount, root);
    const second = await worktreesBoundary(rootMount, root);

    expect(second).toEqual(first);
    expect(ensureDir).not.toHaveBeenCalled();
    expect(await readdir(path.join(worktreesDir, 'feature'))).toEqual(['file']);
  });

  it('survives eight invocations racing to create the same directories', async () => {
    await rm(haiveDir, { recursive: true, force: true });

    const results = await Promise.all(
      Array.from({ length: 8 }, () => worktreesBoundary(rootMount, root)),
    );

    for (const mounts of results) expect(mounts).toEqual(rootMounts);
    expect(await readdir(haiveDir)).toEqual(['worktrees']);
  });
});

describe('worktreesBoundary: what it refuses', () => {
  it('refuses a .haive that is a link an agent could replace, and creates nothing', async () => {
    await rm(haiveDir, { recursive: true, force: true });
    await symlink(elsewhere, haiveDir);

    await expect(worktreesBoundary(rootMount, root)).rejects.toThrow(
      /^\.haive in .* is a file or a link/,
    );
    expect(await readdir(elsewhere)).toEqual(['worktrees']);
    expect(await readdir(path.join(elsewhere, 'worktrees'))).toEqual([]);
    expect(ensureDir).not.toHaveBeenCalled();
  });

  it('refuses a .haive/worktrees that is a link, and creates nothing', async () => {
    await rm(worktreesDir, { recursive: true, force: true });
    await symlink(path.join(elsewhere, 'worktrees'), worktreesDir);

    await expect(worktreesBoundary(rootMount, root)).rejects.toThrow(
      /^\.haive\/worktrees in .* is a file or a link/,
    );
    expect(await readdir(path.join(elsewhere, 'worktrees'))).toEqual([]);
    expect(ensureDir).not.toHaveBeenCalled();
  });

  it('refuses a .haive or a .haive/worktrees that is a file, and creates nothing', async () => {
    await rm(haiveDir, { recursive: true, force: true });
    await writeFile(haiveDir, 'not a directory');
    await expect(worktreesBoundary(rootMount, root)).rejects.toThrow(
      /^\.haive in .* is a file or a link/,
    );

    await rm(haiveDir);
    await mkdir(haiveDir);
    await writeFile(worktreesDir, 'not a directory');
    await expect(worktreesBoundary(rootMount, root)).rejects.toThrow(
      /^\.haive\/worktrees in .* is a file or a link/,
    );
    expect(await readdir(haiveDir)).toEqual(['worktrees']);
    expect(ensureDir).not.toHaveBeenCalled();
  });

  it('refuses a mount root that is missing, and creates nothing', async () => {
    await rm(repoDir, { recursive: true, force: true });

    await expect(worktreesBoundary(rootMount, root)).rejects.toThrow(/is not a directory/);
    await expect(lstat(repoDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(ensureDir).not.toHaveBeenCalled();
  });
});
