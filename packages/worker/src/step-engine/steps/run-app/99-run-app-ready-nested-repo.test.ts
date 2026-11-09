import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ensureDirNoFollow, writeFileNoFollow } from '@haive/shared/fs-safe';
import { gateContext, git, repoFixture } from '../../../../test/support/nested-repo.js';
import { runAppReadyStep } from './99-run-app-ready.js';
import * as gitPush from '../../../repo/git-push.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

it('Finish refuses a new orphan gitlink before staging or pushing', async () => {
  const push = vi.spyOn(gitPush, 'pushBranch');
  const { repo, cleanup } = await repoFixture();
  cleanups.push(cleanup);
  await ensureDirNoFollow(repo, 'nested');
  await git(path.join(repo, 'nested'), ['init', '-q', '-b', 'main']);
  await writeFileNoFollow(repo, 'nested/inner.txt', 'nested\n');
  await git(path.join(repo, 'nested'), ['add', '-A']);
  await git(path.join(repo, 'nested'), ['commit', '-qm', 'nested']);
  await writeFileNoFollow(repo, 'a.txt', 'changed\n');
  const head = await git(repo, ['rev-parse', 'HEAD']);
  const index = await git(repo, ['ls-files', '-s']);
  const status = await git(repo, ['status', '--porcelain', '-z']);
  await expect(
    runAppReadyStep.apply(gateContext(repo), {
      detected: { workspacePath: repo, hasGit: true, hasOrigin: true, branch: 'main' } as never,
      formValues: { commit: true, push: true },
      iteration: 0,
      previousIterations: [],
    }),
  ).rejects.toThrow('"nested"');
  expect(push).not.toHaveBeenCalled();
  expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(head);
  expect(await git(repo, ['ls-files', '-s'])).toBe(index);
  expect(await git(repo, ['status', '--porcelain', '-z'])).toBe(status);
});
