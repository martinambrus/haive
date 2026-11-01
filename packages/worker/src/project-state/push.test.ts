import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import { emptyProjectState, renderProjectState } from '@haive/shared/project-state';
import { gitRun } from '../repo/git-exec.js';
import { commitProjectStatePush } from './push.js';
const identity = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@local',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@local',
};
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function git(cwd: string, args: string[]) {
  const res = await gitRun(cwd, args, identity);
  if (res.code) throw new Error(res.stderr || res.stdout);
  return res.stdout.trim();
}
async function state(root: string, globs: string[]) {
  for (const [rel, text] of renderProjectState({
    ...emptyProjectState(),
    settings: { 'scope-exclude-globs': globs },
  })) {
    await mkdir(path.dirname(path.join(root, '.haive-data/state', rel)), { recursive: true });
    await writeFile(path.join(root, '.haive-data/state', rel), text);
  }
}
async function fixture() {
  const source = await mkdtemp(path.join(tmpdir(), 'project-state-push-'));
  dirs.push(source);
  await git(source, ['init', '-q', '-b', 'main']);
  await state(source, ['old/**']);
  await git(source, ['add', '.haive-data/state']);
  await git(source, ['commit', '-qm', 'base']);
  const target = path.join(source, 'feature');
  await git(source, ['worktree', 'add', '-q', '-b', 'feature', target]);
  return { source, target };
}
const tx = {} as Parameters<Parameters<Database['transaction']>[0]>[0];
describe('project state push into a feature worktree', () => {
  it('keeps a legacy checkout with no state record unchanged', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'legacy-projection-push-'));
    dirs.push(root);
    await git(root, ['init', '-q', '-b', 'main']);
    await writeFile(path.join(root, 'code'), 'legacy\n');
    await git(root, ['add', 'code']);
    await git(root, ['commit', '-qm', 'legacy']);
    const head = await git(root, ['rev-parse', 'HEAD']);
    expect(
      await commitProjectStatePush(tx, {
        repositoryId: null,
        sourcePath: root,
        targetPath: root,
        identity,
      }),
    ).toBeNull();
    expect(await git(root, ['rev-parse', 'HEAD'])).toBe(head);
  });

  it('copies dirty root projections to the feature commit, preserving unrelated staged bytes and unknown files', async () => {
    const { source, target } = await fixture();
    const base = await git(source, ['rev-parse', 'main']);
    await state(source, ['new/**']);
    await writeFile(path.join(target, '.haive-data/state/personal.txt'), 'personal\n');
    await writeFile(path.join(target, 'notes'), 'staged\n');
    await git(target, ['add', 'notes', '.haive-data/state/personal.txt']);
    const staged = await git(target, [
      'ls-files',
      '--stage',
      '--',
      'notes',
      '.haive-data/state/personal.txt',
    ]);
    await writeFile(path.join(target, 'notes'), 'unstaged\n');
    await commitProjectStatePush(tx, {
      repositoryId: null,
      sourcePath: source,
      targetPath: target,
      identity,
    });
    expect(await git(source, ['rev-parse', 'main'])).toBe(base);
    expect(
      await git(target, ['show', 'HEAD:.haive-data/state/settings/scope-exclude-globs.json']),
    ).toContain('new/**');
    expect(
      await git(target, ['ls-files', '--stage', '--', 'notes', '.haive-data/state/personal.txt']),
    ).toBe(staged);
    expect(
      await git(target, [
        'ls-tree',
        '--name-only',
        'HEAD',
        '--',
        'notes',
        '.haive-data/state/personal.txt',
      ]),
    ).toBe('');
    expect(await readFile(path.join(target, 'notes'), 'utf8')).toBe('unstaged\n');
  });
  it('refuses a feature file edited after put-back without overwriting it', async () => {
    const { source, target } = await fixture();
    await state(source, ['team/**']);
    await state(target, ['feature-edit/**']);
    const before = await readFile(
      path.join(target, '.haive-data/state/settings/scope-exclude-globs.json'),
      'utf8',
    );
    await expect(
      commitProjectStatePush(tx, {
        repositoryId: null,
        sourcePath: source,
        targetPath: target,
        identity,
      }),
    ).rejects.toThrow('feature project state changed');
    expect(
      await readFile(
        path.join(target, '.haive-data/state/settings/scope-exclude-globs.json'),
        'utf8',
      ),
    ).toBe(before);
  });
});
