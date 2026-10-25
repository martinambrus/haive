import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { gitRun } from './git-exec.js';
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
it.each([['fetch'], ['pull', '--ff-only'], ['push'], ['ls-remote'], ['remote', 'update']])(
  'refuses an implicit file origin: %j',
  async (...args) => {
    const root = await mkdtemp(path.join(tmpdir(), 't417-implicit-'));
    dirs.push(root);
    const git = async (argv: string[], cwd = root) => {
      const result = await gitRun(cwd, argv);
      expect(result.code, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    await git(['init', '--bare', '-b', 'main', 'bare']);
    await git(['init', '-b', 'main', 'work']);
    const work = `${root}/work`;
    await git(
      [
        '-c',
        'user.name=T',
        '-c',
        'user.email=t@example.test',
        'commit',
        '--allow-empty',
        '-m',
        'seed',
      ],
      work,
    );
    await git(['-c', 'protocol.file.allow=always', 'push', `${root}/bare`, 'main'], work);
    await git(['remote', 'add', 'origin', `${root}/bare`], work);
    await git(['config', 'branch.main.remote', 'origin'], work);
    await git(['config', 'branch.main.merge', 'refs/heads/main'], work);
    const result = await gitRun(work, args);
    expect(result.code, result.stderr).not.toBe(0);
  },
);
it('preserves the explicit host-folder refresh fetch', async () => {
  const { fastForward } = await import('./refresh.js');
  const root = await mkdtemp(path.join(tmpdir(), 't417-folder-refresh-'));
  dirs.push(root);
  const source = `${root}/source`;
  const work = `${root}/work`;
  expect((await gitRun(root, ['init', '-b', 'main', 'source'])).code).toBe(0);
  expect(
    (
      await gitRun(source, [
        '-c',
        'user.name=T',
        '-c',
        'user.email=t@example.test',
        'commit',
        '--allow-empty',
        '-m',
        'seed',
      ])
    ).code,
  ).toBe(0);
  expect(
    (await gitRun(root, ['clone', source, work], undefined, { allowFileTransport: true })).code,
  ).toBe(0);
  const result = await fastForward(
    {} as import('@haive/database').Database,
    { source: 'local_path', localPath: source, userId: 'u', repositoryId: 'r' },
    work,
  );
  expect(result).toBeNull();
});
