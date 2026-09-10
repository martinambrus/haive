import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { carryUntrackedRuntimeFiles } from './carry-untracked.js';
import { WORKTREE_SUBDIR } from './worktree-paths.js';

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
async function git(dir: string, args: string[]): Promise<void> {
  await exec('git', args, { cwd: dir, env: GIT_ENV });
}

const dirs: string[] = [];
async function tmp(prefix: string): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function write(root: string, rel: string, body: string): Promise<void> {
  const abs = path.join(root, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, body, 'utf8');
}

/** A repo whose gitignored `test-playwright/.env` holds the credentials its suite reads —
 *  the shape measured on task ef954a3d. */
async function seedRepo(): Promise<string> {
  const repo = await tmp('carry-repo-');
  await git(repo, ['init', '-q', '-b', 'main']);
  await write(repo, '.gitignore', '.env\n');
  await write(repo, 'test-playwright/.env.sample', 'COMMON_DATA={"users":[]}\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'c1']);
  await write(repo, 'test-playwright/.env', 'COMMON_DATA={"users":[{"user":"real"}]}\n');
  return repo;
}

describe('carryUntrackedRuntimeFiles', () => {
  it('copies an untracked .env the worktree checkout could not carry', async () => {
    const repo = await seedRepo();
    const wt = await tmp('carry-wt-');

    const res = await carryUntrackedRuntimeFiles(repo, wt);

    expect(res.copied).toEqual(['test-playwright/.env']);
    expect(await readFile(path.join(wt, 'test-playwright/.env'), 'utf8')).toContain('"real"');
  });

  it('leaves tracked files alone — the checkout already has them', async () => {
    const repo = await seedRepo();
    const wt = await tmp('carry-wt-');

    const res = await carryUntrackedRuntimeFiles(repo, wt);

    // .env.sample matches the `**/.env.*` deny glob but is committed, so the worktree's own
    // copy is authoritative. Copying the root's would silently revert a branch that edited it.
    expect(res.copied).not.toContain('test-playwright/.env.sample');
  });

  it('never overwrites a file already present in the worktree', async () => {
    const repo = await seedRepo();
    const wt = await tmp('carry-wt-');
    await write(wt, 'test-playwright/.env', 'COMMON_DATA={"users":[{"user":"branch"}]}\n');

    const res = await carryUntrackedRuntimeFiles(repo, wt);

    expect(res.copied).toEqual([]);
    expect(res.skippedExisting).toBe(1);
    expect(await readFile(path.join(wt, 'test-playwright/.env'), 'utf8')).toContain('"branch"');
  });

  it('does not descend into sibling worktrees', async () => {
    const repo = await seedRepo();
    // A linked worktree lives UNDER the repo root, and SECRET_SCAN_IGNORE_DIRS does not
    // exclude it — without the explicit ignore this file is carried into the new worktree.
    await write(repo, `${WORKTREE_SUBDIR}/other-task/test-playwright/.env`, 'SIBLING\n');
    const wt = await tmp('carry-wt-');

    const res = await carryUntrackedRuntimeFiles(repo, wt);

    expect(res.copied).toEqual(['test-playwright/.env']);
    expect(res.copied.some((p) => p.startsWith(WORKTREE_SUBDIR))).toBe(false);
  });

  it('reports a file it could not read without failing the rest', async () => {
    const repo = await seedRepo();
    await write(repo, 'unreadable/.env', 'x\n');
    await chmod(path.join(repo, 'unreadable/.env'), 0o000);
    const wt = await tmp('carry-wt-');

    const res = await carryUntrackedRuntimeFiles(repo, wt);

    // Root ignores mode bits, so this only exercises the failure path unprivileged.
    if (res.failed > 0) expect(res.copied).toContain('test-playwright/.env');
    else expect(res.copied).toEqual(['test-playwright/.env', 'unreadable/.env']);
  });

  it('honours the per-repo allow globs, so the carried set matches the masked set', async () => {
    const repo = await seedRepo();
    const wt = await tmp('carry-wt-');

    const res = await carryUntrackedRuntimeFiles(repo, wt, { allow: ['test-playwright/.env'] });

    expect(res.copied).toEqual([]);
  });

  it('returns empty for a root that holds nothing matching', async () => {
    const repo = await tmp('carry-empty-');
    await git(repo, ['init', '-q', '-b', 'main']);
    const wt = await tmp('carry-wt-');

    const res = await carryUntrackedRuntimeFiles(repo, wt);

    expect(res).toEqual({ copied: [], skippedExisting: 0, failed: 0 });
  });
});
