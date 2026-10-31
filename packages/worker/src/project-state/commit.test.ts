import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyProjectState, renderProjectState } from '@haive/shared/project-state';
import { gitRun } from '../repo/git-exec.js';
import * as gitCommands from '../repo/git-exec.js';
import { commitHaiveProjections } from './commit.js';
const identity = {
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@local',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@local',
};
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'haive-data-commit-'));
  dirs.push(dir);
  await gitRun(dir, ['init', '-q', '-b', 'main']);
  await writeFile(join(dir, 'notes'), 'original\n');
  await gitRun(dir, ['add', 'notes']);
  await gitRun(dir, ['commit', '-qm', 'initial'], identity);
  return dir;
}
async function record(dir: string, settings: Record<string, unknown> = {}) {
  for (const [rel, text] of renderProjectState({ ...emptyProjectState(), settings })) {
    const dest = join(dir, '.haive-data/state', rel);
    await mkdir(join(dest, '..'), { recursive: true });
    await writeFile(dest, text);
  }
}
const save = (repoPath: string, message?: string) =>
  commitHaiveProjections({ repoPath, identity, message });
describe('commitHaiveProjections', () => {
  it('reports its own commit even when another commit lands before the index sync', async () => {
    const dir = await fixture();
    await record(dir);
    const original = gitCommands.gitExec;
    let advanced = false;
    vi.spyOn(gitCommands, 'gitExec').mockImplementation(async (args, options) => {
      const result = await original(args, options);
      if (args[0] === 'update-ref' && !advanced) {
        advanced = true;
        const head = (await gitRun(dir, ['rev-parse', 'HEAD'])).stdout.trim();
        const tree = (await gitRun(dir, ['rev-parse', 'HEAD^{tree}'])).stdout.trim();
        const next = (
          await gitRun(dir, ['commit-tree', tree, '-p', head, '-m', 'concurrent user'], identity)
        ).stdout.trim();
        expect((await gitRun(dir, ['update-ref', 'HEAD', next, head])).code).toBe(0);
      }
      return result;
    });
    const result = await save(dir);
    expect(advanced).toBe(true);
    expect(result.commitSha).toBe((await gitRun(dir, ['rev-parse', 'HEAD^'])).stdout.trim());
    expect(result.commitSha).not.toBe((await gitRun(dir, ['rev-parse', 'HEAD'])).stdout.trim());
    expect((await gitRun(dir, ['status', '--porcelain'])).stdout).toBe('');
  });
  it('makes one commit of plan and record, preserving unrelated staged work', async () => {
    const dir = await fixture();
    await record(dir);
    await writeFile(join(dir, '.haive-data/plan.json'), '{}\n');
    await writeFile(join(dir, '.haive-data/plan.md'), '# Plan\n');
    await writeFile(join(dir, 'notes'), 'staged\n');
    await gitRun(dir, ['add', 'notes']);
    const result = await save(dir);
    expect(result.committed).toBe(true);
    expect(result.commitSha).toMatch(/^[a-f0-9]{40}$/);
    expect(result.files).toEqual([
      '.haive-data/plan.json',
      '.haive-data/plan.md',
      '.haive-data/state/format.json',
    ]);
    expect((await gitRun(dir, ['show', 'HEAD:notes'])).stdout).toBe('original\n');
    expect((await gitRun(dir, ['diff', '--cached', '--name-only'])).stdout.trim()).toBe('notes');
    expect((await gitRun(dir, ['show', '-s', '--format=%s'])).stdout.trim()).toBe(
      'chore(haive): save Haive data',
    );
    expect(await save(dir)).toMatchObject({ committed: false, commitSha: null, files: [] });
  });
  it('commits a removed record file and removed plan files by name', async () => {
    const dir = await fixture();
    await record(dir, { 'rtk-version': '1' });
    await writeFile(join(dir, '.haive-data/plan.json'), '{}\n');
    await save(dir);
    await rm(join(dir, '.haive-data/state/settings/rtk-version.json'));
    await rm(join(dir, '.haive-data/plan.json'));
    const result = await save(dir, 'custom subject');
    expect(result.files).toEqual([
      '.haive-data/plan.json',
      '.haive-data/state/settings/rtk-version.json',
    ]);
    expect((await gitRun(dir, ['show', '-s', '--format=%s'])).stdout.trim()).toBe('custom subject');
    expect((await gitRun(dir, ['status', '--porcelain'])).stdout).toBe('');
  });
  it('leaves unknown files and their removals out, even when staged or ignored', async () => {
    const dir = await fixture();
    await record(dir);
    await writeFile(join(dir, '.haive-data/state/mine.txt'), 'personal');
    await gitRun(dir, ['add', '-f', '.haive-data/state/mine.txt']);
    const result = await save(dir);
    expect(result.skipped).toEqual(['.haive-data/state/mine.txt']);
    expect((await gitRun(dir, ['ls-tree', '-r', '--name-only', 'HEAD'])).stdout).not.toContain(
      'mine.txt',
    );
    expect((await gitRun(dir, ['diff', '--cached', '--name-only'])).stdout).toContain('mine.txt');
    await gitRun(dir, ['commit', '-qm', 'personal'], identity);
    await rm(join(dir, '.haive-data/state/mine.txt'));
    expect(await save(dir)).toMatchObject({
      committed: false,
      skipped: ['.haive-data/state/mine.txt'],
    });
    expect((await gitRun(dir, ['ls-tree', '-r', '--name-only', 'HEAD'])).stdout).toContain(
      'mine.txt',
    );
  });
  it.each(['.haive-data/state/link', '.haive-data/plan.json'])(
    'refuses a symlink at %s before any commit',
    async (rel) => {
      const dir = await fixture();
      await record(dir);
      await symlink('../notes', join(dir, rel));
      const before = (await gitRun(dir, ['rev-parse', 'HEAD'])).stdout;
      await expect(save(dir)).rejects.toHaveProperty('refusal.code', 'record_unreadable');
      expect((await gitRun(dir, ['rev-parse', 'HEAD'])).stdout).toBe(before);
      expect(await readFile(join(dir, 'notes'), 'utf8')).toBe('original\n');
    },
  );
  it('refuses an absent, invalid or non-regular record before committing any plan', async () => {
    const dir = await fixture();
    await expect(save(dir)).rejects.toHaveProperty('refusal.code', 'record_absent');
    await record(dir);
    await writeFile(join(dir, '.haive-data/state/format.json'), '{}');
    await expect(save(dir)).rejects.toHaveProperty('refusal.code', 'record_refused');
    await record(dir);
    await mkdir(join(dir, '.haive-data/plan.md'));
    await expect(save(dir)).rejects.toHaveProperty('refusal.code', 'record_unreadable');
  });
});

describe('commit read and repair controls', () => {
  it('commits on unborn HEAD', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haive-data-unborn-'));
    dirs.push(dir);
    await gitRun(dir, ['init', '-q', '-b', 'main']);
    await record(dir);
    expect(await save(dir)).toMatchObject({ committed: true, indexSynced: true });
    expect((await gitRun(dir, ['rev-list', '--count', 'HEAD'])).stdout.trim()).toBe('1');
  });
  it.each(['head', 'tree', 'blob', 'plan'] as const)(
    'classifies unreadable HEAD %s before committing',
    async (site) => {
      const dir = await fixture();
      await record(dir);
      await save(dir);
      await writeFile(join(dir, '.haive-data/state/format.json'), ' {"formatVersion": 1}');
      await record(dir, { 'rtk-version': 'changed' });
      const run = gitCommands.gitRun;
      vi.spyOn(gitCommands, 'gitRun').mockImplementation(async (cwd, args, ...rest) => {
        const fails =
          site === 'head'
            ? args.includes('HEAD^{commit}')
            : site === 'blob'
              ? args[0] === 'cat-file'
              : site === 'plan'
                ? args[0] === 'ls-tree' && args.some((a) => a.includes('plan.json'))
                : args[0] === 'ls-tree' && args.includes('-r');
        return fails ? { code: 128, stdout: '', stderr: 'unreadable' } : run(cwd, args, ...rest);
      });
      await expect(save(dir)).rejects.toHaveProperty('refusal.code', 'record_unreadable');
    },
  );
  it('skips deletions from a HEAD state directory holding only stray files', async () => {
    const dir = await fixture();
    await mkdir(join(dir, '.haive-data/state'), { recursive: true });
    await writeFile(join(dir, '.haive-data/state/stray.txt'), '<<<<<<< mine');
    await gitRun(dir, ['add', '.haive-data/state/stray.txt']);
    await gitRun(dir, ['commit', '-qm', 'stray'], identity);
    await rm(join(dir, '.haive-data/state/stray.txt'));
    await record(dir);
    expect(await save(dir)).toMatchObject({
      committed: true,
      skipped: ['.haive-data/state/stray.txt'],
    });
    expect((await gitRun(dir, ['show', 'HEAD:.haive-data/state/stray.txt'])).stdout).toBe(
      '<<<<<<< mine',
    );
  });
  it('repairs an index sync that failed on a prior commit even when the named tree is unchanged', async () => {
    const dir = await fixture();
    await record(dir);
    const exec = gitCommands.gitExec;
    vi.spyOn(gitCommands, 'gitExec').mockImplementation(async (args, options) => {
      if (args[0] === 'update-index' && !options?.env?.GIT_INDEX_FILE)
        throw new Error('index locked');
      return exec(args, options);
    });
    expect(await save(dir)).toMatchObject({ committed: true, indexSynced: false });
    vi.restoreAllMocks();
    expect((await gitRun(dir, ['diff', '--cached', '--name-only'])).stdout).toContain(
      'format.json',
    );
    expect(await save(dir)).toMatchObject({ committed: false, indexSynced: true });
    expect((await gitRun(dir, ['diff', '--cached', '--name-only'])).stdout).toBe('');
  }, 15_000);
});
