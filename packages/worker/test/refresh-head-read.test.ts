import { networkGitArgs } from './support/git-http.js';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import type { RepoJobPayload } from '@haive/shared';
import { fastForward } from '../src/repo/refresh.js';
import { failGit, type FakeGit } from './support/fake-git.js';

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
  const { stdout } = await exec('git', ['-c', 'gc.auto=0', ...args], { cwd: dir, env: GIT_ENV });
  return stdout.trim();
}

const db = {} as unknown as Database;
const payload = { source: 'github', repositoryId: 'r1', userId: 'u1' } as unknown as RepoJobPayload;

describe('fastForward reads HEAD before it moves the checkout', () => {
  const dirs: string[] = [];
  let shim: FakeGit | null = null;
  afterEach(async () => {
    await shim?.restore();
    shim = null;
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  async function tmp(prefix: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  async function commit(dir: string, file: string): Promise<void> {
    await writeFile(path.join(dir, file), 'x\n', 'utf8');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', `add ${file}`]);
  }

  /** A checkout cloned from a bare file:// origin; the origin is then advanced when `behind`. */
  async function checkout(behind: boolean): Promise<string> {
    const bare = await tmp('rh-bare-');
    await git(bare, ['init', '--bare', '-b', 'main']);
    const seed = await tmp('rh-seed-');
    await git(seed, ['init', '-b', 'main']);
    await git(seed, ['remote', 'add', 'origin', `file://${bare}`]);
    await commit(seed, 'a.txt');
    await git(seed, ['push', '-u', 'origin', 'main']);
    const local = await tmp('rh-local-');
    await git(local, ['clone', `file://${bare}`, '.']);
    if (behind) {
      await commit(seed, 'b.txt');
      await git(seed, ['push', 'origin', 'main']);
    } else {
      await commit(local, 'mine.txt');
    }
    return local;
  }

  it('says the HEAD could not be read, and does not move a checkout that is behind', async () => {
    const local = await checkout(true);
    const head = await git(local, ['rev-parse', 'HEAD']);
    shim = await failGit(['rev-parse', 'HEAD']);
    const out = await fastForward(db, payload, local);
    await shim.restore();
    shim = null;
    expect(out).toMatch(/^Not refreshed: the checkout's HEAD could not be read \(/);
    expect(await git(local, ['rev-parse', 'HEAD'])).toBe(head);
  }, 30_000);

  it('does not reach the HEAD read when the checkout is ahead of its origin', async () => {
    const local = await checkout(false);
    expect(await fastForward(db, payload, local)).toMatch(
      /^Not refreshed: this checkout has 1 commit that /,
    );
  }, 30_000);
});
