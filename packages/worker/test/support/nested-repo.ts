import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { removeNoFollow, writeFileNoFollow } from '@haive/shared/fs-safe';
import { gitExec } from '../../src/repo/git-exec.js';
import type { StepContext } from '../../src/step-engine/step-definition.js';

export const identity = {
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};

export async function git(repo: string, args: string[]): Promise<string> {
  return (await gitExec(args, { cwd: repo, env: identity })).stdout;
}

export async function repoFixture() {
  const repo = await mkdtemp(path.join(tmpdir(), 'nested-repo-'));
  await git(repo, ['init', '-q', '-b', 'main']);
  await writeFileNoFollow(repo, '.git/info/exclude', '.haive/\n');
  await writeFileNoFollow(repo, 'a.txt', 'before\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'seed']);
  return {
    repo,
    cleanup: () => removeNoFollow(tmpdir(), path.basename(repo), { recursive: true }),
  };
}

export function gateContext(repo: string): StepContext {
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => [],
    then: (resolve: (v: unknown) => unknown) => Promise.resolve([]).then(resolve),
  });
  return {
    repoPath: repo,
    workspacePath: repo,
    sandboxWorkdir: repo,
    userId: 'u1',
    taskId: 't1',
    taskStepId: 'step1',
    db: {
      select: () => chain,
      query: {
        tasks: { findFirst: async () => ({ repositoryId: null, changedPaths: [] }) },
        users: { findFirst: async () => undefined },
      },
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as StepContext;
}
