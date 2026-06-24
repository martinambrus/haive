import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, it, expect } from 'vitest';
import { buildMergeFixPrompt, completeMergeHostSide, mergeCommitted } from './git-merge.js';

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
