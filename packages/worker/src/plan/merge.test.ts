import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, it, expect, afterEach } from 'vitest';
import {
  abortMerge,
  commitMerge,
  conflictedPaths,
  divergence,
  ensurePlanMergeWorktree,
  landPlanMerge,
  mergeOriginInto,
  planMergeWorktreePath,
  removePlanMergeWorktree,
} from './merge.js';

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
const COMMIT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd: dir, env: GIT_ENV });
  return stdout.toString();
}

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function write(dir: string, file: string, body: string): Promise<void> {
  const full = path.join(dir, file);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, body, 'utf8');
}

/**
 * The exact shape that prompted this feature: a Haive blank repo (its own README plus
 * a plan snapshot) and a remote created independently (its own README), sharing NO
 * commit.
 */
async function unrelatedPair(): Promise<{ local: string; remote: string }> {
  const remote = await mkdtemp(path.join(tmpdir(), 'planmerge-remote-'));
  const local = await mkdtemp(path.join(tmpdir(), 'planmerge-local-'));
  dirs.push(remote, local);

  await git(remote, ['init', '-b', 'main']);
  await write(remote, 'README.md', '# vareska\n\nfrom the forge\n');
  await git(remote, ['add', '-A']);
  await git(remote, ['commit', '-m', 'Initial commit']);

  await git(local, ['init', '-b', 'main']);
  await write(local, 'README.md', '# vareska-claude\n\nCreated by Haive as a blank project.\n');
  await write(local, '.haive-data/plan.json', '{"nodes":["local"]}\n');
  await write(local, '.haive-data/plan.md', '# Plan\n\nlocal\n');
  await git(local, ['add', '-A']);
  await git(local, ['commit', '-m', 'chore: initialise blank repository']);
  await git(local, ['remote', 'add', 'origin', remote]);
  await git(local, ['fetch', 'origin', 'main']);
  return { local, remote };
}

describe('divergence', () => {
  it('reports unrelated histories rather than a merge base', async () => {
    const { local } = await unrelatedPair();
    const d = await divergence(local, 'main');
    expect(d.unrelated).toBe(true);
    // Both sides count in full: with no common ancestor there is nothing shared.
    expect(d.behind).toBeGreaterThan(0);
    expect(d.ahead).toBeGreaterThan(0);
  });

  it('counts a plain fast-forward as behind, not unrelated', async () => {
    const { remote } = await unrelatedPair();
    const clone = await mkdtemp(path.join(tmpdir(), 'planmerge-clone-'));
    dirs.push(clone);
    await git(clone, ['clone', remote, '.']);
    // The remote moves on. Committed in place rather than pushed: a non-bare repo
    // refuses a push to its checked-out branch, which is a property of the fixture,
    // not of anything under test.
    await write(remote, 'later.txt', 'x\n');
    await git(remote, ['add', '-A']);
    await git(remote, ['commit', '-m', 'later']);
    await git(clone, ['fetch', 'origin', 'main']);

    const d = await divergence(clone, 'main');
    expect(d.unrelated).toBe(false);
    expect(d.behind).toBe(1);
    expect(d.ahead).toBe(0);
  });
});

describe('ensurePlanMergeWorktree', () => {
  it('creates a detached worktree at HEAD and is idempotent', async () => {
    const { local } = await unrelatedPair();
    const first = await ensurePlanMergeWorktree(local);
    expect(first).toBe(planMergeWorktreePath(local));
    // Detached: no branch is checked out there, so the main tree keeps `main`.
    expect((await git(first, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('HEAD');
    expect((await git(first, ['rev-parse', 'HEAD'])).trim()).toBe(
      (await git(local, ['rev-parse', 'HEAD'])).trim(),
    );
    await expect(ensurePlanMergeWorktree(local)).resolves.toBe(first);
  });

  it('removes cleanly', async () => {
    const { local } = await unrelatedPair();
    await ensurePlanMergeWorktree(local);
    await removePlanMergeWorktree(local);
    const list = await git(local, ['worktree', 'list', '--porcelain']);
    expect(list).not.toContain(planMergeWorktreePath(local));
  });
});

describe('mergeOriginInto', () => {
  it('needs the unrelated-histories flag, and reports the add/add conflict', async () => {
    const { local } = await unrelatedPair();
    const wt = await ensurePlanMergeWorktree(local);
    const d = await divergence(local, 'main');

    // Without the flag git refuses outright — the reason this feature exists. It
    // must THROW, not report a clean merge: no merge starts, so nothing is
    // conflicted, and a caller reading only the conflict list would land nothing.
    await expect(mergeOriginInto(wt, 'main', false, COMMIT_ENV)).rejects.toThrow(
      /could not start/i,
    );

    const attempt = await mergeOriginInto(wt, 'main', d.unrelated, COMMIT_ENV);
    expect(attempt.unrelated).toBe(true);
    expect(attempt.clean).toBe(false);
    expect(attempt.conflicts).toEqual(['README.md']);
  });

  it('auto-resolves the plan mirror files and keeps them out of the conflict list', async () => {
    const { local, remote } = await unrelatedPair();
    // The other side has a plan snapshot too, so plan.json collides as well.
    await write(remote, '.haive-data/plan.json', '{"nodes":["remote"]}\n');
    await write(remote, '.haive-data/plan.md', '# Plan\n\nremote\n');
    await git(remote, ['add', '-A']);
    await git(remote, ['commit', '-m', 'remote plan']);
    await git(local, ['fetch', 'origin', 'main']);

    const wt = await ensurePlanMergeWorktree(local);
    const attempt = await mergeOriginInto(
      wt,
      'main',
      (await divergence(local, 'main')).unrelated,
      COMMIT_ENV,
    );

    expect(attempt.autoResolved.sort()).toEqual(['.haive-data/plan.json', '.haive-data/plan.md']);
    // Only the real conflict is handed on; the plan files never reach a person.
    expect(attempt.conflicts).toEqual(['README.md']);
    // Incoming side taken, which is what reconcilePlanMirror has to read.
    expect(await readFile(path.join(wt, '.haive-data/plan.json'), 'utf8')).toContain('remote');
  });

  it('is clean when only the plan files collide', async () => {
    const { local, remote } = await unrelatedPair();
    // Same README on both sides, so it is not a conflict; only the plan differs.
    await write(remote, 'README.md', '# vareska-claude\n\nCreated by Haive as a blank project.\n');
    await write(remote, '.haive-data/plan.json', '{"nodes":["remote"]}\n');
    await write(remote, '.haive-data/plan.md', '# Plan\n\nremote\n');
    await git(remote, ['add', '-A']);
    await git(remote, ['commit', '-m', 'remote plan']);
    await git(local, ['fetch', 'origin', 'main']);

    const wt = await ensurePlanMergeWorktree(local);
    const attempt = await mergeOriginInto(
      wt,
      'main',
      (await divergence(local, 'main')).unrelated,
      COMMIT_ENV,
    );
    expect(attempt.conflicts).toEqual([]);
    expect(attempt.clean).toBe(true);
  });
});

describe('landPlanMerge', () => {
  it('fast-forwards the real branch onto the resolved merge', async () => {
    const { local } = await unrelatedPair();
    const before = (await git(local, ['rev-parse', 'HEAD'])).trim();
    const wt = await ensurePlanMergeWorktree(local);
    await mergeOriginInto(wt, 'main', (await divergence(local, 'main')).unrelated, COMMIT_ENV);

    // Resolve the one real conflict the way an agent would: edit, then stage.
    await write(wt, 'README.md', '# vareska\n\nboth sides\n');
    await git(wt, ['add', 'README.md']);
    const sha = await commitMerge(wt, 'Merge origin/main', COMMIT_ENV);
    expect(sha).toBeTruthy();

    await landPlanMerge(local, sha!);
    expect((await git(local, ['rev-parse', 'HEAD'])).trim()).toBe(sha);
    // The merge carries the old HEAD as its first parent, which is what made the
    // fast-forward legal — and is the single-command undo.
    expect((await git(local, ['rev-parse', `${sha}^1`])).trim()).toBe(before);
    expect(await readFile(path.join(local, 'README.md'), 'utf8')).toContain('both sides');
  });

  it('refuses rather than resetting when the checkout moved underneath', async () => {
    const { local } = await unrelatedPair();
    const wt = await ensurePlanMergeWorktree(local);
    await mergeOriginInto(wt, 'main', (await divergence(local, 'main')).unrelated, COMMIT_ENV);
    await write(wt, 'README.md', 'merged\n');
    await git(wt, ['add', 'README.md']);
    const sha = await commitMerge(wt, 'Merge origin/main', COMMIT_ENV);

    // Someone commits to the checkout while the conversation is open.
    await write(local, 'unrelated.txt', 'meanwhile\n');
    await git(local, ['add', '-A']);
    await git(local, ['commit', '-m', 'meanwhile']);

    await expect(landPlanMerge(local, sha!)).rejects.toThrow(/checkout moved/i);
  });
});

describe('abortMerge', () => {
  it('leaves the worktree at its pre-merge commit', async () => {
    const { local } = await unrelatedPair();
    const wt = await ensurePlanMergeWorktree(local);
    const before = (await git(wt, ['rev-parse', 'HEAD'])).trim();
    await mergeOriginInto(wt, 'main', (await divergence(local, 'main')).unrelated, COMMIT_ENV);
    expect((await conflictedPaths(wt)).length).toBeGreaterThan(0);

    await abortMerge(wt);
    expect(await conflictedPaths(wt)).toEqual([]);
    expect((await git(wt, ['rev-parse', 'HEAD'])).trim()).toBe(before);
  });
});
