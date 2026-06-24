import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, it, expect } from 'vitest';
import type { Database } from '@haive/database';
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
  const { stdout } = await exec('git', args, { cwd: dir, env: GIT_ENV });
  return stdout.toString();
}

/** A working repo on `main` with one commit, plus a bare repo to serve as origin. */
async function setupRepoWithBareOrigin(): Promise<{ work: string; bare: string }> {
  const work = await mkdtemp(path.join(tmpdir(), 'gp-work-'));
  await git(work, ['init', '-b', 'main']);
  await writeFile(path.join(work, 'f.txt'), 'one\n', 'utf8');
  await git(work, ['add', '-A']);
  await git(work, ['commit', '-m', 'one']);
  const bare = await mkdtemp(path.join(tmpdir(), 'gp-bare-'));
  await git(bare, ['init', '--bare', '-b', 'main']);
  return { work, bare };
}

// db/userId are only touched on the credential path; the file:// tests use no
// credential, so a bare stub is never dereferenced.
const stubDb = {} as unknown as Database;

describe('git-push helpers', () => {
  it('detectOrigin / getOriginUrl reflect remote state', async () => {
    const work = await mkdtemp(path.join(tmpdir(), 'gp-'));
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
    const work = await mkdtemp(path.join(tmpdir(), 'gp-'));
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

  it('pushBranch pushes to a bare file:// origin and sets upstream', async () => {
    const { work, bare } = await setupRepoWithBareOrigin();
    try {
      await git(work, ['remote', 'add', 'origin', `file://${bare}`]);
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

  it('pushBranch throws on a rejected (non-fast-forward) push', async () => {
    const { work, bare } = await setupRepoWithBareOrigin();
    const other = await mkdtemp(path.join(tmpdir(), 'gp-other-'));
    try {
      await git(work, ['remote', 'add', 'origin', `file://${bare}`]);
      await pushBranch({ cwd: work, branch: 'main', setUpstream: false, db: stubDb, userId: 'u1' });
      // Advance the bare origin from a second clone so `work` is now behind.
      await git(other, ['clone', `file://${bare}`, '.']);
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
