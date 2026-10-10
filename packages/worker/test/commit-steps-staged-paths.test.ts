import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { StepContext } from '../src/step-engine/step-definition.js';
import { postOnboardingStep } from '../src/step-engine/steps/onboarding/12-post-onboarding.js';
import { upgradeCommitStep } from '../src/step-engine/steps/onboarding-upgrade/03-upgrade-commit.js';

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd: dir, env: GIT_ENV });
  return stdout.toString();
}

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function repoWithAgents(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), 'commit-staged-'));
  dirs.push(repo);
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'gc.auto', '0']);
  await mkdir(path.join(repo, '.claude', 'agents'), { recursive: true });
  await writeFile(path.join(repo, '.claude', 'agents', 'old name.md'), '1\n');
  await writeFile(path.join(repo, 'README.md'), 'r\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'seed']);
  await git(repo, ['mv', '.claude/agents/old name.md', '.claude/agents/new name.md']);
  await writeFile(path.join(repo, '.claude', 'agents', 'é.md'), '2\n');
  await writeFile(path.join(repo, '.claude', 'agents', 'q"uote.md'), '3\n');
  return repo;
}

function mkCtx(repo: string): StepContext {
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => [],
    then: (resolve: (v: unknown) => unknown) => resolve([]),
  });
  const table = { findFirst: async () => undefined, findMany: async () => [] };
  return {
    repoPath: repo,
    workspacePath: repo,
    userId: 'u1',
    taskId: 't1',
    taskStepId: 's1',
    logger,
    db: { select: () => chain, query: new Proxy({}, { get: () => table }) },
  } as unknown as StepContext;
}

const EXPECTED = ['.claude/agents/new name.md', '.claude/agents/q"uote.md', '.claude/agents/é.md'];

describe('commit steps report the staged paths by their real names', () => {
  it('12-post-onboarding', async () => {
    const repo = await repoWithAgents();
    const out = await postOnboardingStep.apply(mkCtx(repo), {
      detected: { hasGit: true, currentBranch: 'main' } as never,
      formValues: { commit: true, commitMessage: 'chore: onboard' },
      iteration: 0,
      previousIterations: [],
    });
    expect(out.commitPerformed).toBe(true);
    expect(out.stagedPaths.filter((p) => p.startsWith('.claude/')).sort()).toEqual(EXPECTED);
  });

  it('03-upgrade-commit', async () => {
    const repo = await repoWithAgents();
    const out = await upgradeCommitStep.apply(mkCtx(repo), {
      detected: { hasGit: true } as never,
      formValues: { commit: true, commitMessage: 'chore: upgrade' },
      iteration: 0,
      previousIterations: [],
    });
    expect(out.commitPerformed).toBe(true);
    expect(out.stagedPaths.filter((p) => p.startsWith('.claude/')).sort()).toEqual(EXPECTED);
  });
});
