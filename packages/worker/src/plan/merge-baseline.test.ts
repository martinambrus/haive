import { fixtureBase, networkGitArgs } from '../../test/support/git-http.js';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import { failGit, type FakeGit } from '../../test/support/fake-git.js';
import { moveAsideRecordedLeftovers } from './merge-baseline.js';
import { divergence, ensurePlanMergeWorktree, mergeOriginInto } from './merge.js';

const exec = promisify(execFile);
const IDENTITY = {
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};

async function git(dir: string, args: string[]): Promise<string> {
  args = networkGitArgs(args);
  const { stdout } = await exec('git', args, { cwd: dir, env: { ...process.env, ...IDENTITY } });
  return stdout.toString();
}

const dirs: string[] = [];
let shim: FakeGit | null = null;
afterEach(async () => {
  await shim?.restore();
  shim = null;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function scratchWorktree(): Promise<{ local: string; wt: string }> {
  const remote = await mkdtemp(path.join(fixtureBase, 'planbaseline-remote-'));
  const local = await mkdtemp(path.join(fixtureBase, 'planbaseline-local-'));
  dirs.push(remote, local);
  for (const [dir, readme] of [
    [remote, '# from the forge\n'],
    [local, '# from Haive\n'],
  ] as const) {
    await git(dir, ['init', '-b', 'main']);
    await git(dir, ['config', 'gc.auto', '0']);
    await writeFile(path.join(dir, 'README.md'), readme, 'utf8');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'initial']);
  }
  await git(local, ['remote', 'add', 'origin', remote]);
  await git(local, ['fetch', 'origin', 'main']);
  return { local, wt: await ensurePlanMergeWorktree(local) };
}

describe('moveAsideRecordedLeftovers on a failed MERGE_HEAD read', () => {
  it('rejects instead of reading it as no open merge', async () => {
    const { local, wt } = await scratchWorktree();
    await mergeOriginInto(wt, 'main', (await divergence(local, 'main')).unrelated, IDENTITY);
    await git(wt, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
    shim = await failGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
    await expect(
      moveAsideRecordedLeftovers({} as Database, 'r1', wt, 'origin/main'),
    ).rejects.toThrow(/^git rev-parse MERGE_HEAD failed in /);
  });

  it('D7 resolves when the scratch worktree directory is gone', async () => {
    const db = new Proxy(
      {},
      {
        get: () => {
          throw new Error('db touched');
        },
      },
    ) as Database;
    const { wt } = await scratchWorktree();
    await rm(wt, { recursive: true, force: true });
    await expect(moveAsideRecordedLeftovers(db, 'r1', wt, 'origin/main')).resolves.toBeUndefined();
  });

  it('resolves without touching the db when no merge is open', async () => {
    const { wt } = await scratchWorktree();
    const db = new Proxy(
      {},
      {
        get: () => {
          throw new Error('db touched');
        },
      },
    ) as Database;
    await expect(moveAsideRecordedLeftovers(db, 'r1', wt, 'origin/main')).resolves.toBeUndefined();
  });
});
