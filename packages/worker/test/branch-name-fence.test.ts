import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syncBaseStep } from '../src/step-engine/steps/workflow/00a-sync-base.js';
import { worktreeSetupStep } from '../src/step-engine/steps/workflow/01-worktree-setup.js';
import type { StepContext } from '../src/step-engine/step-definition.js';

const run = promisify(execFile);
const git = async (dir: string, ...args: string[]): Promise<string> =>
  (await run('git', ['-C', dir, ...args])).stdout.trim();

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const db = {
  query: {
    tasks: { findFirst: async () => ({ repositoryId: null }) },
    repositories: { findFirst: async () => null },
  },
};
const ctxFor = (repoPath: string) =>
  ({ db, repoPath, taskId: 't1', userId: 'u1', logger }) as never as StepContext;

async function commit(dir: string, file: string, text: string): Promise<void> {
  await writeFile(join(dir, file), text);
  await git(dir, 'add', file);
  await git(dir, 'commit', '-q', '-m', text);
}

describe('a branch name a person types reaches git as a branch, never as an option', () => {
  let root: string;
  let upstream: string;
  let work: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'haive-branch-fence-'));
    upstream = join(root, 'upstream');
    work = join(root, 'work');
    await run('git', ['init', '-q', '-b', 'main', upstream]);
    for (const [k, v] of [
      ['user.email', 't@example.com'],
      ['user.name', 'T'],
      ['gc.auto', '0'],
    ]) {
      await git(upstream, 'config', k!, v!);
    }
    await commit(upstream, 'a.txt', 'one');
    await git(upstream, 'branch', 'feature');
    await git(upstream, 'branch', '+topic');
    await git(upstream, 'branch', 'topic');
    await run('git', ['clone', '-q', upstream, work]);
    await git(work, 'config', 'gc.auto', '0');
    await git(work, 'branch', 'feature', 'origin/feature');
    await git(work, 'branch', '+topic', 'origin/+topic');
    // Upstream moves on: feature and +topic each gain a commit, and topic gains a different one.
    await git(upstream, 'checkout', '-q', 'feature');
    await commit(upstream, 'f.txt', 'feature two');
    await git(upstream, 'checkout', '-q', '+topic');
    await commit(upstream, 'p.txt', 'plus topic two');
    await git(upstream, 'checkout', '-q', 'topic');
    await commit(upstream, 't.txt', 'topic two');
    await git(upstream, 'checkout', '-q', 'main');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const detected = {
    hasGit: true,
    currentBranch: 'main',
    baseBranch: 'main',
    branchName: 'origin/main',
    hasOrigin: true,
    fetchOk: true,
    fetchError: null,
    behindBy: 0,
    aheadBy: 0,
    diverged: false,
  };

  it('refuses a base shaped like an option before any git runs', async () => {
    await expect(
      syncBaseStep.apply!(ctxFor(work), {
        detected,
        formValues: { base: '--upload-pack=x' },
      } as never),
    ).rejects.toThrow(/is not a branch name git accepts/);
  });

  it('fast-forwards a named base through the fenced fetch', async () => {
    const out = await syncBaseStep.apply!(ctxFor(work), {
      detected,
      formValues: { base: 'feature' },
    } as never);
    expect(out).toMatchObject({ synced: true, strategy: 'ff' });
    expect(await git(work, 'rev-parse', 'feature')).toBe(
      await git(upstream, 'rev-parse', 'feature'),
    );
  });

  it('fetches a branch named +topic as itself, never as a forced fetch of topic', async () => {
    const out = await syncBaseStep.apply!(ctxFor(work), {
      detected,
      formValues: { base: '+topic' },
    } as never);
    expect(out).toMatchObject({ synced: true, strategy: 'ff' });
    expect(await git(work, 'rev-parse', 'refs/heads/+topic')).toBe(
      await git(upstream, 'rev-parse', 'refs/heads/+topic'),
    );
  });

  it('still counts the commits the base is behind after its fetch', async () => {
    await commit(upstream, 'm.txt', 'main two');
    const out = await syncBaseStep.detect!(ctxFor(work));
    expect(out).toMatchObject({ baseBranch: 'main', fetchOk: true, behindBy: 1 });
  });

  it('refuses a base 01 would hand to git that is not a branch name', async () => {
    for (const [syncedBase, baseBranch] of [
      ['--upload-pack=x', undefined],
      [null, '-x'],
    ] as const) {
      await expect(
        worktreeSetupStep.apply!(ctxFor(work), {
          detected: { hasGit: true, syncedBase, currentBranch: 'main' },
          formValues: { branchName: 'feat', baseBranch },
        } as never),
      ).rejects.toThrow(/is not a branch name git accepts/);
    }
  });
});
