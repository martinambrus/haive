import { execFile, spawnSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeBuildStamp, currentBuildStamp, initBuildStamp } from '../src/build-stamp.js';

const run = promisify(execFile);
const STAMP_FORM = /^(?:(?:commit|tree):(?:[0-9a-f]{40}|[0-9a-f]{64})|release:.+|unknown)$/;

let root: string;
let env: NodeJS.ProcessEnv;
let fixtures = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'haive-build-stamp-test-'));
  env = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: root,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  delete env.HAIVE_VERSION;
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await run('git', args, { cwd, env })).stdout.trim();

async function put(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), text);
  }
}

async function commit(dir: string, forced: string[] = []): Promise<void> {
  await git(dir, 'add', '-A');
  if (forced.length > 0) await git(dir, '--literal-pathspecs', 'add', '-f', '--', ...forced);
  await git(dir, 'commit', '-q', '-m', 'c');
}

async function unbornRepo(...initArgs: string[]): Promise<string> {
  const dir = join(root, `repo-${fixtures++}`);
  await mkdir(dir);
  await git(dir, 'init', '-q', '-b', 'main', ...initArgs);
  for (const [key, value] of [
    ['user.name', 'T'],
    ['user.email', 't@example.com'],
    ['gc.auto', '0'],
    ['commit.gpgsign', 'false'],
  ] as const) {
    await git(dir, 'config', key, value);
  }
  await put(dir, { '.gitignore': '*.log\n', 'a.txt': 'alpha\n', 'sub/b.txt': 'bravo\n' });
  return dir;
}

async function bornRepo(
  extra: Record<string, string> = {},
  forced: string[] = [],
): Promise<string> {
  const dir = await unbornRepo();
  await put(dir, extra);
  await commit(dir, forced);
  return dir;
}

async function scriptRepo(): Promise<string> {
  const dir = await unbornRepo();
  await put(dir, { 'bin/run.sh': '#!/bin/sh\n' });
  await chmod(join(dir, 'bin/run.sh'), 0o755);
  await commit(dir);
  return dir;
}

const stamp = (startDir: string, over: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) =>
  computeBuildStamp({ startDir, env, ...over });

const commitStamp = async (dir: string): Promise<string> =>
  `commit:${await git(dir, 'rev-parse', 'HEAD')}`;

async function snapshot(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await readdir(dir, { recursive: true })).sort()) {
    const st = await lstat(join(dir, name));
    out.push(`${name} ${st.size} ${st.mtimeMs}`);
  }
  return out;
}

describe('computeBuildStamp in a checkout', { timeout: 30_000 }, () => {
  it('names the commit of a clean checkout', async () => {
    const dir = await bornRepo();
    expect(await stamp(dir)).toBe(await commitStamp(dir));
  });

  it('names the tree an edit would commit', async () => {
    const dir = await bornRepo();
    const clean = await stamp(dir);
    await put(dir, { 'a.txt': 'alpha edited\n' });
    const edited = await stamp(dir);
    expect(edited).not.toBe(clean);
    await commit(dir);
    expect(edited).toBe(`tree:${await git(dir, 'rev-parse', 'HEAD^{tree}')}`);
  });

  it('returns to the commit once the edit is reverted', async () => {
    const dir = await bornRepo();
    const clean = await stamp(dir);
    await put(dir, { 'a.txt': 'alpha edited\n' });
    expect(await stamp(dir)).toMatch(/^tree:/);
    await put(dir, { 'a.txt': 'alpha\n' });
    expect(await stamp(dir)).toBe(clean);
  });

  it('counts an untracked file that no ignore rule matches', async () => {
    const dir = await bornRepo();
    const clean = await stamp(dir);
    await put(dir, { 'new.txt': 'new\n' });
    const untracked = await stamp(dir);
    expect(untracked).not.toBe(clean);
    await commit(dir);
    expect(untracked).toBe(`tree:${await git(dir, 'rev-parse', 'HEAD^{tree}')}`);
  });

  it('ignores a file an ignore rule matches', async () => {
    const dir = await bornRepo();
    await put(dir, { 'debug.log': 'noise\n', 'sub/trace.log': 'noise\n' });
    expect(await stamp(dir)).toBe(await commitStamp(dir));
  });

  it('counts a tracked file an ignore rule matches, edited and then deleted', async () => {
    const dir = await bornRepo({ 'keep.log': 'forced\n' }, ['keep.log']);
    expect(await stamp(dir)).toBe(await commitStamp(dir));
    await put(dir, { 'keep.log': 'forced edited\n' });
    const edited = await stamp(dir);
    await git(dir, 'commit', '-q', '-a', '-m', 'edit');
    expect(edited).toBe(`tree:${await git(dir, 'rev-parse', 'HEAD^{tree}')}`);
    await rm(join(dir, 'keep.log'));
    const deleted = await stamp(dir);
    await git(dir, 'commit', '-q', '-a', '-m', 'delete');
    expect(deleted).toBe(`tree:${await git(dir, 'rev-parse', 'HEAD^{tree}')}`);
  });

  it('reads the name of such a file literally, not as a pathspec', async () => {
    const dir = await bornRepo({ ':(top)keep.log': 'forced\n' }, [':(top)keep.log']);
    expect(await stamp(dir)).toBe(await commitStamp(dir));
  });

  it('names the tree of a checkout whose HEAD is unborn', async () => {
    const dir = await unbornRepo();
    const unborn = await stamp(dir);
    await git(dir, 'add', '-A');
    expect(unborn).toBe(`tree:${await git(dir, 'write-tree')}`);
  });

  it('answers the same from a subdirectory as from the top', async () => {
    const dir = await bornRepo();
    await put(dir, { 'a.txt': 'alpha edited\n', 'new.txt': 'new\n' });
    expect(await stamp(join(dir, 'sub'))).toBe(await stamp(dir));
  });

  it('lets the checkout decide over the release version', async () => {
    const dir = await bornRepo();
    expect(await stamp(dir, { env: { ...env, HAIVE_VERSION: '0.2.0' } })).toBe(
      await commitStamp(dir),
    );
  });

  it('answers unknown when HEAD names an object that is missing, whatever the version', async () => {
    const dir = await bornRepo();
    await writeFile(join(dir, '.git/refs/heads/main'), `${'de'.repeat(20)}\n`);
    expect(await stamp(dir, { env: { ...env, HAIVE_VERSION: '0.2.0' } })).toBe('unknown');
  });

  it('answers unknown within the timeout when git never answers', async () => {
    const dir = await bornRepo();
    const shim = join(root, 'shim');
    await mkdir(shim);
    await writeFile(join(shim, 'git'), '#!/bin/sh\nexec sleep 30\n');
    await chmod(join(shim, 'git'), 0o755);
    const started = Date.now();
    const result = await stamp(dir, {
      env: { ...env, PATH: `${shim}:${env.PATH}` },
      timeoutMs: 300,
    });
    expect(result).toBe('unknown');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('writes nothing under .git, even with the split index enabled', async () => {
    const dir = await bornRepo();
    await git(dir, 'config', 'core.splitIndex', 'true');
    await put(dir, { 'a.txt': 'alpha edited\n', 'new.txt': 'new\n' });
    const before = await snapshot(join(dir, '.git'));
    expect(await stamp(dir)).toMatch(/^tree:/);
    expect(await snapshot(join(dir, '.git'))).toEqual(before);
  });

  it('names the commit of a clean checkout whose filesystem cannot hold the exec bit', async () => {
    const dir = await scriptRepo();
    await git(dir, 'config', 'core.fileMode', 'false');
    await chmod(join(dir, 'bin/run.sh'), 0o644);
    expect(await git(dir, '--no-optional-locks', 'status', '--porcelain')).toBe('');
    expect(await stamp(dir)).toBe(await commitStamp(dir));
  });

  it('keeps the committed exec bit in the tree of an edit when the filesystem cannot hold it', async () => {
    const dir = await scriptRepo();
    await git(dir, 'config', 'core.fileMode', 'false');
    await chmod(join(dir, 'bin/run.sh'), 0o644);
    await put(dir, { 'a.txt': 'alpha edited\n' });
    const edited = await stamp(dir);
    await commit(dir);
    expect(await git(dir, 'ls-tree', 'HEAD', 'bin/run.sh')).toMatch(/^100755 /);
    expect(edited).toBe(`tree:${await git(dir, 'rev-parse', 'HEAD^{tree}')}`);
  });

  it('names a commit by its own tree when a replace ref swaps it', async () => {
    const dir = await bornRepo();
    const original = await git(dir, 'rev-parse', 'HEAD');
    await put(dir, { 'a.txt': 'alpha in the replacement\n' });
    await commit(dir);
    const replacement = await git(dir, 'rev-parse', 'HEAD');
    await git(dir, 'checkout', '-q', '--detach', original);
    await git(dir, 'replace', original, replacement);
    expect(await stamp(dir)).toBe(`commit:${original}`);
    await git(dir, 'reset', '-q', '--hard');
    expect(await stamp(dir)).toMatch(/^tree:/);
  });

  it.skipIf(spawnSync('git', ['lfs', 'version']).status !== 0)(
    'writes nothing under .git when a git-lfs file changes',
    async () => {
      const dir = await unbornRepo();
      for (const [key, value] of [
        ['filter.lfs.clean', 'git-lfs clean -- %f'],
        ['filter.lfs.smudge', 'git-lfs smudge -- %f'],
        ['filter.lfs.process', 'git-lfs filter-process'],
        ['filter.lfs.required', 'true'],
      ] as const) {
        await git(dir, 'config', key, value);
      }
      await put(dir, { '.gitattributes': '*.bin filter=lfs -text\n', 'big.bin': 'x'.repeat(4096) });
      await commit(dir);
      await put(dir, { 'big.bin': 'y'.repeat(4096) });
      const before = await snapshot(join(dir, '.git'));
      expect(await stamp(dir)).toMatch(/^tree:/);
      expect(await snapshot(join(dir, '.git'))).toEqual(before);
    },
  );

  it('names the commit of a clean SHA-256 checkout', async () => {
    const dir = await unbornRepo('--object-format=sha256');
    await commit(dir);
    expect(await commitStamp(dir)).toMatch(/^commit:[0-9a-f]{64}$/);
    expect(await stamp(dir)).toBe(await commitStamp(dir));
  });

  it('names the commit of a clean sparse checkout', async () => {
    const dir = await bornRepo({ 'other/c.txt': 'charlie\n' });
    await git(dir, 'sparse-checkout', 'set', 'sub');
    expect(await git(dir, 'ls-files', '-t', 'other/c.txt')).toBe('S other/c.txt');
    expect(await git(dir, '--no-optional-locks', 'status', '--porcelain')).toBe('');
    expect(await stamp(dir)).toBe(await commitStamp(dir));
  });

  it('names the commit of a clean checkout whose path holds a colon and a quote', async () => {
    const dir = join(root, `odd:"${fixtures++}`);
    await rename(await bornRepo(), dir);
    expect(await stamp(dir)).toBe(await commitStamp(dir));
  });

  it('names the commit of a clean checkout whose filesystem cannot hold a symlink', async () => {
    const dir = await bornRepo();
    await symlink('a.txt', join(dir, 'link'));
    await commit(dir);
    await git(dir, 'config', 'core.symlinks', 'false');
    await rm(join(dir, 'link'));
    await put(dir, { link: 'a.txt' });
    expect(await git(dir, '--no-optional-locks', 'status', '--porcelain')).toBe('');
    expect(await stamp(dir)).toBe(await commitStamp(dir));
  });
});

describe('computeBuildStamp outside a checkout', { timeout: 30_000 }, () => {
  it.each([
    ['a release version', '0.2.0', 'release:0.2.0'],
    ['a release candidate', '0.3.0-rc.1', 'release:0.3.0-rc.1'],
    ['the dev sentinel', '0.0.0-dev', 'unknown'],
    ['an empty version', '', 'unknown'],
    ['no version', undefined, 'unknown'],
  ])('with %s', async (_name, version, expected) => {
    const plain = join(root, 'plain', 'x', 'y');
    await mkdir(plain, { recursive: true });
    expect(await stamp(plain, { env: { ...env, HAIVE_VERSION: version } })).toBe(expected);
  });

  it('answers a valid stamp for a start directory that does not exist', async () => {
    expect(await stamp(join(root, 'missing', 'dir'))).toMatch(STAMP_FORM);
  });
});

describe('the stamp of this process', { timeout: 60_000 }, () => {
  it('is null until initBuildStamp has run, and then holds what it computed', async () => {
    expect(currentBuildStamp()).toBeNull();
    const computed = await initBuildStamp();
    expect(computed).toMatch(STAMP_FORM);
    expect(currentBuildStamp()).toBe(computed);
    expect(await initBuildStamp()).toBe(computed);
  });
});
