import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ error: null as Error | null, leaf: '' }));
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  return {
    ...real,
    lstat: (...args: Parameters<typeof real.lstat>) => {
      if (h.error && String(args[0]).endsWith('/' + h.leaf)) {
        throw h.error;
      }
      return real.lstat(...args);
    },
  };
});
import { captureFixBaseline, relocateFixerChanges } from '../src/step-engine/git-merge.js';
const exec = promisify(execFile);
let template: string;
let root: string;
const git = (cwd: string, args: string[]) =>
  exec('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_COMMITTER_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.test',
      GIT_COMMITTER_EMAIL: 't@example.test',
    },
  });
beforeAll(async () => {
  template = await mkdtemp(path.join(tmpdir(), 'merge-resource-template-'));
  await git(template, ['init', '-q', '-b', 'main']);
  await writeFile(path.join(template, 'conflict.txt'), 'base');
  await writeFile(path.join(template, 'keep.txt'), 'private baseline');
  await writeFile(path.join(template, '.gitignore'), '*.cache\n');
  await git(template, ['add', '-A']);
  await git(template, ['commit', '-qm', 'base']);
  await git(template, ['checkout', '-qb', 'feature']);
  await writeFile(path.join(template, 'conflict.txt'), 'feature');
  await git(template, ['commit', '-qam', 'feature']);
  await git(template, ['checkout', '-q', 'main']);
  await writeFile(path.join(template, 'conflict.txt'), 'main');
  await git(template, ['commit', '-qam', 'main']);
  await git(template, ['merge', '--no-edit', 'feature']).catch(() => undefined);
});
afterAll(async () => rm(template, { recursive: true, force: true }));
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'merge-resource-'));
  await cp(template, root, { recursive: true });
});
afterEach(async () => {
  h.error = null;
  await rm(root, { recursive: true, force: true });
});

it.each(['manifest.json', 'keep.txt'])('does not take an unread %s for absence', async (leaf) => {
  for (const code of ['EMFILE', 'ENFILE']) {
    h.error = null;
    await writeFile(path.join(root, 'keep.txt'), 'private baseline');
    await chmod(path.join(root, 'keep.txt'), 0o644);
    const baseline = await captureFixBaseline(root, async () => null);
    expect(baseline).not.toHaveProperty('unavailable');
    await writeFile(path.join(root, 'keep.txt'), 'private fixer edit');
    await chmod(path.join(root, 'keep.txt'), 0o600);
    if (leaf === 'manifest.json') {
      const folder = path.join(root, '.haive/merge-leftovers/task', code);
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, 'manifest.json'), 'earlier recovery record');
    }
    h.leaf = leaf;
    const err = Object.assign(new Error('injected'), { code });
    h.error = err;
    await expect(
      relocateFixerChanges(root, baseline, { taskId: 'task', runId: code }, async () => null),
    ).rejects.toBe(err);
    expect(await readFile(path.join(root, 'keep.txt'), 'utf8')).toBe('private fixer edit');
    expect((await stat(path.join(root, 'keep.txt'))).mode & 0o777).toBe(0o600);
    if (leaf === 'manifest.json')
      expect(
        await readFile(
          path.join(root, '.haive/merge-leftovers/task', code, 'manifest.json'),
          'utf8',
        ),
      ).toBe('earlier recovery record');
  }
});

it('does not restore over an unread directory holding an ignored file', async () => {
  const baseline = await captureFixBaseline(root, async () => null);
  expect(baseline).not.toHaveProperty('unavailable');
  await rm(path.join(root, 'keep.txt'));
  await mkdir(path.join(root, 'keep.txt'));
  await writeFile(path.join(root, 'keep.txt/personal.cache'), 'personal data');
  h.leaf = 'keep.txt';
  const err = Object.assign(new Error('injected'), { code: 'EMFILE' });
  h.error = err;
  await expect(
    relocateFixerChanges(root, baseline, { taskId: 'task', runId: 'directory' }, async () => null),
  ).rejects.toBe(err);
  expect(await readFile(path.join(root, 'keep.txt/personal.cache'), 'utf8')).toBe('personal data');
});
