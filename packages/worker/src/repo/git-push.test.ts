import { fixtureBase, networkGitArgs, httpOrigin } from '../../test/support/git-http.js';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, it, expect } from 'vitest';
import type { Database } from '@haive/database';
import { gitTimeoutLimits } from './git-exec.js';
import { failGit, noGit, type FakeGit } from '../../test/support/fake-git.js';
import { detectOrigin, ensureOrigin, getOriginUrl, pushBranch, scrubSecret } from './git-push.js';

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
async function git(dir: string, args: string[]): Promise<string> {
  args = networkGitArgs(args);
  const { stdout } = await exec('git', args, { cwd: dir, env: GIT_ENV });
  return stdout.toString();
}

/** A working repo on `main` with one commit, plus a bare repo to serve as origin. */
async function setupRepoWithBareOrigin(): Promise<{ work: string; bare: string }> {
  const work = await mkdtemp(path.join(fixtureBase, 'gp-work-'));
  await git(work, ['init', '-b', 'main']);
  await writeFile(path.join(work, 'f.txt'), 'one\n', 'utf8');
  await git(work, ['add', '-A']);
  await git(work, ['commit', '-m', 'one']);
  const bare = await mkdtemp(path.join(fixtureBase, 'gp-bare-'));
  await git(bare, ['init', '--bare', '-b', 'main']);
  return { work, bare };
}

// db/userId are only touched on the credential path; the HTTP tests use no
// credential, so a bare stub is never dereferenced.
const stubDb = {} as unknown as Database;

describe('detectOrigin / getOriginUrl read a failed git as an error', () => {
  const FAILED = /^git remote get-url origin failed in /;
  const dirs: string[] = [];
  const shims: FakeGit[] = [];
  const savedShort = gitTimeoutLimits.short;

  afterEach(async () => {
    gitTimeoutLimits.short = savedShort;
    for (const s of shims.splice(0)) await s.restore();
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  async function repo(setup: (dir: string) => Promise<void> = async () => {}): Promise<string> {
    const dir = await mkdtemp(path.join(fixtureBase, 'gp-'));
    dirs.push(dir);
    await git(dir, ['init', '-b', 'main']);
    await git(dir, ['config', 'gc.auto', '0']);
    await setup(dir);
    return dir;
  }
  const withOrigin = async (dir: string): Promise<void> => {
    await git(dir, ['remote', 'add', 'origin', 'https://example.com/x.git']);
  };

  async function expectBothReject(dir: string): Promise<void> {
    await expect(detectOrigin(dir)).rejects.toThrow(FAILED);
    await expect(getOriginUrl(dir)).rejects.toThrow(FAILED);
  }

  it('rejects when the origin is unreadable', async () => {
    const dir = await repo(async (d) => {
      await withOrigin(d);
      await git(d, ['config', '--add', 'remote.origin.fetch', ':::bad']);
    });
    await expectBothReject(dir);
  });

  it('rejects when git remote exits 128 on a repo with a good origin', async () => {
    const dir = await repo(withOrigin);
    shims.push(await failGit(['remote']));
    await expectBothReject(dir);
  });

  it('rejects when git remote times out', async () => {
    const dir = await repo(withOrigin);
    gitTimeoutLimits.short = 300;
    shims.push(await failGit(['remote'], { hang: true }));
    await expectBothReject(dir);
  });

  it('rejects when git is not on PATH', async () => {
    const dir = await repo(withOrigin);
    shims.push(await noGit());
    await expectBothReject(dir);
  });

  it('keys on exit 2 of get-url, not on the remote list', async () => {
    const dir = await repo(withOrigin);
    shims.push(await failGit(['remote', 'get-url'], { exit: 2 }));
    expect(await detectOrigin(dir)).toBe(false);
    expect(await getOriginUrl(dir)).toBeNull();
  });

  it('no remote at all is false / null', async () => {
    const dir = await repo();
    expect(await detectOrigin(dir)).toBe(false);
    expect(await getOriginUrl(dir)).toBeNull();
  });

  it('only an upstream remote is false / null', async () => {
    const dir = await repo(async (d) => {
      await git(d, ['remote', 'add', 'upstream', 'https://example.com/u.git']);
    });
    expect(await detectOrigin(dir)).toBe(false);
    expect(await getOriginUrl(dir)).toBeNull();
  });

  it('origin with a url is true / the url', async () => {
    const dir = await repo(withOrigin);
    expect(await detectOrigin(dir)).toBe(true);
    expect(await getOriginUrl(dir)).toBe('https://example.com/x.git');
  });

  it('origin with only a fetch refspec refuses the non-URL fallback', async () => {
    const dir = await repo(async (d) => {
      await git(d, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
    });
    await expect(detectOrigin(dir)).rejects.toThrow(/origin URL is not allowed/);
  });
});

describe('git-push helpers', () => {
  it('detectOrigin / getOriginUrl reflect remote state', async () => {
    const work = await mkdtemp(path.join(fixtureBase, 'gp-'));
    try {
      await git(work, ['init', '-b', 'main']);
      expect(await detectOrigin(work)).toBe(false);
      expect(await getOriginUrl(work)).toBeNull();
      await git(work, ['remote', 'add', 'origin', 'https://example.com/x.git']);
      expect(await detectOrigin(work)).toBe(true);
      expect(await getOriginUrl(work)).toBe('https://example.com/x.git');
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('ensureOrigin adds, then set-urls idempotently', async () => {
    const work = await mkdtemp(path.join(fixtureBase, 'gp-'));
    try {
      await git(work, ['init', '-b', 'main']);
      expect(await ensureOrigin(work, 'https://a.test/x.git')).toEqual({
        added: true,
        updated: false,
      });
      expect(await getOriginUrl(work)).toBe('https://a.test/x.git');
      expect(await ensureOrigin(work, 'https://b.test/y.git')).toEqual({
        added: false,
        updated: true,
      });
      expect(await getOriginUrl(work)).toBe('https://b.test/y.git');
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('scrubSecret masks every occurrence; passthrough on null', () => {
    expect(scrubSecret('tok=abc and abc again', 'abc')).toBe('tok=*** and *** again');
    expect(scrubSecret('nothing', null)).toBe('nothing');
  });

  it('pushBranch pushes to a bare HTTP origin and sets upstream', async () => {
    const { work, bare } = await setupRepoWithBareOrigin();
    try {
      await git(work, ['remote', 'add', 'origin', httpOrigin(bare)]);
      const res = await pushBranch({
        cwd: work,
        branch: 'main',
        setUpstream: true,
        db: stubDb,
        userId: 'u1',
      });
      expect(res).toEqual({ pushed: true, remote: 'origin', branch: 'main' });
      expect((await git(bare, ['log', '--oneline'])).trim()).toContain('one');
      expect((await git(work, ['rev-parse', '--abbrev-ref', 'main@{upstream}'])).trim()).toBe(
        'origin/main',
      );
    } finally {
      await rm(work, { recursive: true, force: true });
      await rm(bare, { recursive: true, force: true });
    }
  });

  it('pushBranch with a sha pushes that commit, not where the branch has moved to, and sets upstream', async () => {
    const { work, bare } = await setupRepoWithBareOrigin();
    try {
      await git(work, ['remote', 'add', 'origin', httpOrigin(bare)]);
      const sha = (await git(work, ['rev-parse', 'main'])).trim();
      await writeFile(path.join(work, 'f.txt'), 'two\n', 'utf8');
      await git(work, ['commit', '-am', 'two']);
      const res = await pushBranch({
        cwd: work,
        branch: 'main',
        sha,
        setUpstream: true,
        db: stubDb,
        userId: 'u1',
      });
      expect(res).toEqual({ pushed: true, remote: 'origin', branch: 'main' });
      expect((await git(bare, ['rev-parse', 'main'])).trim()).toBe(sha);
      expect((await git(work, ['rev-parse', '--abbrev-ref', 'main@{upstream}'])).trim()).toBe(
        'origin/main',
      );
    } finally {
      await rm(work, { recursive: true, force: true });
      await rm(bare, { recursive: true, force: true });
    }
  });

  it('pushBranch with a sha reports a failed upstream setup, and still resolves as pushed', async () => {
    const { work, bare } = await setupRepoWithBareOrigin();
    try {
      await git(work, ['remote', 'add', 'origin', httpOrigin(bare)]);
      await git(work, ['config', '--unset-all', 'remote.origin.fetch']);
      const sha = (await git(work, ['rev-parse', 'main'])).trim();
      const res = await pushBranch({
        cwd: work,
        branch: 'main',
        sha,
        setUpstream: true,
        db: stubDb,
        userId: 'u1',
      });
      expect(res).toMatchObject({ pushed: true, remote: 'origin', branch: 'main' });
      expect(res.upstreamError).toMatch(/origin\/main/);
      expect((await git(bare, ['rev-parse', 'main'])).trim()).toBe(sha);
    } finally {
      await rm(work, { recursive: true, force: true });
      await rm(bare, { recursive: true, force: true });
    }
  });

  it('pushBranch throws on a rejected (non-fast-forward) push', async () => {
    const { work, bare } = await setupRepoWithBareOrigin();
    const other = await mkdtemp(path.join(fixtureBase, 'gp-other-'));
    try {
      await git(work, ['remote', 'add', 'origin', httpOrigin(bare)]);
      await pushBranch({ cwd: work, branch: 'main', setUpstream: false, db: stubDb, userId: 'u1' });
      // Advance the bare origin from a second clone so `work` is now behind.
      await git(other, ['clone', httpOrigin(bare), '.']);
      await writeFile(path.join(other, 'g.txt'), 'two\n', 'utf8');
      await git(other, ['add', '-A']);
      await git(other, ['commit', '-m', 'two']);
      await git(other, ['push', 'origin', 'main']);
      // Diverge `work` so its push is a non-fast-forward → rejected.
      await writeFile(path.join(work, 'f.txt'), 'one-local\n', 'utf8');
      await git(work, ['commit', '-am', 'local edit']);
      await expect(
        pushBranch({ cwd: work, branch: 'main', setUpstream: false, db: stubDb, userId: 'u1' }),
      ).rejects.toThrow(/git push failed/);
    } finally {
      await rm(work, { recursive: true, force: true });
      await rm(bare, { recursive: true, force: true });
      await rm(other, { recursive: true, force: true });
    }
  });
});
