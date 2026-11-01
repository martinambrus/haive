import { spawn } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { logger } from '@haive/shared';
import { removeNoFollow, renameNoFollow } from '@haive/shared/fs-safe';
import JSZip from 'jszip';
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { extractArchive } from '../src/repo/clone.js';
import { gitRun } from '../src/repo/git-exec.js';

vi.mock('@haive/shared/fs-safe', async (importOriginal) => {
  const real = await importOriginal<typeof import('@haive/shared/fs-safe')>();
  return {
    ...real,
    renameNoFollow: vi.fn(real.renameNoFollow),
    removeNoFollow: vi.fn(real.removeNoFollow),
  };
});

/** Every argv a tool was started with, so a test can say what the child was told to resolve. */
const toolCalls = vi.hoisted(() => [] as string[][]);
vi.mock('../src/repo/tool-spawn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/repo/tool-spawn.js')>();
  return {
    ...actual,
    runTool: (
      cmd: string,
      args: readonly string[],
      opts?: Parameters<typeof actual.runTool>[2],
    ) => {
      toolCalls.push([cmd, ...args]);
      return actual.runTool(cmd, args, opts);
    },
  };
});

function run(cmd: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} failed (${code}): ${stderr.trim()}`));
    });
  });
}

async function buildFixtureSource(root: string, topDir: string): Promise<string> {
  const src = path.join(root, topDir);
  await mkdir(path.join(src, 'sub'), { recursive: true });
  await writeFile(path.join(src, 'README.md'), '# fixture\n');
  await writeFile(path.join(src, 'sub', 'a.txt'), 'hello\n');
  await writeFile(path.join(src, 'package.json'), JSON.stringify({ name: 'fixture' }));
  return src;
}

let tmpRoot: string;

/** The anchored form of a name directly under the fixture root. */
const at = (rel: string) => ({ anchor: tmpRoot, rel });

beforeEach(async () => {
  // Left at mkdtemp's 0700 on purpose. The tool is handed its directory and the archive as
  // descriptors, so it never traverses this by name; in the in-image job, which runs as root and so
  // drops to the unprivileged extraction uid, every case here passes through a parent that uid
  // cannot enter.
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'haive-extract-'));
  toolCalls.length = 0;
});

afterEach(async () => {
  vi.mocked(renameNoFollow).mockReset();
  vi.mocked(removeNoFollow).mockReset();
  vi.restoreAllMocks();
  await rm(tmpRoot, { recursive: true, force: true });
});

const gitEnv = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};
async function g(cwd: string, ...args: string[]): Promise<string> {
  const result = await gitRun(cwd, args, gitEnv);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
}
async function gitFixture(): Promise<string> {
  const src = await buildFixtureSource(tmpRoot, 'git-project');
  await g(src, 'init', '-q', '-b', 'main');
  await writeFile(path.join(src, '.gitattributes'), '*.txt filter=imported\n');
  await g(src, 'add', '-A');
  await g(src, 'commit', '-qm', 'uploaded history');
  return src;
}
async function packGitFixture(): Promise<void> {
  await run('tar', ['-czf', path.join(tmpRoot, 'git.tar.gz'), '-C', tmpRoot, 'git-project']);
}

describe('extractArchive', () => {
  it('preserves uploaded history while removing a filter before hardened host Git stages files', async () => {
    expect((await stat(tmpRoot)).mode & 0o777).toBe(0o700);
    const src = await gitFixture();
    const head = await g(src, 'rev-parse', 'HEAD');
    await g(src, 'branch', 'saved-branch');
    await g(src, 'tag', 'saved-tag');
    const refs = await g(src, 'show-ref');
    await chmod(path.join(src, '.git/config'), 0o600);
    await g(src, 'remote', 'add', 'origin', 'https://example.invalid/project.git');
    await g(src, 'config', 'branch.main.remote', 'origin');
    await g(src, 'config', 'branch.main.merge', 'refs/heads/main');
    const marker = path.join(tmpRoot, 'filter-marker');
    await g(src, 'config', 'filter.imported.clean', `echo executed > ${marker}; cat`);
    await run('tar', ['-czf', path.join(tmpRoot, 'git.tar.gz'), '-C', tmpRoot, 'git-project']);
    const report = await extractArchive(at('git.tar.gz'), 'tar.gz', at('out-git'), {
      repositoryImport: true,
    });
    const dest = path.join(tmpRoot, 'out-git');
    expect(await g(dest, 'rev-parse', 'HEAD')).toBe(head);
    expect(await g(dest, 'show-ref')).toBe(refs);
    expect(await g(dest, 'config', '--bool', 'core.bare')).toBe('false');
    expect(await g(dest, 'rev-parse', '--is-bare-repository')).toBe('false');
    expect((await stat(path.join(dest, '.git/config'))).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(dest, '.git/config'))).uid).toBe(process.getuid?.());
    expect((await stat(path.join(dest, 'sub/a.txt'))).uid).toBe(process.getuid?.());
    expect(await g(dest, 'config', 'branch.main.merge')).toBe('refs/heads/main');
    expect(await g(dest, 'remote', 'get-url', 'origin')).toBe(
      'https://example.invalid/project.git',
    );
    expect(await readFile(path.join(dest, 'sub/a.txt'), 'utf8')).toBe('hello\n');
    await writeFile(path.join(dest, 'sub/a.txt'), 'changed\n');
    await g(dest, 'add', '-A');
    expect(await readdir(tmpRoot)).not.toContain('filter-marker');
    expect(report.note).toContain('Git configuration');
  });

  it('uses Git grammar without following includes and retains only safe metadata', async () => {
    const src = await gitFixture();
    const included = path.join(tmpRoot, 'secret-include');
    // Invalid syntax proves the parser never opens it, even for an unconditional include.
    await writeFile(included, '[invalid secret-value');
    await g(src, 'remote', 'add', 'origin', 'https://example.invalid/project.git');
    await g(src, 'config', 'branch.feature/topic.remote', 'origin');
    await g(src, 'config', 'branch.feature/topic.description', 'quotes " and \\ and\nnew line');
    await g(src, 'config', 'user.name', 'Safe "User"');
    const config = path.join(src, '.git/config');
    await writeFile(
      config,
      (await readFile(config, 'utf8')) +
        `
[include]
  path = ${included}
[includeIf "gitdir:**"]
  path = ${included}
[filter "imported"]
  clean = "secret-command"
  smudge = "secret-command"
  process = "secret-command"
[merge "imported"]
  driver = "secret-command"
[remote "origin"]
  vcs = "../secret-helper"
  uploadpack = "secret-command"
[protocol "secret-helper"]
  allow = always
[core]
  hooksPath = "secret-command"
  sshCommand = "secret-command"
[credential]
  helper = "secret-command"
`,
    );
    await packGitFixture();
    const report = await extractArchive(at('git.tar.gz'), 'tar.gz', at('out-git'), {
      repositoryImport: true,
    });
    const dest = path.join(tmpRoot, 'out-git');
    const sanitized = await readFile(path.join(dest, '.git/config'), 'utf8');
    expect(sanitized).not.toContain('secret');
    expect(report.note).not.toContain('secret');
    expect(await g(dest, 'config', 'branch.feature/topic.description')).toBe(
      'quotes " and \\ and\nnew line',
    );
    expect(await g(dest, 'config', 'user.name')).toBe('Safe "User"');
    expect(await g(dest, 'remote', 'get-url', 'origin')).toBe(
      'https://example.invalid/project.git',
    );
    // Parser argv consumes held input, never a pathname from the staged repository.
    expect(
      toolCalls.some(
        (args) => args.includes('--no-includes') && args.includes('--file') && args.includes('-'),
      ),
    ).toBe(true);
  });

  it.each([
    'invalid-config',
    'extension',
    'partial',
    'promisor-config',
    'promisor-pack',
    'worktree-config',
    'worktrees',
    'gitfile',
    'alternates',
    'shallow',
    'missing-object',
    'config-link',
    'bare',
  ])('refuses %s before replacing the old destination', async (shape) => {
    const src = await gitFixture();
    const config = path.join(src, '.git/config');
    if (shape === 'invalid-config') await writeFile(config, '[invalid secret-value');
    if (shape === 'extension')
      await writeFile(
        config,
        (await readFile(config, 'utf8')) + '\n[extensions]\nunknown = secret-value\n',
      );
    if (shape === 'partial') await g(src, 'config', 'extensions.partialClone', 'origin');
    if (shape === 'promisor-config') await g(src, 'config', 'remote.origin.promisor', 'true');
    if (shape === 'promisor-pack')
      await writeFile(path.join(src, '.git/objects/pack/pack-test.promisor'), '');
    if (shape === 'worktree-config') await g(src, 'config', 'core.worktree', '/secret-value');
    if (shape === 'worktrees')
      await mkdir(path.join(src, '.git/worktrees/other'), { recursive: true });
    if (shape === 'gitfile') {
      await rm(path.join(src, '.git'), { recursive: true });
      await writeFile(path.join(src, '.git'), 'gitdir: /secret-value');
    }
    if (shape === 'alternates')
      await writeFile(path.join(src, '.git/objects/info/alternates'), '/secret-value\n');
    if (shape === 'shallow')
      await writeFile(path.join(src, '.git/shallow'), (await g(src, 'rev-parse', 'HEAD')) + '\n');
    if (shape === 'missing-object') {
      const head = await g(src, 'rev-parse', 'HEAD');
      await rm(path.join(src, '.git/objects', head.slice(0, 2), head.slice(2)));
    }
    if (shape === 'config-link') {
      await rm(config);
      await symlink('/secret-value', config);
    }
    if (shape === 'bare') {
      const entries = await readdir(path.join(src, '.git'));
      for (const name of entries)
        await renameNoFollow(tmpRoot, `git-project/.git/${name}`, `git-project/${name}`);
      await rm(path.join(src, '.git'), { recursive: true });
    }
    await packGitFixture();
    const dest = path.join(tmpRoot, 'old');
    await mkdir(dest);
    await writeFile(path.join(dest, 'keep.txt'), 'old bytes');
    const previous = await stat(path.join(dest, 'keep.txt'));
    const extraction = extractArchive(at('git.tar.gz'), 'tar.gz', at('old'), {
      repositoryImport: true,
    });
    await expect(extraction).rejects.toThrow(
      /Uploaded Git metadata.*Upload a complete standalone checkout/,
    );
    await expect(extraction).rejects.not.toThrow('secret-value');
    expect(await readFile(path.join(dest, 'keep.txt'), 'utf8')).toBe('old bytes');
    expect((await stat(path.join(dest, 'keep.txt'))).ino).toBe(previous.ino);
    expect((await readdir(tmpRoot)).filter((name) => name.startsWith('.haive-extract-'))).toEqual(
      [],
    );
  });

  it('keeps Git-named files as data for generic attachment and bundle extraction', async () => {
    const zip = new JSZip();
    zip.file('.git/config', '[invalid syntax is still user data');
    zip.file('README.md', 'user data');
    await writeFile(
      path.join(tmpRoot, 'data.zip'),
      await zip.generateAsync({ type: 'nodebuffer' }),
    );
    const report = await extractArchive(at('data.zip'), 'zip', at('data'));
    expect(await readFile(path.join(tmpRoot, 'data/.git/config'), 'utf8')).toBe(
      '[invalid syntax is still user data',
    );
    expect(report.note).toBeNull();
  });

  it('extracts .tar.gz and flattens single top-level directory', async () => {
    await buildFixtureSource(tmpRoot, 'my-project');
    const archivePath = path.join(tmpRoot, 'fixture.tar.gz');
    await run('tar', ['-czf', archivePath, '-C', tmpRoot, 'my-project']);

    const dest = path.join(tmpRoot, 'out');
    await extractArchive(at('fixture.tar.gz'), 'tar.gz', at('out'), { repositoryImport: true });

    const entries = await readdir(dest);
    expect(entries.sort()).toEqual(['README.md', 'package.json', 'sub'].sort());
    const readme = await readFile(path.join(dest, 'README.md'), 'utf8');
    expect(readme).toBe('# fixture\n');
    const sub = await readFile(path.join(dest, 'sub', 'a.txt'), 'utf8');
    expect(sub).toBe('hello\n');
  });

  it('extracts plain .tar', async () => {
    await buildFixtureSource(tmpRoot, 'proj');
    const archivePath = path.join(tmpRoot, 'fixture.tar');
    await run('tar', ['-cf', archivePath, '-C', tmpRoot, 'proj']);

    const dest = path.join(tmpRoot, 'out-tar');
    await extractArchive(at('fixture.tar'), 'tar', at('out-tar'));

    const entries = await readdir(dest);
    expect(entries).toContain('README.md');
    expect(entries).toContain('package.json');
  });

  it('extracts .zip and flattens single top-level directory', async () => {
    await buildFixtureSource(tmpRoot, 'zipped');
    const archivePath = path.join(tmpRoot, 'fixture.zip');
    // Build the fixture archive in pure JS so the test doesn't depend on the
    // `zip` system binary (only `unzip` is installed in the runtime image).
    const zip = new JSZip();
    zip.file('zipped/README.md', '# fixture\n');
    zip.file('zipped/sub/a.txt', 'hello\n');
    zip.file('zipped/package.json', JSON.stringify({ name: 'fixture' }));
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    await writeFile(archivePath, zipBuffer);

    const dest = path.join(tmpRoot, 'out-zip');
    await extractArchive(at('fixture.zip'), 'zip', at('out-zip'));

    const entries = await readdir(dest);
    expect(entries.sort()).toEqual(['README.md', 'package.json', 'sub'].sort());
  });

  it('does not flatten when archive has multiple top-level entries', async () => {
    const src = path.join(tmpRoot, 'multi');
    await mkdir(path.join(src, 'dirA'), { recursive: true });
    await mkdir(path.join(src, 'dirB'), { recursive: true });
    await writeFile(path.join(src, 'dirA', 'a'), '1');
    await writeFile(path.join(src, 'dirB', 'b'), '2');
    const archivePath = path.join(tmpRoot, 'multi.tar.gz');
    await run('tar', ['-czf', archivePath, '-C', src, 'dirA', 'dirB']);

    const dest = path.join(tmpRoot, 'out-multi');
    await extractArchive(at('multi.tar.gz'), 'tar.gz', at('out-multi'));

    const entries = await readdir(dest);
    expect(entries.sort()).toEqual(['dirA', 'dirB']);
  });

  it('does not flatten when the only top-level entry is a link', async () => {
    // An uploaded archive is untrusted, and the flatten used to `stat` its lone entry: a LINK there
    // was followed, `readdir` listed the TARGET's children, and each was renamed into the
    // destination. With `x -> ..` those children are the user's other repositories.
    const staging = path.join(tmpRoot, 'staging');
    const sibling = path.join(tmpRoot, 'sibling-repo');
    await mkdir(staging, { recursive: true });
    await mkdir(sibling, { recursive: true });
    await writeFile(path.join(sibling, 'their-file.txt'), 'another repo\n');
    await run('ln', ['-s', '..', path.join(staging, 'escape')]);
    const archivePath = path.join(tmpRoot, 'link.tar.gz');
    // No `-h`: tar stores a symlink AS a symlink by default, which is the fixture this needs.
    await run('tar', ['-czf', archivePath, '-C', staging, 'escape']);

    const dest = path.join(tmpRoot, 'out-link');
    const report = await extractArchive(at('link.tar.gz'), 'tar.gz', at('out-link'));

    // The link is DROPPED now, not merely left unfollowed — a symlink cannot safely live in an
    // extracted repository tree, and the flatten is no longer the only thing standing between
    // `escape -> ..` and every sibling repository under the staging parent.
    const entries = await readdir(dest);
    expect(entries).toEqual([]);
    expect(entries).not.toContain('sibling-repo');

    // And the drop is REPORTED. A member silently removed from someone's upload is the one outcome
    // worse than refusing the archive outright.
    expect(report.dropped).toEqual([{ rel: 'escape', reason: 'symlink' }]);
    expect(report.note).toContain('not extracted');
    expect(report.note).toContain('escape');

    // The sibling it pointed at is untouched.
    const siblingFile = await readFile(path.join(sibling, 'their-file.txt'), 'utf8');
    expect(siblingFile).toBe('another repo\n');
  });

  it('reports nothing when every member is ordinary', async () => {
    await buildFixtureSource(tmpRoot, 'clean');
    const archivePath = path.join(tmpRoot, 'clean.tar.gz');
    await run('tar', ['-czf', archivePath, '-C', tmpRoot, 'clean']);

    const report = await extractArchive(at('clean.tar.gz'), 'tar.gz', at('out-clean'));
    expect(report.dropped).toEqual([]);
    expect(report.note).toBeNull();
  });

  it('drops every link a zip carries and names each one, however deep', async () => {
    // Every other link case here is a TAR. Production reads a .zip with Info-ZIP, which restores
    // link entries of its own accord (MEASURED against the image's unzip 6.00), so the staged-tree
    // walk — not the tool — is what has to catch them. `platform: 'UNIX'` is load-bearing: without
    // it JSZip writes a DOS "version made by", unzip ignores the mode bits, and both entries land
    // as ordinary files holding the target text, leaving this asserting a drop that never happened.
    const archivePath = path.join(tmpRoot, 'links.zip');
    const zip = new JSZip();
    zip.file('README.md', '# fixture\n');
    zip.file('src/index.js', 'export const x = 1;\n');
    zip.file('config-ref', '../outside/config.json', { unixPermissions: 0o120777 });
    zip.file('docs/readme-link', '../README.md', { unixPermissions: 0o120777 });
    await writeFile(archivePath, await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }));

    const dest = path.join(tmpRoot, 'out-zip-links');
    const report = await extractArchive(at('links.zip'), 'zip', at('out-zip-links'));

    // Named by their path relative to the extracted root, so a member nested below the top level is
    // distinguishable from one beside it — a walk that only checked depth 1 would pass every other
    // case in this file and fail here. Sorted, because the walk is a LIFO stack over an unsorted
    // `readdir` and the order of `dropped` is not part of the contract.
    expect([...report.dropped].sort((a, b) => a.rel.localeCompare(b.rel))).toEqual([
      { rel: 'config-ref', reason: 'symlink' },
      { rel: 'docs/readme-link', reason: 'symlink' },
    ]);
    expect(report.note).toContain('not extracted');
    expect(report.note).toContain('config-ref');
    expect(report.note).toContain('docs/readme-link');

    // The ordinary members survive, and the directory that held a link is kept rather than removed
    // with it.
    expect((await readdir(dest)).sort()).toEqual(['README.md', 'docs', 'src']);
    expect(await readdir(path.join(dest, 'docs'))).toEqual([]);
    expect(await readFile(path.join(dest, 'README.md'), 'utf8')).toBe('# fixture\n');
  });

  it('drops a link even when its target sits inside the same tree', async () => {
    // Deliberate, and nothing else pins it: an in-tree target is still extracted at its own path,
    // so refusing the link loses no content, and an in-tree link is how a tree names a file that is
    // otherwise masked or private. A change that starts keeping these should fail right here.
    const archivePath = path.join(tmpRoot, 'intree.zip');
    const zip = new JSZip();
    zip.file('README.md', '# real\n');
    zip.file('keep.txt', 'ordinary\n');
    zip.file('alias.md', 'README.md', { unixPermissions: 0o120777 });
    await writeFile(archivePath, await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }));

    const dest = path.join(tmpRoot, 'out-intree');
    const report = await extractArchive(at('intree.zip'), 'zip', at('out-intree'));

    expect(report.dropped).toEqual([{ rel: 'alias.md', reason: 'symlink' }]);
    expect((await readdir(dest)).sort()).toEqual(['README.md', 'keep.txt']);
    expect(await readFile(path.join(dest, 'README.md'), 'utf8')).toBe('# real\n');
  });

  it('does not flatten a zip with several top-level entries', async () => {
    // The tar path has this case; the zip path reaches the flatten through a different branch
    // (`unzip -d`, rather than tar reading the archive on stdin) and had none.
    const archivePath = path.join(tmpRoot, 'multi.zip');
    const zip = new JSZip();
    zip.file('dirA/a.txt', '1');
    zip.file('dirB/b.txt', '2');
    await writeFile(archivePath, await zip.generateAsync({ type: 'nodebuffer' }));

    const dest = path.join(tmpRoot, 'out-zip-multi');
    const report = await extractArchive(at('multi.zip'), 'zip', at('out-zip-multi'));

    expect((await readdir(dest)).sort()).toEqual(['dirA', 'dirB']);
    expect(report.dropped).toEqual([]);
  });

  it('replaces an existing destination only once the new tree is ready', async () => {
    // The swap is the reason extraction stages: the old shape `rm -rf`'d the destination BEFORE
    // unpacking, so a failure left the repository empty. Here the previous contents survive until a
    // validated tree is ready to take their place.
    const dest = path.join(tmpRoot, 'out-replace');
    await mkdir(dest, { recursive: true });
    await writeFile(path.join(dest, 'previous.txt'), 'old\n');

    await buildFixtureSource(tmpRoot, 'fresh');
    const archivePath = path.join(tmpRoot, 'fresh.tar.gz');
    await run('tar', ['-czf', archivePath, '-C', tmpRoot, 'fresh']);
    await extractArchive(at('fresh.tar.gz'), 'tar.gz', at('out-replace'));

    const entries = await readdir(dest);
    expect(entries).toContain('README.md');
    expect(entries).not.toContain('previous.txt');
    // No stage left beside it.
    expect((await readdir(tmpRoot)).filter((n) => n.startsWith('.haive-extract-'))).toEqual([]);
  });

  it('restores the previous destination when the new tree cannot be renamed in', async () => {
    const dest = path.join(tmpRoot, 'out-restore');
    await mkdir(path.join(dest, 'nested'), { recursive: true });
    await writeFile(path.join(dest, 'previous.txt'), 'old\n');
    await writeFile(path.join(dest, 'nested', 'keep.txt'), 'keep\n');
    const previous = await stat(dest);
    const previousFile = await stat(path.join(dest, 'nested', 'keep.txt'));

    await buildFixtureSource(tmpRoot, 'fresh');
    await run('tar', ['-czf', path.join(tmpRoot, 'fresh.tar.gz'), '-C', tmpRoot, 'fresh']);
    let source: string | undefined;
    await expect(
      extractArchive(at('fresh.tar.gz'), 'tar.gz', at('out-restore'), {
        keepLoneDir: (name) => {
          // Remove the staged source after its last inspection. The real rename of the old
          // destination still succeeds, then installing this missing source fails with ENOENT.
          // This existing synchronous callback makes the failure deterministic without a fault in
          // either fs-safe primitive (their module wrappers stay inert here) or a production
          // fault-injection API.
          const stage = readdirSync(tmpRoot).find((n) => n.startsWith('.haive-extract-'))!;
          source = path.join(tmpRoot, stage, 'x', name);
          rmSync(source, { recursive: true });
          return false;
        },
      }),
    ).rejects.toMatchObject({
      code: 'ENOENT',
      path: expect.stringMatching(/\/fresh$/),
    });
    expect(source).toBeDefined();
    expect(await readFile(path.join(dest, 'previous.txt'), 'utf8')).toBe('old\n');
    expect(await readFile(path.join(dest, 'nested', 'keep.txt'), 'utf8')).toBe('keep\n');
    expect((await stat(dest)).ino).toBe(previous.ino);
    expect((await stat(path.join(dest, 'nested', 'keep.txt'))).ino).toBe(previousFile.ino);
    expect((await readdir(dest)).sort()).toEqual(['nested', 'previous.txt']);
    expect((await readdir(tmpRoot)).filter((n) => n.startsWith('.haive-extract-'))).toEqual([]);
  });

  it('retains the previous tree and logs when restoring the destination also fails', async () => {
    const dest = path.join(tmpRoot, 'out-restore-fails');
    await mkdir(dest);
    await writeFile(path.join(dest, 'previous.txt'), 'old\n');
    await buildFixtureSource(tmpRoot, 'fresh');
    await run('tar', ['-czf', path.join(tmpRoot, 'fresh.tar.gz'), '-C', tmpRoot, 'fresh']);

    const real =
      await vi.importActual<typeof import('@haive/shared/fs-safe')>('@haive/shared/fs-safe');
    const restoreError = new Error('restore rename failed');
    let installError: unknown;
    vi.mocked(renameNoFollow).mockImplementation(async (...args) => {
      if (args[1].endsWith('/old')) throw restoreError;
      try {
        return await real.renameNoFollow(...args);
      } catch (err) {
        installError = err;
        throw err;
      }
    });
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    const extraction = extractArchive(at('fresh.tar.gz'), 'tar.gz', at('out-restore-fails'), {
      keepLoneDir: (name) => {
        const stage = readdirSync(tmpRoot).find((n) => n.startsWith('.haive-extract-'))!;
        rmSync(path.join(tmpRoot, stage, 'x', name), { recursive: true });
        return false;
      },
    });
    await expect(extraction).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(extraction).rejects.toBe(installError);
    expect(vi.mocked(renameNoFollow)).toHaveBeenCalledTimes(3);

    const stages = (await readdir(tmpRoot)).filter((n) => n.startsWith('.haive-extract-'));
    expect(stages).toHaveLength(1);
    const oldRel = `${stages[0]}/old`;
    expect(await readFile(path.join(tmpRoot, oldRel, 'previous.txt'), 'utf8')).toBe('old\n');
    expect(errorLog).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        err: restoreError,
        anchor: tmpRoot,
        oldRel,
        oldPath: path.join(tmpRoot, oldRel),
      }),
      expect.any(String),
    );
  });

  it('removes the stage without a rollback error when the first install fails', async () => {
    await buildFixtureSource(tmpRoot, 'fresh');
    await run('tar', ['-czf', path.join(tmpRoot, 'fresh.tar.gz'), '-C', tmpRoot, 'fresh']);
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    await expect(
      extractArchive(at('fresh.tar.gz'), 'tar.gz', at('out-first-install'), {
        keepLoneDir: (name) => {
          const stage = readdirSync(tmpRoot).find((n) => n.startsWith('.haive-extract-'))!;
          rmSync(path.join(tmpRoot, stage, 'x', name), { recursive: true });
          return false;
        },
      }),
    ).rejects.toMatchObject({ code: 'ENOENT', path: expect.stringMatching(/\/fresh$/) });

    expect(errorLog).not.toHaveBeenCalled();
    const entries = await readdir(tmpRoot);
    expect(entries).not.toContain('out-first-install');
    expect(entries.filter((n) => n.startsWith('.haive-extract-'))).toEqual([]);
  });

  it('warns with the stage path without failing a successful extract when stage removal fails', async () => {
    const dest = path.join(tmpRoot, 'out-cleanup-fails');
    await mkdir(dest);
    await writeFile(path.join(dest, 'previous.txt'), 'old\n');
    await buildFixtureSource(tmpRoot, 'fresh');
    await run('tar', ['-czf', path.join(tmpRoot, 'fresh.tar.gz'), '-C', tmpRoot, 'fresh']);
    const removalError = new Error('stage removal failed');
    vi.mocked(removeNoFollow).mockRejectedValueOnce(removalError);
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await expect(
      extractArchive(at('fresh.tar.gz'), 'tar.gz', at('out-cleanup-fails')),
    ).resolves.toEqual({ dropped: [], note: null });
    expect(await readFile(path.join(dest, 'README.md'), 'utf8')).toBe('# fixture\n');
    expect(await readdir(dest)).not.toContain('previous.txt');
    const stages = (await readdir(tmpRoot)).filter((n) => n.startsWith('.haive-extract-'));
    expect(stages).toHaveLength(1);
    const stageRel = stages[0]!;
    expect(await readFile(path.join(tmpRoot, stageRel, 'old', 'previous.txt'), 'utf8')).toBe(
      'old\n',
    );
    expect(removeNoFollow).toHaveBeenCalledExactlyOnceWith(tmpRoot, stageRel, {
      recursive: true,
      repairPermissions: true,
    });
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        err: removalError,
        stagePath: path.join(tmpRoot, stageRel),
      }),
      expect.any(String),
    );
  });

  it('rejects unsupported format', async () => {
    const archivePath = path.join(tmpRoot, 'fake.bin');
    await writeFile(archivePath, 'not an archive');
    await expect(extractArchive(at('fake.bin'), 'rar' as never, at('out-bad'))).rejects.toThrow();
  });

  it.runIf(process.getuid?.() === 0)(
    'extracts a zip only the worker could read, as the unprivileged uid, twice at once',
    async () => {
      const zip = new JSZip();
      zip.file('private/README.md', '# owner only\n');
      await writeFile(
        path.join(tmpRoot, 'private.zip'),
        await zip.generateAsync({ type: 'nodebuffer' }),
        {
          mode: 0o600,
        },
      );

      // Twice at once, as two overlapping expansions of one attachment do.
      await Promise.all([
        extractArchive(at('private.zip'), 'zip', at('out-private')),
        extractArchive(at('private.zip'), 'zip', at('out-private-2')),
      ]);

      for (const out of ['out-private', 'out-private-2']) {
        expect(await readFile(path.join(tmpRoot, out, 'README.md'), 'utf8')).toBe('# owner only\n');
      }
      // Read through a private copy, so the archive itself never changed mode.
      expect((await stat(path.join(tmpRoot, 'private.zip'))).mode & 0o777).toBe(0o600);
    },
  );

  it('refuses an archive reached through a link, and creates nothing', async () => {
    // The archive is opened before anything else happens, without following a link anywhere on
    // its way: a link planted at an upload's path could otherwise stream any file the worker reads.
    await buildFixtureSource(tmpRoot, 'real');
    await run('tar', ['-czf', path.join(tmpRoot, 'real.tar.gz'), '-C', tmpRoot, 'real']);
    await symlink('real.tar.gz', path.join(tmpRoot, 'planted.tar.gz'));

    await expect(
      extractArchive(at('planted.tar.gz'), 'tar.gz', at('out-planted')),
    ).rejects.toThrow();
    const left = await readdir(tmpRoot);
    expect(left).not.toContain('out-planted');
    expect(left.filter((n) => n.startsWith('.haive-extract-'))).toEqual([]);
    expect(toolCalls).toEqual([]);
  });

  it('refuses a destination whose parent chain holds a link, and writes nothing through it', async () => {
    // The shape an attachment has: an uploads dir under `.haive/`, which the sandbox can write.
    const anchor = path.join(tmpRoot, 'repo');
    const outside = path.join(tmpRoot, 'outside');
    await mkdir(anchor);
    await mkdir(outside);
    await symlink('../outside', path.join(anchor, '.haive'));
    await buildFixtureSource(anchor, 'src');
    await run('tar', ['-czf', path.join(anchor, 'a.tar.gz'), '-C', anchor, 'src']);

    await expect(
      extractArchive({ anchor, rel: 'a.tar.gz' }, 'tar.gz', {
        anchor,
        rel: '.haive/task-uploads/t/raw',
      }),
    ).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
    expect(toolCalls).toEqual([]);
  });

  it('names no host path to the tool, only the descriptors it was handed', async () => {
    await buildFixtureSource(tmpRoot, 'both');
    await run('tar', ['-czf', path.join(tmpRoot, 'both.tar.gz'), '-C', tmpRoot, 'both']);
    const zip = new JSZip();
    zip.file('both/README.md', '# fixture\n');
    await writeFile(
      path.join(tmpRoot, 'both.zip'),
      await zip.generateAsync({ type: 'nodebuffer' }),
    );

    await extractArchive(at('both.tar.gz'), 'tar.gz', at('out-both-tar'));
    await extractArchive(at('both.zip'), 'zip', at('out-both-zip'));

    expect(toolCalls.map((argv) => argv[0])).toEqual(['tar', 'unzip']);
    const paths = toolCalls.flat().filter((arg) => arg.includes('/'));
    expect(paths.length).toBeGreaterThan(0);
    for (const arg of paths) expect(arg).toMatch(/^\/proc\/self\/fd\/\d+$/);
  });
});
