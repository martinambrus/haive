import { networkGitArgs, httpOrigin } from '../../../../test/support/git-http.js';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StepContext } from '../../step-definition.js';
import { killGit, type KilledGit } from '../../../../test/support/kill-git.js';

vi.mock('./_helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_helpers.js')>()),
  loadPreviousStepOutput: async () => ({
    output: { pushRequested: true, pushCredentialId: null, pushSetUpstream: true, branch: 'main' },
  }),
}));

import { onboardingPushStep } from './13-onboarding-push.js';

const exec = promisify(execFile);
const tmpDirs: string[] = [];
let shim: KilledGit | null = null;

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
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

async function makeRepo(): Promise<string> {
  const dir = await mkTmp('onb-push-repo-');
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'gc.auto', '0']);
  await writeFile(path.join(dir, 'a.txt'), '1\n', 'utf8');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', 'c1']);
  return dir;
}

async function addBareOrigin(dir: string): Promise<string> {
  const bare = await mkTmp('onb-push-bare-');
  await git(bare, ['init', '--bare', '-b', 'main']);
  const url = httpOrigin(bare);
  await git(dir, ['remote', 'add', 'origin', url]);
  await git(dir, ['push', 'origin', 'main']);
  return url;
}

function mkCtx(repoPath: string): StepContext {
  const noop = (): void => undefined;
  return {
    repoPath,
    userId: 'u1',
    taskId: 't1',
    taskStepId: 'step1',
    db: {},
    logger: { info: noop, warn: noop, error: noop, debug: noop },
  } as unknown as StepContext;
}

afterEach(async () => {
  await shim?.restore();
  shim = null;
  while (tmpDirs.length) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('13-onboarding-push detect', () => {
  it('rejects when git cannot read the origin, instead of reporting nothing to push', async () => {
    const dir = await makeRepo();
    await addBareOrigin(dir);
    // A bad fetch refspec makes `git remote get-url origin` exit 128 while rev-parse still works.
    await git(dir, ['config', '--add', 'remote.origin.fetch', ':::bad']);
    await expect(onboardingPushStep.detect!(mkCtx(dir))).rejects.toThrow(
      /git remote get-url origin failed in /,
    );
  });

  it('is not ready for a checkout with no origin', async () => {
    const dir = await makeRepo();
    const detected = await onboardingPushStep.detect!(mkCtx(dir));
    expect(detected).toMatchObject({ ready: false, hasOrigin: false, originUrl: null });
  });

  it('is ready against a readable origin', async () => {
    const dir = await makeRepo();
    const url = await addBareOrigin(dir);
    const detected = await onboardingPushStep.detect!(mkCtx(dir));
    expect(detected).toMatchObject({
      ready: true,
      hasOrigin: true,
      originUrl: url,
      baseBranch: 'main',
    });
  });

  it('rejects when the branch read ends with no exit status', async () => {
    const dir = await makeRepo();
    await addBareOrigin(dir);
    shim = await killGit(['rev-parse', '--abbrev-ref', 'HEAD']);
    await expect(onboardingPushStep.detect!(mkCtx(dir))).rejects.toThrow(
      /could not read the checkout's current branch/,
    );
  });

  it('is not ready on an unborn HEAD', async () => {
    const dir = await mkTmp('onb-push-unborn-');
    await git(dir, ['init', '-b', 'main']);
    const detected = await onboardingPushStep.detect!(mkCtx(dir));
    expect(detected).toMatchObject({ ready: false });
  });

  it('counts commits behind and ahead of origin', async () => {
    const dir = await makeRepo();
    await addBareOrigin(dir);
    await writeFile(path.join(dir, 'b.txt'), '2\n', 'utf8');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'c2']);
    const detected = await onboardingPushStep.detect!(mkCtx(dir));
    expect(detected).toMatchObject({ behindBy: 0, aheadBy: 1 });
  });

  it('rejects when a commit count ends with no exit status', async () => {
    const dir = await makeRepo();
    await addBareOrigin(dir);
    shim = await killGit(['rev-list', '--count']);
    await expect(onboardingPushStep.detect!(mkCtx(dir))).rejects.toThrow(
      /git rev-list --count .* failed in /,
    );
  });
});
