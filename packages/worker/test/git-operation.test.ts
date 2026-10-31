import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitTimeoutLimits } from '../src/repo/git-exec.js';
import { gitOperationInProgress } from '../src/repo/git-operation.js';
import { failGit, noGit, type FakeGit } from './support/fake-git.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

function openMerge(repo: string): void {
  git(repo, 'checkout', '-q', '-b', 'other');
  writeFileSync(join(repo, 'a.txt'), 'theirs\n');
  git(repo, 'commit', '-q', '-am', 'theirs');
  git(repo, 'checkout', '-q', 'main');
  writeFileSync(join(repo, 'a.txt'), 'ours\n');
  git(repo, 'commit', '-q', '-am', 'ours');
  expect(() => git(repo, 'merge', '-q', 'other')).toThrow();
}

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

  it('reports a git dir outside the checkout as unreadable, never anchoring there', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'git-operation-gitdir-'));
    try {
      git(repo, 'init', '-q', '--separate-git-dir', join(outside, 'git'));
      await expect(gitOperationInProgress(repo)).rejects.toMatchObject({
        name: 'GitOperationUnreadableError',
      });
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
    openMerge(repo);
    expect(await gitOperationInProgress(repo)).toBe(true);
  });

  it('reads a plain folder with no .git as no operation', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'git-operation-plain-'));
    try {
      expect(await gitOperationInProgress(plain)).toBe(false);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('rejects an operation check whose git directory is outside the checkout anchor', async () => {
    mkdirSync(join(repo, 'nested'));
    await expect(gitOperationInProgress(join(repo, 'nested'))).rejects.toMatchObject({
      name: 'GitOperationUnreadableError',
    });
  });
});

describe('gitOperationInProgress when git cannot be read', () => {
  let repo: string;
  let shim: FakeGit | null = null;
  const savedShort = gitTimeoutLimits.short;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'git-operation-unreadable-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 'T');
    git(repo, 'config', 'gc.auto', '0');
    writeFileSync(join(repo, 'a.txt'), 'base\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    openMerge(repo);
  });

  afterEach(async () => {
    await shim?.restore();
    shim = null;
    gitTimeoutLimits.short = savedShort;
    chmodSync(join(repo, '.git'), 0o755);
    rmSync(repo, { recursive: true, force: true });
  });

  const unreadable = (ref = 'MERGE_HEAD') =>
    new RegExp(
      `git rev-parse --git-path ${ref} failed in ${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `,
    );

  it('rejects when git exits non-zero, naming the command, the checkout and git text', async () => {
    shim = await failGit(['rev-parse', '--git-path']);
    const read = gitOperationInProgress(repo);
    await expect(read).rejects.toThrow(unreadable());
    await expect(read).rejects.toThrow(/simulated failure/);
    await expect(read).rejects.toMatchObject({ name: 'GitOperationUnreadableError' });
  });

  it('rejects when a later state entry cannot be read in a clean checkout', async () => {
    git(repo, 'merge', '--abort');
    shim = await failGit(['rev-parse', '--git-path'], { from: 4 });
    await expect(gitOperationInProgress(repo)).rejects.toThrow(unreadable('rebase-apply'));
  });

  it('rejects when git times out', async () => {
    gitTimeoutLimits.short = 300;
    shim = await failGit(['rev-parse', '--git-path'], { hang: true });
    await expect(gitOperationInProgress(repo)).rejects.toThrow(unreadable());
  });

  it('rejects when git cannot be started', async () => {
    shim = await noGit();
    await expect(gitOperationInProgress(repo)).rejects.toThrow(unreadable());
  });

  it('rejects for a corrupt .git/config', async () => {
    appendFileSync(join(repo, '.git', 'config'), '[core\n');
    await expect(gitOperationInProgress(repo)).rejects.toThrow(unreadable());
  });

  it('rejects when .git is a link, instead of reading the merge state as absent', async () => {
    const real = `${repo}-gitdir`;
    renameSync(join(repo, '.git'), real);
    symlinkSync(real, join(repo, '.git'));
    try {
      await expect(gitOperationInProgress(repo)).rejects.toThrow();
    } finally {
      rmSync(join(repo, '.git'), { force: true });
      renameSync(real, join(repo, '.git'));
    }
  });

  it.skipIf(process.getuid?.() === 0)(
    'rejects when .git cannot be read (skipped under root, which reads any directory)',
    async () => {
      chmodSync(join(repo, '.git'), 0o000);
      await expect(gitOperationInProgress(repo)).rejects.toThrow();
    },
  );
});
