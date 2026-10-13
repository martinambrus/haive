import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitOperationInProgress } from '../src/repo/git-operation.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

describe('gitOperationInProgress', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'git-operation-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 'T');
    git(repo, 'config', 'gc.auto', '0');
    writeFileSync(join(repo, 'a.txt'), 'base\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('reads no operation in a clean checkout', async () => {
    expect(await gitOperationInProgress(repo)).toBe(false);
  });

  it('ignores a branch or tag named like the pseudorefs', async () => {
    git(repo, 'branch', 'MERGE_HEAD');
    git(repo, 'tag', 'REBASE_HEAD');
    expect(await gitOperationInProgress(repo)).toBe(false);
  });

  it('reads a git dir outside the checkout as an open operation, never anchoring there', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'git-operation-gitdir-'));
    try {
      git(repo, 'init', '-q', '--separate-git-dir', join(outside, 'git'));
      expect(await gitOperationInProgress(repo)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('sees a rebase whose state directory is present without REBASE_HEAD', async () => {
    mkdirSync(join(repo, '.git', 'rebase-merge'));
    expect(await gitOperationInProgress(repo)).toBe(true);
    rmSync(join(repo, '.git', 'rebase-merge'), { recursive: true });
    mkdirSync(join(repo, '.git', 'rebase-apply'));
    expect(await gitOperationInProgress(repo)).toBe(true);
  });

  it('sees a merge left open by a conflict', async () => {
    git(repo, 'checkout', '-q', '-b', 'other');
    writeFileSync(join(repo, 'a.txt'), 'theirs\n');
    git(repo, 'commit', '-q', '-am', 'theirs');
    git(repo, 'checkout', '-q', 'main');
    writeFileSync(join(repo, 'a.txt'), 'ours\n');
    git(repo, 'commit', '-q', '-am', 'ours');
    expect(() => git(repo, 'merge', '-q', 'other')).toThrow();
    expect(await gitOperationInProgress(repo)).toBe(true);
  });
});
