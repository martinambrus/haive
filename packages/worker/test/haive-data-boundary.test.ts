import { link, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
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
const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'haive-data-boundary-'));
process.env.REPO_STORAGE_ROOT = storageRoot;

const { haiveDataBoundary } = await import('../src/queues/cli-exec/haive-data-boundary.js');
const { lookupInRepoMount, repoGitDataBoundary } =
  await import('../src/queues/cli-exec/gitfile-mask.js');

const USER_ID = '11111111-1111-1111-1111-111111111111';
const REPO_ID = '22222222-2222-2222-2222-222222222222';
const SUBPATH = `${USER_ID}/${REPO_ID}`;
const WORKDIR = '/haive/workdir';
const WORKTREE_REL = '.haive/worktrees/feature';

const rootMount = { source: 'haive_repos', target: WORKDIR, subpath: SUBPATH };
const worktreeMount = { ...rootMount, subpath: `${SUBPATH}/${WORKTREE_REL}` };

const repoDir = path.join(storageRoot, SUBPATH);
const treeDir = path.join(repoDir, WORKTREE_REL);

const rootMounts = (children: string[]) => [
  {
    source: 'haive_repos',
    target: `${WORKDIR}/.haive-data`,
    subpath: `${SUBPATH}/.haive-data`,
    readOnly: true,
  },
  ...children.map((name) => ({
    source: 'haive_repos',
    target: `${WORKDIR}/.haive-data/${name}`,
    subpath: `${SUBPATH}/.haive-data/${name}`,
  })),
];

const worktreeMounts = (children: string[]) => [
  {
    source: 'haive_repos',
    target: `${WORKDIR}/.haive-data`,
    subpath: `${SUBPATH}/${WORKTREE_REL}/.haive-data`,
    readOnly: true,
  },
  ...children.map((name) => ({
    source: 'haive_repos',
    target: `${WORKDIR}/.haive-data/${name}`,
    subpath: `${SUBPATH}/${WORKTREE_REL}/.haive-data/${name}`,
  })),
];

afterAll(async () => {
  await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  ensureDir.mockClear();
  await rm(repoDir, { recursive: true, force: true });
  await mkdir(treeDir, { recursive: true });
});

const dirs = (...rels: string[]) => Promise.all(rels.map((r) => mkdir(r, { recursive: true })));

describe('haiveDataBoundary: what an agent sandbox gets', () => {
  it('mounts a repository root’s .haive-data read-only, with the two knowledge dirs read-write on top', async () => {
    await dirs(
      path.join(repoDir, '.haive-data/state'),
      path.join(repoDir, '.haive-data/knowledge_base'),
      path.join(repoDir, '.haive-data/learnings'),
    );
    await writeFile(path.join(repoDir, '.haive-data/plan.json'), '{}');

    const mounts = await haiveDataBoundary(rootMount, { hasRepo: true });

    expect(mounts).toEqual(rootMounts(['knowledge_base', 'learnings']));
    expect(mounts[0]!.readOnly).toBe(true);
    for (const child of mounts.slice(1)) expect(child.readOnly).toBeUndefined();
    expect(ensureDir).not.toHaveBeenCalled();
  });

  it('does the same for a worktree, looked up from the repository root and not the worktree', async () => {
    await dirs(
      path.join(treeDir, '.haive-data/state'),
      path.join(treeDir, '.haive-data/knowledge_base'),
      path.join(treeDir, '.haive-data/learnings'),
      // A decoy at the repository root: it must not be what the worktree's mounts are built from.
      path.join(repoDir, '.haive-data/knowledge_base'),
    );

    expect(await haiveDataBoundary(worktreeMount, { hasRepo: true })).toEqual(
      worktreeMounts(['knowledge_base', 'learnings']),
    );
  });

  it('mounts no knowledge_base when the worktree has none, whatever the root holds', async () => {
    await dirs(
      path.join(treeDir, '.haive-data/learnings'),
      path.join(repoDir, '.haive-data/knowledge_base'),
    );

    expect(await haiveDataBoundary(worktreeMount, { hasRepo: true })).toEqual(
      worktreeMounts(['learnings']),
    );
  });
});

describe('haiveDataBoundary: what it creates', () => {
  it('creates an absent .haive-data and learnings with the mount root’s owner, and never knowledge_base', async () => {
    const root = await lstat(repoDir);
    const owner = { owner: { uid: root.uid, gid: root.gid } };

    const mounts = await haiveDataBoundary(rootMount, { hasRepo: true });

    expect(mounts).toEqual(rootMounts(['learnings']));
    expect(ensureDir.mock.calls).toEqual([
      [repoDir, '.haive-data', owner],
      [repoDir, '.haive-data/learnings', owner],
    ]);
    expect((await lstat(path.join(repoDir, '.haive-data'))).isDirectory()).toBe(true);
    expect((await lstat(path.join(repoDir, '.haive-data/learnings'))).isDirectory()).toBe(true);
    expect(await readdir(path.join(repoDir, '.haive-data'))).toEqual(['learnings']);
  });

  it('creates inside a worktree the same way, walked from the repository root', async () => {
    const root = await lstat(treeDir);
    const owner = { owner: { uid: root.uid, gid: root.gid } };

    const mounts = await haiveDataBoundary(worktreeMount, { hasRepo: true });

    expect(mounts).toEqual(worktreeMounts(['learnings']));
    expect(ensureDir.mock.calls).toEqual([
      [repoDir, `${WORKTREE_REL}/.haive-data`, owner],
      [repoDir, `${WORKTREE_REL}/.haive-data/learnings`, owner],
    ]);
    expect(await readdir(path.join(treeDir, '.haive-data'))).toEqual(['learnings']);
    await expect(lstat(path.join(repoDir, '.haive-data'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('creates only learnings when .haive-data is there without it', async () => {
    await dirs(path.join(repoDir, '.haive-data/state'));

    const mounts = await haiveDataBoundary(rootMount, { hasRepo: true });

    expect(mounts).toEqual(rootMounts(['learnings']));
    expect(ensureDir).toHaveBeenCalledTimes(1);
    expect(ensureDir.mock.calls[0]![1]).toBe('.haive-data/learnings');
    expect((await readdir(path.join(repoDir, '.haive-data'))).sort()).toEqual([
      'learnings',
      'state',
    ]);
  });

  it('never removes anything, and a second run changes nothing', async () => {
    await dirs(path.join(repoDir, '.haive-data/state'));
    await writeFile(path.join(repoDir, '.haive-data/state/format.json'), '{"keep":true}');

    const first = await haiveDataBoundary(rootMount, { hasRepo: true });
    ensureDir.mockClear();
    const second = await haiveDataBoundary(rootMount, { hasRepo: true });

    expect(second).toEqual(first);
    expect(ensureDir).not.toHaveBeenCalled();
    expect(await readdir(path.join(repoDir, '.haive-data/state'))).toEqual(['format.json']);
  });

  it('survives eight invocations racing to create the same directories', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => haiveDataBoundary(rootMount, { hasRepo: true })),
    );

    for (const mounts of results) expect(mounts).toEqual(rootMounts(['learnings']));
    expect((await readdir(path.join(repoDir, '.haive-data'))).sort()).toEqual(['learnings']);
  });
});

describe('haiveDataBoundary: what it refuses', () => {
  it('refuses a .haive-data that is a link an agent could replace, and creates nothing', async () => {
    await mkdir(path.join(repoDir, 'elsewhere'));
    await symlink(path.join(repoDir, 'elsewhere'), path.join(repoDir, '.haive-data'));

    await expect(haiveDataBoundary(rootMount, { hasRepo: true })).rejects.toThrow(
      /\.haive-data in .* is a file or a link/,
    );
    expect(await readdir(path.join(repoDir, 'elsewhere'))).toEqual([]);
    expect(ensureDir).not.toHaveBeenCalled();
  });

  it('refuses a .haive-data that is a file, and creates nothing', async () => {
    await writeFile(path.join(repoDir, '.haive-data'), 'not a directory');

    await expect(haiveDataBoundary(rootMount, { hasRepo: true })).rejects.toThrow(
      /is a file or a link/,
    );
    expect(ensureDir).not.toHaveBeenCalled();
  });

  it('refuses a worktree root that is missing or is a link, and creates nothing', async () => {
    await rm(treeDir, { recursive: true, force: true });
    await expect(haiveDataBoundary(worktreeMount, { hasRepo: true })).rejects.toThrow(
      /is not a directory/,
    );
    await expect(lstat(treeDir)).rejects.toMatchObject({ code: 'ENOENT' });

    await mkdir(path.join(repoDir, 'elsewhere'));
    await symlink(path.join(repoDir, 'elsewhere'), treeDir);
    await expect(haiveDataBoundary(worktreeMount, { hasRepo: true })).rejects.toThrow(
      /is not a directory/,
    );
    expect(await readdir(path.join(repoDir, 'elsewhere'))).toEqual([]);
    expect(ensureDir).not.toHaveBeenCalled();
  });
});

describe('haiveDataBoundary: protected files with another name', () => {
  it('refuses a protected file with a hard link elsewhere in the checkout', async () => {
    await dirs(path.join(repoDir, '.haive-data/state'));
    await writeFile(path.join(repoDir, '.haive-data/state/format.json'), '{}');
    await link(
      path.join(repoDir, '.haive-data/state/format.json'),
      path.join(repoDir, 'alias.json'),
    );

    await expect(haiveDataBoundary(rootMount, { hasRepo: true })).rejects.toThrow(
      /\.haive-data\/state\/format\.json in .* has another hard link/,
    );
  });

  it('refuses one linked from a writable knowledge dir, in a worktree too', async () => {
    const data = path.join(treeDir, '.haive-data');
    await dirs(path.join(data, 'knowledge_base'));
    await writeFile(path.join(data, 'plan.json'), '{}');
    await link(path.join(data, 'plan.json'), path.join(data, 'knowledge_base/plan.md'));

    await expect(haiveDataBoundary(worktreeMount, { hasRepo: true })).rejects.toThrow(
      /\.haive-data\/plan\.json in .* has another hard link/,
    );
  });

  it('mounts as usual when every name sits in the read-only part or inside one knowledge dir', async () => {
    const data = path.join(repoDir, '.haive-data');
    await dirs(path.join(data, 'state'), path.join(data, 'knowledge_base'));
    await writeFile(path.join(data, 'state/a.json'), '{}');
    await link(path.join(data, 'state/a.json'), path.join(data, 'state/.a.json.haive-park-1-x'));
    await writeFile(path.join(data, 'knowledge_base/a.md'), 'a');
    await link(path.join(data, 'knowledge_base/a.md'), path.join(data, 'knowledge_base/b.md'));

    expect(await haiveDataBoundary(rootMount, { hasRepo: true })).toEqual(
      rootMounts(['knowledge_base', 'learnings']),
    );
  });
});

describe('haiveDataBoundary: what it leaves alone', () => {
  it('gives no mount for a knowledge dir that is a link or a file, and creates neither', async () => {
    await dirs(path.join(repoDir, '.haive-data'), path.join(repoDir, 'elsewhere'));
    await symlink(
      path.join(repoDir, 'elsewhere'),
      path.join(repoDir, '.haive-data/knowledge_base'),
    );
    await writeFile(path.join(repoDir, '.haive-data/learnings'), 'not a directory');

    expect(await haiveDataBoundary(rootMount, { hasRepo: true })).toEqual(rootMounts([]));
    expect(ensureDir).not.toHaveBeenCalled();
    expect(await readdir(path.join(repoDir, 'elsewhere'))).toEqual([]);
  });

  it('claims nothing for a repo-less task, a bound local-path repository or no mount', async () => {
    const scratchSubpath = `${USER_ID}/_scratch/33333333-3333-3333-3333-333333333333`;
    const scratchDir = path.join(storageRoot, scratchSubpath);
    await mkdir(scratchDir, { recursive: true });
    const scratch = { source: 'haive_repos', target: WORKDIR, subpath: scratchSubpath };
    expect(await haiveDataBoundary(scratch, { hasRepo: false })).toEqual([]);
    expect(await readdir(scratchDir)).toEqual([]);

    // A read-only local-path repository is a bind with no subpath, already `:ro` whole.
    const bind = { source: '/home/someone/project', target: WORKDIR, readOnly: true };
    expect(await haiveDataBoundary(bind, { hasRepo: true })).toEqual([]);
    expect(await haiveDataBoundary(null, { hasRepo: true })).toEqual([]);
    expect(await haiveDataBoundary(rootMount, { hasRepo: false })).toEqual([]);
    expect(await readdir(repoDir)).toEqual(['.haive']);
    expect(ensureDir).not.toHaveBeenCalled();
  });
});

describe('the lookup both boundaries share', () => {
  it('refuses a subpath that does not name <userId>/<repoId>, instead of looking it up', async () => {
    const bad = { source: 'haive_repos', target: WORKDIR, subpath: 'only-one-segment' };
    const refusal = 'does not name <userId>/<repoId>';

    await expect(lookupInRepoMount(bad.subpath, '.git')).rejects.toThrow(refusal);
    await expect(repoGitDataBoundary(bad, { hasWorktree: false, hasRepo: true })).rejects.toThrow(
      refusal,
    );
    await expect(haiveDataBoundary(bad, { hasRepo: true })).rejects.toThrow(refusal);
  });
});
