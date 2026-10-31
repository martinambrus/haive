import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { usableCheckout } from '../src/repo/refresh.js';
import { failGit, noGit, type FakeGit } from './support/fake-git.js';
import { killGit } from './support/kill-git.js';

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
async function git(dir: string, args: string[]): Promise<void> {
  await exec('git', ['-c', 'gc.auto=0', ...args], { cwd: dir, env: GIT_ENV });
}

describe('usableCheckout tells "not usable" from "git gave no answer"', () => {
  const dirs: string[] = [];
  let shim: FakeGit | null = null;
  afterEach(async () => {
    await shim?.restore();
    shim = null;
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  async function tmp(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'uc-'));
    dirs.push(dir);
    return dir;
  }

  async function intact(): Promise<string> {
    const dir = await tmp();
    await git(dir, ['init', '-b', 'main']);
    await writeFile(path.join(dir, 'a.txt'), 'x\n', 'utf8');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'a']);
    return dir;
  }

  it('an intact checkout is usable', async () => {
    expect(await usableCheckout(await intact())).toBe('usable');
  });

  it('a killed --show-cdup read is unknown', async () => {
    const dir = await intact();
    shim = await killGit(['rev-parse', '--show-cdup']);
    expect(await usableCheckout(dir)).toEqual({ unknown: expect.stringContaining('SIGKILL') });
  });

  it('a killed HEAD read is unknown', async () => {
    const dir = await intact();
    shim = await killGit(['rev-parse', '--verify', '--quiet', 'HEAD']);
    expect(await usableCheckout(dir)).toEqual({ unknown: expect.stringContaining('SIGKILL') });
  });

  it('no git on PATH is unknown while the folder exists', async () => {
    const dir = await intact();
    shim = await noGit();
    expect(await usableCheckout(dir)).toEqual({ unknown: expect.stringContaining('ENOENT') });
  });

  it('a HEAD read that exits 128 is unknown, one that exits 1 is unusable', async () => {
    const dir = await intact();
    shim = await failGit(['rev-parse', '--verify', '--quiet', 'HEAD'], { exit: 128 });
    expect(await usableCheckout(dir)).toEqual({ unknown: 'git exited 128' });
    await shim.restore();
    shim = await failGit(['rev-parse', '--verify', '--quiet', 'HEAD'], { exit: 1 });
    expect(await usableCheckout(dir)).toBe('unusable');
  });

  it('a corrupt config is unknown rather than a reason to rebuild', async () => {
    const dir = await intact();
    await writeFile(path.join(dir, '.git', 'config'), '[core\n');
    expect(await usableCheckout(dir)).toEqual({ unknown: expect.any(String) });
  });

  it.each(['no HEAD', 'empty .git', 'relative missing gitdir', 'absolute missing gitdir'])(
    'a structurally dead checkout is unusable: %s',
    async (shape) => {
      const dir = await intact();
      if (shape === 'no HEAD') await rm(path.join(dir, '.git/HEAD'));
      else {
        await rm(path.join(dir, '.git'), { recursive: true });
        if (shape === 'empty .git') await mkdir(path.join(dir, '.git'));
        else
          await writeFile(
            path.join(dir, '.git'),
            `gitdir: ${shape === 'relative missing gitdir' ? 'missing.git' : path.join(dir, 'missing.git')}\n`,
          );
      }
      expect(await usableCheckout(dir)).toBe('unusable');
    },
  );

  it('a gitdir outside the checkout is unknown even when missing', async () => {
    const dir = await intact();
    await rm(path.join(dir, '.git'), { recursive: true });
    await writeFile(path.join(dir, '.git'), 'gitdir: ../missing.git\n');
    expect(await usableCheckout(dir)).toEqual({ unknown: expect.any(String) });
  });

  it('a truncated gitfile cannot prove that its gitdir is absent', async () => {
    const dir = await intact();
    await rm(path.join(dir, '.git'), { recursive: true });
    await writeFile(path.join(dir, '.git'), `gitdir: ${'a'.repeat(5000)}\n`);
    expect(await usableCheckout(dir)).toEqual({ unknown: expect.any(String) });
  });

  it('a HEAD behind a linked .git entry is unknown', async () => {
    const dir = await intact();
    await rm(path.join(dir, '.git'), { recursive: true });
    await mkdir(path.join(dir, 'metadata'));
    await symlink('metadata', path.join(dir, '.git'));
    expect(await usableCheckout(dir)).toEqual({ unknown: expect.any(String) });
  });

  it('an empty folder is unusable', async () => {
    expect(await usableCheckout(await tmp())).toBe('unusable');
  });

  it('a repository with no commit is unusable', async () => {
    const dir = await tmp();
    await git(dir, ['init', '-b', 'main']);
    expect(await usableCheckout(dir)).toBe('unusable');
  });

  it('a folder inside another repository is unusable', async () => {
    const outer = await intact();
    const sub = path.join(outer, 'sub');
    await mkdir(sub);
    expect(await usableCheckout(sub)).toBe('unusable');
  });

  it('a file standing where the checkout should be is unusable, not unknown', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'checkout');
    await writeFile(file, 'not a directory\n', 'utf8');
    expect(await usableCheckout(file)).toBe('unusable');
  });

  it('a path that does not exist is unusable', async () => {
    const dir = await tmp();
    expect(await usableCheckout(path.join(dir, 'missing'))).toBe('unusable');
  });
});
