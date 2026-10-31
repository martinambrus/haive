import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usableCheckout } from '../src/repo/refresh.js';
import { failGit, noGit, type FakeGit } from './support/fake-git.js';
import { killGit } from './support/kill-git.js';

/** Reads that fail with EIO. fs-safe's rule for an errno other than absence: null from a lenient
 *  read, a throw from a strict one. Root cannot make a real EACCES, so this stands in for it. */
const eio = vi.hoisted(() => ({
  lstat: null as null | ((anchor: string, rel: string) => boolean),
  read: null as null | ((anchor: string, rel: string) => boolean),
}));
vi.mock('@haive/shared/fs-safe', async (original) => {
  const real = await original<typeof import('@haive/shared/fs-safe')>();
  const fail = (strict: boolean | undefined): null => {
    if (strict) throw Object.assign(new Error('simulated EIO'), { code: 'EIO' });
    return null;
  };
  return {
    ...real,
    lstatNoFollow: async (...args: Parameters<typeof real.lstatNoFollow>) =>
      eio.lstat?.(args[0], args[1]) ? fail(args[2]?.strict) : real.lstatNoFollow(...args),
    readFileNoFollow: async (...args: Parameters<typeof real.readFileNoFollow>) =>
      eio.read?.(args[0], args[1]) ? fail(args[2]?.strict) : real.readFileNoFollow(...args),
  };
});

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
/** What `git rev-parse --show-cdup` exits with in `dir`: the read `usableCheckout` starts from. */
async function cdupExit(dir: string): Promise<number> {
  try {
    await exec('git', ['rev-parse', '--show-cdup'], { cwd: dir, env: GIT_ENV });
    return 0;
  } catch (err) {
    return (err as { code: number }).code;
  }
}
/** git exited non-zero, no structure proves the checkout dead, and only a repair changes that. */
const needsRepair = { unknown: expect.any(String), repairNeeded: true };

describe('usableCheckout tells "not usable" from "git gave no answer"', () => {
  const dirs: string[] = [];
  let shim: FakeGit | null = null;
  afterEach(async () => {
    eio.lstat = null;
    eio.read = null;
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
    expect(await usableCheckout(dir)).toEqual({ unknown: 'git exited 128', repairNeeded: true });
    await shim.restore();
    shim = await failGit(['rev-parse', '--verify', '--quiet', 'HEAD'], { exit: 1 });
    expect(await usableCheckout(dir)).toBe('unusable');
  });

  it('a corrupt config is unknown rather than a reason to rebuild', async () => {
    const dir = await intact();
    await writeFile(path.join(dir, '.git', 'config'), '[core\n');
    expect(await usableCheckout(dir)).toEqual(needsRepair);
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

  // What an interrupted `cp -a` of the source leaves, and the other ways a `.git` stops being what git requires.
  const replaceGit = async (dir: string, content: string | Buffer): Promise<void> => {
    await rm(path.join(dir, '.git'), { recursive: true });
    await writeFile(path.join(dir, '.git'), content);
  };
  const notWhatGitRequires: Array<[string, (dir: string) => Promise<void>]> = [
    ['no objects/', (dir) => rm(path.join(dir, '.git/objects'), { recursive: true })],
    ['no refs/', (dir) => rm(path.join(dir, '.git/refs'), { recursive: true })],
    ['an empty HEAD', (dir) => writeFile(path.join(dir, '.git/HEAD'), '')],
    ['a zero-filled HEAD', (dir) => writeFile(path.join(dir, '.git/HEAD'), Buffer.alloc(21))],
    [
      'a HEAD of 39 hex digits',
      async (dir) => {
        const oid = (await readFile(path.join(dir, '.git/refs/heads/main'), 'utf8')).trim();
        await writeFile(path.join(dir, '.git/HEAD'), `${oid.slice(0, 39)}\n`);
      },
    ],
    [
      'a HEAD that is neither a ref nor an object id',
      (dir) => writeFile(path.join(dir, '.git/HEAD'), 'garbage\n'),
    ],
    ['an empty .git file', (dir) => replaceGit(dir, '')],
    ['a .git file that is not a gitfile', (dir) => replaceGit(dir, 'garbage\n')],
    ['a .git file with no space after gitdir:', (dir) => replaceGit(dir, 'gitdir:meta.git\n')],
    [
      'a .git file behind a byte-order mark',
      (dir) =>
        replaceGit(
          dir,
          Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('gitdir: meta.git\n')]),
        ),
    ],
  ];
  it.each(notWhatGitRequires)(
    'git exits 128 on %s and the checkout is unusable',
    async (_shape, breakGit) => {
      const dir = await intact();
      await breakGit(dir);
      expect(await cdupExit(dir)).toBe(128);
      expect(await usableCheckout(dir)).toBe('unusable');
    },
  );

  it.each([
    ['an object id', (oid: string) => `${oid}\n`],
    ['an upper-case object id', (oid: string) => `${oid.toUpperCase()}\n`],
    ['a ref with no space after the colon', () => 'ref:refs/heads/main\n'],
  ])(
    'a HEAD holding %s is one git reads, so a corrupt config stays unknown',
    async (_head, text) => {
      const dir = await intact();
      const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: dir, env: GIT_ENV });
      await writeFile(path.join(dir, '.git/HEAD'), text(stdout.trim()));
      expect(await cdupExit(dir)).toBe(0);
      await writeFile(path.join(dir, '.git', 'config'), '[core\n');
      expect(await cdupExit(dir)).toBe(128);
      expect(await usableCheckout(dir)).toMatchObject({ unknown: expect.any(String) });
    },
  );

  it('objects/ and refs/ that exist as links are not missing', async () => {
    const dir = await intact();
    for (const name of ['objects', 'refs']) {
      await rename(path.join(dir, '.git', name), path.join(dir, `${name}-store`));
      await symlink(path.join(dir, `${name}-store`), path.join(dir, '.git', name));
    }
    expect(await cdupExit(dir)).toBe(0);
    await writeFile(path.join(dir, '.git', 'config'), '[core\n');
    expect(await cdupExit(dir)).toBe(128);
    expect(await usableCheckout(dir)).toMatchObject({ unknown: expect.any(String) });
  });

  it('objects/ and refs/ kept in a commondir are not missing', async () => {
    const main = await intact();
    const dir = await tmp();
    await mkdir(path.join(dir, '.git'));
    await writeFile(path.join(dir, '.git/HEAD'), 'ref: refs/heads/main\n');
    await writeFile(path.join(dir, '.git/commondir'), `${path.join(main, '.git')}\n`);
    expect(await cdupExit(dir)).toBe(0);
    await writeFile(path.join(main, '.git', 'config'), '[core\n');
    expect(await cdupExit(dir)).toBe(128);
    expect(await usableCheckout(dir)).toMatchObject({ unknown: expect.any(String) });
  });

  it('a gitdir outside the checkout is unknown even when missing', async () => {
    const dir = await intact();
    await rm(path.join(dir, '.git'), { recursive: true });
    await writeFile(path.join(dir, '.git'), 'gitdir: ../missing.git\n');
    expect(await usableCheckout(dir)).toEqual(needsRepair);
  });

  it.each([' metadata', 'metadata '])(
    'a gitdir named %j with corrupt config stays unknown',
    async (name) => {
      const dir = await intact();
      await rename(path.join(dir, '.git'), path.join(dir, name));
      await writeFile(path.join(dir, '.git'), `gitdir: ${name}\n`);
      await git(dir, ['rev-parse', '--show-cdup']);
      await writeFile(path.join(dir, name, 'config'), '[core\n');
      expect(await usableCheckout(dir)).toEqual(needsRepair);
    },
  );

  it('an undecodable gitdir name cannot prove that its gitdir is missing', async () => {
    const dir = await intact();
    const target = Buffer.concat([Buffer.from(`${dir}/metadata-`), Buffer.from([0xff])]);
    await rename(path.join(dir, '.git'), target);
    await writeFile(
      path.join(dir, '.git'),
      Buffer.concat([Buffer.from('gitdir: metadata-'), Buffer.from([0xff, 10])]),
    );
    await git(dir, ['rev-parse', '--show-cdup']);
    await writeFile(Buffer.concat([target, Buffer.from('/config')]), '[core\n');
    expect(await usableCheckout(dir)).toEqual(needsRepair);
  });

  it('a truncated gitfile cannot prove that its gitdir is absent', async () => {
    const dir = await intact();
    await rm(path.join(dir, '.git'), { recursive: true });
    await writeFile(path.join(dir, '.git'), `gitdir: ${'a'.repeat(5000)}\n`);
    expect(await usableCheckout(dir)).toEqual(needsRepair);
  });

  it('a HEAD behind a linked .git entry is unknown', async () => {
    const dir = await intact();
    await rm(path.join(dir, '.git'), { recursive: true });
    await mkdir(path.join(dir, 'metadata'));
    await symlink('metadata', path.join(dir, '.git'));
    expect(await usableCheckout(dir)).toEqual(needsRepair);
  });

  const corruptConfig = (dir: string) => writeFile(path.join(dir, '.git/config'), '[core\n');

  it('a gitdir behind a link is unknown, not absent', async () => {
    const dir = await intact();
    await mkdir(path.join(dir, 'real'));
    await rename(path.join(dir, '.git'), path.join(dir, 'real/meta.git'));
    await symlink('real', path.join(dir, 'link'));
    await writeFile(path.join(dir, '.git'), 'gitdir: link/meta.git\n');
    expect(await cdupExit(dir)).toBe(0);
    await writeFile(path.join(dir, 'real/meta.git/config'), '[core\n');
    expect(await cdupExit(dir)).toBe(128);
    expect(await usableCheckout(dir)).toEqual(needsRepair);
  });

  it('a gitdir that goes through a link and back with .. is unknown, not absent', async () => {
    const dir = await intact();
    await mkdir(path.join(dir, 'real/inner'), { recursive: true });
    await rename(path.join(dir, '.git'), path.join(dir, 'real/meta.git'));
    await symlink('real/inner', path.join(dir, 'link'));
    // By its text this is dir/meta.git, which is absent; the file system takes it to dir/real/meta.git.
    await writeFile(path.join(dir, '.git'), 'gitdir: link/../meta.git\n');
    expect(await cdupExit(dir)).toBe(0);
    await writeFile(path.join(dir, 'real/meta.git/config'), '[core\n');
    expect(await cdupExit(dir)).toBe(128);
    expect(await usableCheckout(dir)).toEqual(needsRepair);
  });

  it('a missing gitdir named with .. is unknown, whatever the path collapses to', async () => {
    const dir = await intact();
    await mkdir(path.join(dir, 'sub'));
    await replaceGit(dir, 'gitdir: sub/../missing.git\n');
    expect(await cdupExit(dir)).toBe(128);
    expect(await usableCheckout(dir)).toEqual(needsRepair);
  });

  it('a HEAD that is a link is unknown, not absent', async () => {
    const dir = await intact();
    await rm(path.join(dir, '.git/HEAD'));
    await symlink('refs/heads/main', path.join(dir, '.git/HEAD'));
    expect(await cdupExit(dir)).toBe(0);
    await corruptConfig(dir);
    expect(await cdupExit(dir)).toBe(128);
    expect(await usableCheckout(dir)).toEqual(needsRepair);
  });

  it('an unreadable checkout directory is unknown when git gave no answer', async () => {
    const dir = await intact();
    shim = await killGit(['rev-parse', '--show-cdup']);
    eio.lstat = (anchor, rel) => anchor === path.dirname(dir) && rel === path.basename(dir);
    expect(await usableCheckout(dir)).toEqual({ unknown: expect.stringContaining('SIGKILL') });
  });

  // Each row makes one strict read fail with EIO in a checkout that read as dead or as unproven
  // without the failure; a lenient read would have turned the failure into "absent".
  const gitfileToMissing = async (): Promise<string> => {
    const dir = await intact();
    await replaceGit(dir, 'gitdir: missing.git\n');
    return dir;
  };
  const commondirLayout = async (): Promise<string> => {
    const main = await intact();
    const dir = await tmp();
    await mkdir(path.join(dir, '.git'));
    await writeFile(path.join(dir, '.git/HEAD'), 'ref: refs/heads/main\n');
    await writeFile(path.join(dir, '.git/commondir'), `${path.join(main, '.git')}\n`);
    await corruptConfig(main);
    return dir;
  };
  const brokenConfig = async (): Promise<string> => {
    const dir = await intact();
    await corruptConfig(dir);
    return dir;
  };
  const unreadable: Array<[string, 'lstat' | 'read', string, () => Promise<string>]> = [
    ['.git', 'lstat', '.git', brokenConfig],
    ['HEAD', 'read', '.git/HEAD', brokenConfig],
    ['commondir', 'lstat', '.git/commondir', commondirLayout],
    ['objects/', 'lstat', '.git/objects', brokenConfig],
    ['refs/', 'lstat', '.git/refs', brokenConfig],
    ['gitfile', 'read', '.git', gitfileToMissing],
    ['gitdir named by a gitfile', 'lstat', 'missing.git', gitfileToMissing],
  ];
  it.each(unreadable)(
    'an unreadable %s is unknown, not absent',
    async (_site, kind, rel, arrange) => {
      const dir = await arrange();
      eio[kind] = (anchor, at) => anchor === dir && at === rel;
      expect(await usableCheckout(dir)).toEqual(needsRepair);
    },
  );

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
