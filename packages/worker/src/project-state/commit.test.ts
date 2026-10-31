import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@haive/shared';
import * as stateReads from './sync.js';
import * as safeFs from '@haive/shared/fs-safe';
import { emptyProjectState, renderProjectState } from '@haive/shared/project-state';
import { gitRun } from '../repo/git-exec.js';
import * as gitCommands from '../repo/git-exec.js';
import { commitHaiveProjections } from './commit.js';
import { commitRecorded } from '../step-engine/steps/onboarding/_stage-paths.js';
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
const save = (
  repoPath: string,
  message?: string,
  waitForIndexRetry?: (ms: number) => Promise<void>,
) =>
  commitHaiveProjections({
    repositoryId: '00000000-0000-4000-8000-000000000001',
    repoPath,
    identity,
    message,
    waitForIndexRetry,
  });
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
    await expect(save(dir)).resolves.toMatchObject({ committed: true, indexSynced: true });
    expect((await gitRun(dir, ['rev-list', '--count', 'HEAD'])).stdout.trim()).toBe('1');
  });
  it.each(['record', 'head', 'tree', 'blob', 'plan-stat', 'plan'] as const)(
    'classifies unreadable HEAD %s before committing',
    async (site) => {
      const dir = await fixture();
      await record(dir);
      await save(dir);
      await writeFile(join(dir, '.haive-data/state/format.json'), ' {"formatVersion": 1}');
      await record(dir, { 'rtk-version': 'changed' });
      const warning = vi.spyOn(logger, 'warn');
      if (site === 'record')
        vi.spyOn(stateReads, 'readStateFiles').mockRejectedValue(new Error('record unreadable'));
      if (site === 'plan-stat') {
        const stat = safeFs.lstatNoFollow;
        vi.spyOn(safeFs, 'lstatNoFollow').mockImplementation((anchor, rel, options) =>
          rel === '.haive-data/plan.json'
            ? Promise.reject(new Error('stat unreadable'))
            : stat(anchor, rel, options),
        );
      }
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
      expect(warning).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.anything(),
          repositoryId: '00000000-0000-4000-8000-000000000001',
        }),
        'Haive data projection read failed',
      );
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
    const waitForIndexRetry = vi.fn(async (_ms: number) => undefined);
    expect(await save(dir, undefined, waitForIndexRetry)).toMatchObject({
      committed: true,
      indexSynced: false,
    });
    expect(waitForIndexRetry.mock.calls.map(([ms]) => ms)).toEqual([200, 400, 800, 1600, 3200]);
    vi.restoreAllMocks();
    expect((await gitRun(dir, ['diff', '--cached', '--name-only'])).stdout).toContain(
      'format.json',
    );
    expect(await save(dir)).toMatchObject({ committed: false, indexSynced: true });
    expect((await gitRun(dir, ['diff', '--cached', '--name-only'])).stdout).toBe('');
  }, 15_000);
});

it('a clean no-op never writes the real index, even with a stale index.lock', async () => {
  const dir = await fixture();
  await record(dir);
  await save(dir);
  const before = await readFile(join(dir, '.git/index'));
  await writeFile(join(dir, '.git/index.lock'), 'stale lock');
  const exec = gitCommands.gitExec;
  const writes: string[][] = [];
  vi.spyOn(gitCommands, 'gitExec').mockImplementation(async (args, options) => {
    if (args[0] === 'update-index' && !options?.env?.GIT_INDEX_FILE) writes.push(args);
    return exec(args, options);
  });
  expect(await save(dir)).toMatchObject({ committed: false, indexSynced: true });
  expect(writes).toEqual([]);
  expect(await readFile(join(dir, '.git/index'))).toEqual(before);
});
it('a no-op repairs only the named entries differing from HEAD', async () => {
  const dir = await fixture();
  await record(dir, { 'rtk-version': '1' });
  await save(dir);
  await gitRun(dir, ['rm', '--cached', '.haive-data/state/settings/rtk-version.json']);
  const exec = gitCommands.gitExec;
  const writes: string[][] = [];
  vi.spyOn(gitCommands, 'gitExec').mockImplementation(async (args, options) => {
    if (args[0] === 'update-index' && !options?.env?.GIT_INDEX_FILE) writes.push(args);
    return exec(args, options);
  });
  expect(await save(dir)).toMatchObject({ committed: false, indexSynced: true });
  expect(writes).toHaveLength(1);
  expect(writes[0]!.join(' ')).toContain('settings/rtk-version.json');
  expect(writes[0]!.join(' ')).not.toContain('format.json');
  expect((await gitRun(dir, ['diff', '--cached', '--name-only'])).stdout).toBe('');
});

it('refuses a previous record missing its format when a recognized file is present', async () => {
  const dir = await fixture();
  await mkdir(join(dir, '.haive-data/state/settings'), { recursive: true });
  await writeFile(join(dir, '.haive-data/state/settings/agent-rules.md'), 'owned-looking text');
  await writeFile(join(dir, '.haive-data/state/stray.txt'), 'stray');
  await gitRun(dir, ['add', '.haive-data/state']);
  await gitRun(dir, ['commit', '-qm', 'broken record'], identity);
  await rm(join(dir, '.haive-data/state/settings/agent-rules.md'));
  await record(dir);
  const before = (await gitRun(dir, ['rev-parse', 'HEAD'])).stdout;
  await expect(save(dir)).rejects.toHaveProperty('refusal.code', 'record_refused');
  expect((await gitRun(dir, ['rev-parse', 'HEAD'])).stdout).toBe(before);
});

it('bounds index warnings to the count and ten paths on a commit and an unchanged retry', async () => {
  const dir = await fixture();
  const names = Array.from({ length: 11 }, (_, i) => `named-${String(i).padStart(2, '0')}`);
  for (const name of names) await writeFile(join(dir, name), 'content');
  const exec = gitCommands.gitExec;
  vi.spyOn(gitCommands, 'gitExec').mockImplementation(async (args, options) => {
    if (args[0] === 'update-index' && !options?.env?.GIT_INDEX_FILE)
      throw new Error('index locked');
    return exec(args, options);
  });
  const waitForIndexRetry = vi.fn(async (_ms: number) => undefined);
  for (const committed of [true, false]) {
    const warnings: string[] = [];
    const files = await commitRecorded(
      dir,
      { add: names, remove: [] },
      'save',
      identity,
      warnings,
      undefined,
      { repairUnchangedIndex: true, waitForIndexRetry },
    );
    expect(files.length > 0).toBe(committed);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('11 paths:');
    for (const name of names.slice(0, 10)) expect(warnings[0]).toContain(name);
    expect(warnings[0]).not.toContain('named-10');
  }
  expect(waitForIndexRetry).toHaveBeenCalledTimes(10);
});
