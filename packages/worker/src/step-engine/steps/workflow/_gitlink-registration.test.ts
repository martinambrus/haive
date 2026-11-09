import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureDirNoFollow, removeNoFollow, writeFileNoFollow } from '@haive/shared/fs-safe';
import {
  stageAllArgs,
  unregisteredGitlinks,
  unregisteredGitlinksMessage,
} from './_gitlink-registration.js';
import { git, repoFixture } from '../../../../test/support/nested-repo.js';
import { failGit } from '../../../../test/support/fake-git.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function outer() {
  const fixture = await repoFixture();
  cleanups.push(fixture.cleanup);
  return fixture.repo;
}

async function nestedRepo(repo: string, name: string, committed = true) {
  await ensureDirNoFollow(repo, name);
  await git(path.join(repo, name), ['init', '-q', '-b', 'main']);
  await writeFileNoFollow(repo, `${name}/inside.txt`, 'nested contents\n');
  if (committed) {
    await git(path.join(repo, name), ['add', '-A']);
    await git(path.join(repo, name), ['commit', '-q', '-m', 'nested seed']);
  }
}

const gitmodules = (body: string) => `[submodule "lib"]\n${body}`;

async function find(repo: string, excluded: string[] = []) {
  const status = await git(repo, ['status', '--porcelain', '-z', '-uall']);
  return unregisteredGitlinks(repo, status, excluded);
}

describe('unregisteredGitlinks', () => {
  it('leaves no sharedindex file when core.splitIndex is on', async () => {
    const repo = await outer();
    await nestedRepo(repo, 'nested');
    await git(repo, ['config', 'core.splitIndex', 'true']);
    await git(repo, ['config', 'core.untrackedCache', 'true']);
    await git(repo, ['update-index', '--split-index']);
    await git(repo, ['status', '--porcelain']);
    await git(repo, ['status', '--porcelain']);
    const shared = async () =>
      (await readdir(path.join(repo, '.git'))).filter((n) => n.startsWith('sharedindex.')).sort();
    const before = await shared();
    expect(await find(repo)).toEqual(['nested']);
    expect(before.length).toBeGreaterThanOrEqual(1);
    expect(await shared()).toEqual(before);
  });

  it('names a nested repository with a commit and no .gitmodules entry', async () => {
    const repo = await outer();
    await nestedRepo(repo, 'nested');
    expect(await find(repo)).toEqual(['nested']);
  });

  it('returns nothing when no new gitlink or untracked repository exists', async () => {
    const repo = await outer();
    await writeFileNoFollow(repo, 'a.txt', 'after\n');
    expect(await find(repo)).toEqual([]);
  });

  it('accepts a registered submodule, whatever its entry is named', async () => {
    const repo = await outer();
    await nestedRepo(repo, 'nested');
    await writeFileNoFollow(
      repo,
      '.gitmodules',
      gitmodules('\tpath = nested\n\turl = https://example.invalid/x.git\n'),
    );
    expect(await find(repo)).toEqual([]);
  });

  it.each([
    ['ignore = all and no url', '\tpath = nested\n\tignore = all\n'],
    ['an empty url', '\tpath = nested\n\turl =\n'],
    ['a url for another path', '\tpath = other\n\turl = https://example.invalid/x.git\n'],
    ['a valueless url', '\tpath = nested\n\turl\n'],
  ])('refuses a gitlink whose .gitmodules entry has %s', async (_label, body) => {
    const repo = await outer();
    await nestedRepo(repo, 'nested');
    await writeFileNoFollow(repo, '.gitmodules', gitmodules(body));
    expect(await find(repo)).toEqual(['nested']);
  });

  it('does not refuse a gitlink that HEAD already holds', async () => {
    const repo = await outer();
    await nestedRepo(repo, 'nested');
    await git(repo, ['add', '--', 'nested']);
    await git(repo, ['commit', '-q', '-m', 'gitlink']);
    await writeFileNoFollow(repo, 'nested/more.txt', 'dirty\n');
    await git(path.join(repo, 'nested'), ['add', '-A']);
    await git(path.join(repo, 'nested'), ['commit', '-q', '-m', 'moved']);
    expect(await find(repo)).toEqual([]);
  });

  it('refuses a gitlink that is already staged', async () => {
    const repo = await outer();
    await nestedRepo(repo, 'nested');
    await git(repo, ['add', '--', 'nested']);
    expect(await find(repo)).toEqual(['nested']);
  });

  it('refuses a force-staged gitignored gitlink', async () => {
    const repo = await outer();
    await writeFileNoFollow(repo, '.gitignore', 'nested/\n');
    await nestedRepo(repo, 'nested');
    await git(repo, ['add', '-f', '--', 'nested']);
    expect(await find(repo)).toEqual(['nested']);
  });

  it('ignores a staged gitlink whose directory is gone', async () => {
    const repo = await outer();
    await nestedRepo(repo, 'nested');
    await git(repo, ['add', '--', 'nested']);
    await removeNoFollow(repo, 'nested', { recursive: true });
    expect(await find(repo)).toEqual([]);
  });

  it('leaves an unborn nested repository to the exclusion', async () => {
    const repo = await outer();
    await nestedRepo(repo, 'nested', false);
    expect(await find(repo, ['nested/'])).toEqual([]);
  });

  it.each(['my dir', 'q"uote', 'ünï', 'sub/dir/deep', 'new\nline'])(
    'names %j exactly',
    async (name) => {
      const repo = await outer();
      await nestedRepo(repo, name);
      expect(await find(repo)).toEqual([name]);
    },
  );

  it('names only the unregistered one among several', async () => {
    const repo = await outer();
    await nestedRepo(repo, 'a-reg');
    await nestedRepo(repo, 'b-orphan');
    await writeFileNoFollow(
      repo,
      '.gitmodules',
      gitmodules('\tpath = a-reg\n\turl = https://example.invalid/x.git\n'),
    );
    expect(await find(repo)).toEqual(['b-orphan']);
  });

  it('never writes the real index or leaves a scratch file behind', async () => {
    const repo = await outer();
    await nestedRepo(repo, 'nested');
    const scratch = await mkdtemp(path.join(tmpdir(), 'gitlink-tmp-'));
    cleanups.push(() => rm(scratch, { recursive: true, force: true }));
    const saved = process.env.TMPDIR;
    const index = await git(repo, ['ls-files', '-s']);
    try {
      process.env.TMPDIR = scratch;
      expect(await find(repo)).toEqual(['nested']);
      expect(await readdir(scratch)).toEqual([]);
      await writeFileNoFollow(repo, '.gitmodules', '[submodule "x"\n\tbroken\n');
      await expect(find(repo)).rejects.toThrow();
      expect(await readdir(scratch)).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
    expect(await git(repo, ['ls-files', '-s'])).toBe(index);
  });

  it('throws for an outer repository with no commit', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gitlink-unborn-'));
    cleanups.push(() => removeNoFollow(tmpdir(), path.basename(dir), { recursive: true }));
    await git(dir, ['init', '-q', '-b', 'main']);
    await expect(unregisteredGitlinks(dir, '', [])).rejects.toThrow();
  });

  it('throws for a malformed .gitmodules', async () => {
    const repo = await outer();
    await nestedRepo(repo, 'nested');
    await writeFileNoFollow(repo, '.gitmodules', '[submodule "x"\n\tbroken\n');
    await expect(find(repo)).rejects.toThrow();
  });

  it.each([128, 124])('throws when git fails or gives no answer (exit %i)', async (exit) => {
    const repo = await outer();
    await nestedRepo(repo, 'nested');
    const shim = await failGit(['diff-index'], { exit });
    try {
      await expect(find(repo)).rejects.toThrow();
    } finally {
      await shim.restore();
    }
  });
});

describe('stageAllArgs', () => {
  it('is a plain add -A with nothing excluded', () => {
    expect(stageAllArgs([])).toEqual(['add', '-A']);
  });

  it('excludes each repository by literal top-level path', () => {
    expect(stageAllArgs(['a/', 'b c/'])).toEqual([
      'add',
      '-A',
      '--',
      '.',
      ':(top,exclude,literal)a',
      ':(top,exclude,literal)b c',
    ]);
  });
});

describe('unregisteredGitlinksMessage', () => {
  it('quotes each path and names the two ways out', () => {
    const text = unregisteredGitlinksMessage(['one', 'q"x']);
    expect(text).toContain(JSON.stringify('one'));
    expect(text).toContain(JSON.stringify('q"x'));
    for (const word of ['nested', '.gitmodules', 'submodule', 'ordinary files', '(1)', '(2)']) {
      expect(text).toContain(word);
    }
    expect(text).not.toContain('(3)');
    expect(text).not.toMatch(/#\d/);
  });
});
