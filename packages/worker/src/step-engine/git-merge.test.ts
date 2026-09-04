import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, it, expect } from 'vitest';
import {
  buildMergeFixPrompt,
  completeMergeHostSide,
  mergeCommitted,
  squashMergeCommit,
} from './git-merge.js';

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
// Strict (no undefined values) so it satisfies completeMergeHostSide's signature.
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
async function gitCode(dir: string, args: string[]): Promise<number> {
  try {
    await exec('git', args, { cwd: dir, env: GIT_ENV });
    return 0;
  } catch (e) {
    return (e as { code?: number }).code ?? 1;
  }
}

/** A repo on `main` whose `feature/x` diverges `base.txt` so a merge conflicts. */
async function setupConflict(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'gm-'));
  await git(dir, ['init', '-b', 'main']);
  await writeFile(path.join(dir, 'base.txt'), 'base\n', 'utf8');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', 'init']);
  await git(dir, ['checkout', '-b', 'feature/x']);
  await writeFile(path.join(dir, 'base.txt'), 'feature\n', 'utf8');
  await git(dir, ['commit', '-am', 'feature edit']);
  await git(dir, ['checkout', 'main']);
  await writeFile(path.join(dir, 'base.txt'), 'main\n', 'utf8');
  await git(dir, ['commit', '-am', 'main edit']);
  return dir;
}

describe('buildMergeFixPrompt', () => {
  it('includes the branch + title and the marker instructions', () => {
    const p = buildMergeFixPrompt('feature/x', 'My feature');
    expect(p).toContain('Conflicting branch: feature/x (My feature).');
    expect(p).toContain('<<<<<<< / ======= / >>>>>>>');
    expect(p).toContain('Do NOT run git');
  });
  it('omits the parenthetical when no title', () => {
    expect(buildMergeFixPrompt('feature/x')).toContain('Conflicting branch: feature/x.');
  });
  it('appends user guidance when provided', () => {
    expect(buildMergeFixPrompt('b', undefined, 'prefer mine')).toContain(
      'User guidance for resolving this conflict: prefer mine',
    );
  });
});

describe('mergeCommitted / completeMergeHostSide (real git)', () => {
  it('commits a resolved mid-merge host-side', async () => {
    const dir = await setupConflict();
    try {
      // Start the conflicting merge: non-zero exit, MERGE_HEAD live, markers in file.
      expect(await gitCode(dir, ['merge', '--no-ff', '--no-edit', 'feature/x'])).not.toBe(0);
      expect(await mergeCommitted(dir)).toBe(false);
      // Simulate the fix agent: write resolved content (no markers).
      await writeFile(path.join(dir, 'base.txt'), 'resolved\n', 'utf8');
      expect(await completeMergeHostSide(dir, COMMIT_ENV)).toBe(true);
      expect(await mergeCommitted(dir)).toBe(true);
      expect(await readFile(path.join(dir, 'base.txt'), 'utf8')).toBe('resolved\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses to commit while conflict markers remain', async () => {
    const dir = await setupConflict();
    try {
      await gitCode(dir, ['merge', '--no-ff', '--no-edit', 'feature/x']);
      // Leave the markers in place → completion must refuse.
      expect(await completeMergeHostSide(dir, COMMIT_ENV)).toBe(false);
      expect(await mergeCommitted(dir)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** A repo on `main` with a `feature/x` that adds two commits and does NOT conflict. */
async function setupCleanFeature(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'gs-'));
  await git(dir, ['init', '-b', 'main']);
  await writeFile(path.join(dir, 'base.txt'), 'base\n', 'utf8');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', 'init']);
  await git(dir, ['checkout', '-b', 'feature/x']);
  await writeFile(path.join(dir, 'one.txt'), 'one\n', 'utf8');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', 'ISS-1: one']);
  await writeFile(path.join(dir, 'two.txt'), 'two\n', 'utf8');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', 'ISS-2: two']);
  await git(dir, ['checkout', 'main']);
  return dir;
}

const count = async (dir: string, ref: string): Promise<number> =>
  Number((await git(dir, ['rev-list', '--count', ref])).trim());

describe('squashMergeCommit (real git)', () => {
  it('collapses a landed merge into one commit with an identical tree', async () => {
    const dir = await setupCleanFeature();
    try {
      const before = (await git(dir, ['rev-parse', 'HEAD'])).trim();
      expect(await gitCode(dir, ['merge', '--no-ff', '--no-edit', 'feature/x'])).toBe(0);
      // The un-squashed shape: 2 feature commits + the merge commit on top of main's 1.
      expect(await count(dir, 'main')).toBe(4);
      const mergedTree = (await git(dir, ['rev-parse', 'HEAD^{tree}'])).trim();

      const sha = await squashMergeCommit(dir, before, 'feat: squashed', COMMIT_ENV);
      expect(sha).toBeTruthy();
      expect(await count(dir, 'main')).toBe(2); // init + the single squash commit
      expect((await git(dir, ['rev-parse', 'HEAD^{tree}'])).trim()).toBe(mergedTree);
      expect((await git(dir, ['rev-parse', 'HEAD^'])).trim()).toBe(before);
      expect((await git(dir, ['log', '-1', '--format=%s'])).trim()).toBe('feat: squashed');
      // Nothing left staged or dirty.
      expect((await git(dir, ['status', '--porcelain'])).trim()).toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is a no-op when the merge changed nothing (already up to date)', async () => {
    const dir = await setupCleanFeature();
    try {
      await git(dir, ['merge', '--no-ff', '--no-edit', 'feature/x']);
      const after = (await git(dir, ['rev-parse', 'HEAD'])).trim();
      // A second merge of the same branch is "Already up to date" — nothing to collapse.
      expect(await squashMergeCommit(dir, after, 'feat: nothing', COMMIT_ENV)).toBeNull();
      expect((await git(dir, ['rev-parse', 'HEAD'])).trim()).toBe(after);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses to touch a LIVE merge (MERGE_HEAD present)', async () => {
    const dir = await setupConflict();
    try {
      const before = (await git(dir, ['rev-parse', 'HEAD'])).trim();
      expect(await gitCode(dir, ['merge', '--no-ff', '--no-edit', 'feature/x'])).not.toBe(0);
      expect(await squashMergeCommit(dir, before, 'feat: nope', COMMIT_ENV)).toBeNull();
      // The conflict loop still owns it: MERGE_HEAD and the markers survive.
      expect(await gitCode(dir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).toBe(0);
      expect(await readFile(path.join(dir, 'base.txt'), 'utf8')).toContain('<<<<<<<');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('finishes a crash-interrupted squash (HEAD reset, changes still staged)', async () => {
    const dir = await setupCleanFeature();
    try {
      const before = (await git(dir, ['rev-parse', 'HEAD'])).trim();
      await git(dir, ['merge', '--no-ff', '--no-edit', 'feature/x']);
      // Simulate a crash between the reset and the commit.
      await git(dir, ['reset', '--soft', before]);
      const sha = await squashMergeCommit(dir, before, 'feat: resumed', COMMIT_ENV);
      expect(sha).toBeTruthy();
      expect(await count(dir, 'main')).toBe(2);
      expect((await git(dir, ['log', '-1', '--format=%s'])).trim()).toBe('feat: resumed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
