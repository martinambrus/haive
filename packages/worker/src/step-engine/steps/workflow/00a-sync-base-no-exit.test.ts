import { fixtureBase, networkGitArgs, httpOrigin } from '../../../../test/support/git-http.js';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { StepContext } from '../../step-definition.js';
import { syncBaseStep } from './00a-sync-base.js';
import { killGit, type KilledGit } from '../../../../test/support/kill-git.js';

const exec = promisify(execFile);
const tmpDirs: string[] = [];
let shim: KilledGit | null = null;
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

async function git(cwd: string, args: string[]): Promise<void> {
  args = networkGitArgs(args);
  await exec('git', ['-c', 'gc.auto=0', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@haive.local',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@haive.local',
    },
  });
}

async function mkTmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(fixtureBase, prefix));
  tmpDirs.push(dir);
  return dir;
}

async function makeRepo(withOrigin: boolean): Promise<string> {
  const dir = await mkTmp('sync-base-noexit-');
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'gc.auto', '0']);
  await writeFile(path.join(dir, 'a.txt'), '1\n', 'utf8');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', 'c1']);
  if (withOrigin) {
    const bare = await mkTmp('sync-base-noexit-bare-');
    await git(bare, ['init', '--bare', '-b', 'main']);
    await git(dir, ['remote', 'add', 'origin', httpOrigin(bare)]);
    await git(dir, ['push', 'origin', 'main']);
  }
  return dir;
}

function mkCtx(repoPath: string): StepContext {
  return {
    repoPath,
    userId: 'u1',
    taskId: 't1',
    taskStepId: 'step1',
    db: { query: { tasks: { findFirst: async () => ({ repositoryId: null }) } } },
    logger,
  } as unknown as StepContext;
}

afterEach(async () => {
  await shim?.restore();
  shim = null;
  while (tmpDirs.length) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('00a-sync-base detect: the current branch read', () => {
  it('rejects when the branch read ends with no exit status', async () => {
    const dir = await makeRepo(true);
    shim = await killGit(['rev-parse', '--abbrev-ref', 'HEAD']);
    await expect(syncBaseStep.detect!(mkCtx(dir))).rejects.toThrow(
      /could not read the checkout's current branch/,
    );
  });

  it('still resolves on an unborn HEAD', async () => {
    const dir = await mkTmp('sync-base-unborn-');
    await git(dir, ['init', '-b', 'main']);
    const detected = await syncBaseStep.detect!(mkCtx(dir));
    expect(detected).toMatchObject({ baseBranch: null });
  });
});
