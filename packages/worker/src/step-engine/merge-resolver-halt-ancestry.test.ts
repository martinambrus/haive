import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database, MergeResolveState } from '@haive/database';
import { claimFake, mergeDirClaimOverrides } from '../../test/merge-dir-claim-fake.js';
import { haltFailed } from './merge-resolver.js';
import type { AdvanceStepParams, TaskStepRow } from './step-runner.js';

const h = vi.hoisted(() => ({ ancestryCode: null as number | null, ancestryThrows: false }));
vi.mock('./merge-dir-claim.js', async (original) => ({
  ...(await original<typeof import('./merge-dir-claim.js')>()),
  ...mergeDirClaimOverrides(),
}));
vi.mock('./step-ownership.js', async (original) => ({
  ...(await original<typeof import('./step-ownership.js')>()),
  updateOwnedStep: async (_db: unknown, id: string, patch: unknown) => ({
    id,
    ...(patch as object),
  }),
}));
vi.mock('../repo/git-push.js', async (original) => {
  const actual = await original<typeof import('../repo/git-push.js')>();
  return {
    ...actual,
    gitRun: async (...args: Parameters<typeof actual.gitRun>) => {
      if (args[1][0] === 'merge-base') {
        if (h.ancestryThrows) {
          throw new Error('git runner failed');
        }
        if (h.ancestryCode !== null) {
          return { code: h.ancestryCode, stdout: '', stderr: '' };
        }
      }
      return actual.gitRun(...args);
    },
  };
});

const exec = promisify(execFile);
const dirs: string[] = [];
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd: dir, env: gitEnv });
  return stdout.trim();
}

beforeEach(() => {
  claimFake.reset();
  h.ancestryCode = null;
  h.ancestryThrows = false;
});
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function openMerge(foreign: boolean): Promise<MergeResolveState> {
  const dir = await mkdtemp(path.join(tmpdir(), 'halt-ancestry-'));
  dirs.push(dir);
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'gc.auto', '0']);
  await writeFile(path.join(dir, 'shared.txt'), 'root\n');
  await git(dir, ['add', 'shared.txt']);
  await git(dir, ['commit', '-m', 'root']);
  const root = await git(dir, ['rev-parse', 'HEAD']);
  await git(dir, ['switch', '-c', 'feature']);
  await writeFile(path.join(dir, 'shared.txt'), 'feature\n');
  await git(dir, ['commit', '-am', 'feature']);
  const feature = await git(dir, ['rev-parse', 'HEAD']);
  const tree = await git(dir, ['rev-parse', 'HEAD^{tree}']);
  const merged = foreign
    ? await git(dir, ['commit-tree', tree, '-p', root, '-m', 'foreign'])
    : feature;
  await git(dir, ['switch', 'main']);
  await writeFile(path.join(dir, 'shared.txt'), 'main\n');
  await git(dir, ['commit', '-am', 'main']);
  await expect(git(dir, ['merge', '--no-edit', merged])).rejects.toMatchObject({ code: 1 });
  expect(await git(dir, ['rev-parse', 'MERGE_HEAD'])).toBe(merged);
  const advanced = await git(dir, ['commit-tree', tree, '-p', feature, '-m', 'advanced']);
  await git(dir, ['update-ref', 'refs/heads/feature', advanced]);
  claimFake.claims.set(dir, { taskId: 't1', stepId: 's1', title: '' });
  return {
    mergeDir: dir,
    featureBranch: 'feature',
    phase: 'resolving',
    pushed: false,
  } as MergeResolveState;
}

async function halt(state: MergeResolveState) {
  const result = await haltFailed(
    {} as Database,
    { id: 's1' } as TaskStepRow,
    { taskId: 't1' } as AdvanceStepParams,
    state,
    'blocked',
    'fallback',
  );
  expect(result).toMatchObject({ resolved: false, result: { status: 'failed', error: 'blocked' } });
}

describe('#280 fix5 halt ownership with an advanced feature and no fix baseline', () => {
  it('keeps the claim when MERGE_HEAD is an ancestor of the advanced feature', async () => {
    const state = await openMerge(false);
    expect(state.fixBaseline).toBeUndefined();
    await halt(state);
    expect(claimFake.claims.has(state.mergeDir)).toBe(true);
    expect(claimFake.released).toEqual([]);
  });

  it('releases the claim for a foreign MERGE_HEAD outside the feature ancestry', async () => {
    const state = await openMerge(true);
    await halt(state);
    expect(claimFake.claims.has(state.mergeDir)).toBe(false);
    expect(claimFake.released).toEqual([{ mergeDir: state.mergeDir, inSection: true }]);
  });

  it.each([128, 129])('keeps the claim when ancestry exits with %s', async (code) => {
    const state = await openMerge(false);
    h.ancestryCode = code;
    await halt(state);
    expect(claimFake.claims.has(state.mergeDir)).toBe(true);
    expect(claimFake.released).toEqual([]);
  });

  it('keeps the claim and records the halt when the ancestry runner throws', async () => {
    const state = await openMerge(false);
    h.ancestryThrows = true;
    await halt(state);
    expect(claimFake.claims.has(state.mergeDir)).toBe(true);
    expect(claimFake.released).toEqual([]);
  });
});
