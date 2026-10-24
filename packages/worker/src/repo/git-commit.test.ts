import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureDirNoFollow, writeFileNoFollow } from '@haive/shared/fs-safe';
import { gitCommitStaged } from './git-commit.js';
import { gitRun } from './git-exec.js';

const identity = {
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

async function command(repo: string, args: string[]): Promise<string> {
  const result = await gitRun(repo, args, identity);
  expect(result.code, result.stderr || result.stdout).toBe(0);
  return result.stdout.trim();
}

describe('gitCommitStaged with real git', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'haive-commit-staged-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('commits a staged gitlink move even when submodule config ignores all changes', async () => {
    await ensureDirNoFollow(root, 'sub');
    await ensureDirNoFollow(root, 'sup');
    const sub = path.join(root, 'sub');
    const sup = path.join(root, 'sup');
    await command(sub, ['init', '-q', '-b', 'main']);
    await command(sub, ['commit', '-q', '--allow-empty', '-m', 'submodule base']);
    await command(sup, ['init', '-q', '-b', 'main']);
    await command(sup, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'm']);
    await command(sup, ['commit', '-qm', 'add submodule']);
    await command(sup, ['config', 'submodule.m.ignore', 'all']);
    await command(path.join(sup, 'm'), ['commit', '-q', '--allow-empty', '-m', 'submodule bump']);
    const bump = await command(path.join(sup, 'm'), ['rev-parse', 'HEAD']);
    await command(sup, ['add', '-A']);

    // The default diff hides the staged pointer; commit itself still accepts it.
    expect((await gitRun(sup, ['diff', '--cached', '--quiet'])).code).toBe(0);
    expect(await gitCommitStaged(sup, 'bump submodule', identity)).toBe(true);
    expect(await command(sup, ['rev-parse', 'HEAD:m'])).toBe(bump);
    expect(
      (await gitRun(sup, ['diff', '--cached', '--quiet', '--ignore-submodules=none'])).code,
    ).toBe(0);
  });

  it('concludes an open merge even when its staged tree equals HEAD', async () => {
    await command(root, ['init', '-q', '-b', 'main']);
    await command(root, ['commit', '-q', '--allow-empty', '-m', 'base']);
    await command(root, ['checkout', '-q', '-b', 'side']);
    await writeFileNoFollow(root, 'f', 'same tree\n');
    await command(root, ['add', 'f']);
    await command(root, ['commit', '-qm', 'side']);
    const side = await command(root, ['rev-parse', 'HEAD']);
    await command(root, ['checkout', '-q', 'main']);
    await writeFileNoFollow(root, 'f', 'same tree\n');
    await command(root, ['add', 'f']);
    await command(root, ['commit', '-qm', 'main']);
    const main = await command(root, ['rev-parse', 'HEAD']);
    await command(root, ['merge', '--no-commit', '--no-ff', 'side']);
    expect((await gitRun(root, ['diff', '--cached', '--quiet'])).code).toBe(0);
    expect(await command(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).toBe(side);

    expect(await gitCommitStaged(root, 'conclude merge', identity)).toBe(true);
    expect(await command(root, ['show', '-s', '--format=%P', 'HEAD'])).toBe(`${main} ${side}`);
    expect((await gitRun(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).code).toBe(1);
  });

  it('skips an empty unborn branch and commits its first staged file', async () => {
    await command(root, ['init', '-q', '-b', 'main']);
    expect(await gitCommitStaged(root, 'empty unborn branch', identity)).toBe(false);
    expect((await gitRun(root, ['rev-parse', '-q', '--verify', 'HEAD'])).code).toBe(1);

    await writeFileNoFollow(root, 'first', 'first file\n');
    await command(root, ['add', 'first']);
    expect(await gitCommitStaged(root, 'first commit', identity)).toBe(true);
    expect(await command(root, ['show', 'HEAD:first'])).toBe('first file');
    expect(await command(root, ['show', '-s', '--format=%P', 'HEAD'])).toBe('');
  });

  it('skips intent-to-add entries until their contents are staged', async () => {
    await command(root, ['init', '-q', '-b', 'main']);
    await command(root, ['commit', '-q', '--allow-empty', '-m', 'base']);
    const head = await command(root, ['rev-parse', 'HEAD']);
    await writeFileNoFollow(root, 'intent', 'not staged yet\n');
    await command(root, ['add', '-N', 'intent']);

    expect(await gitCommitStaged(root, 'intent only', identity)).toBe(false);
    expect(await command(root, ['rev-parse', 'HEAD'])).toBe(head);
    await command(root, ['add', 'intent']);
    expect(await gitCommitStaged(root, 'stage contents', identity)).toBe(true);
    expect(await command(root, ['show', 'HEAD:intent'])).toBe('not staged yet');
  });
});
