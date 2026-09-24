import { execFile } from 'node:child_process';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { postOnboardingStep } from '../src/step-engine/steps/onboarding/12-post-onboarding.js';
import type { StepContext } from '../src/step-engine/step-definition.js';

const run = promisify(execFile);

describe('12 apply keeps rules files git ignores out of the commit', () => {
  let repo: string;
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

  /** No 07 output, no repository row, no providers, no identity: straight to the commit. */
  const fakeDb = () => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: async () => [],
    });
    return {
      select: () => chain,
      query: {
        cliProviders: { findMany: async () => [] },
        tasks: { findFirst: async () => null },
        users: { findFirst: async () => null },
      },
    };
  };

  const apply = () =>
    postOnboardingStep.apply(
      { db: fakeDb(), repoPath: repo, taskId: 't1', userId: 'u1', logger } as never as StepContext,
      {
        detected: { hasGit: true, currentBranch: 'main' },
        formValues: { commit: true, commitMessage: 'onboard' },
      } as never,
    );

  const headTree = async (): Promise<string> =>
    (await run('git', ['-C', repo, 'ls-tree', '--name-only', 'HEAD'])).stdout;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'haive-post-onboarding-'));
    await run('git', ['-C', repo, 'init', '-q']);
    await run('git', ['-C', repo, 'config', 'user.email', 't@example.com']);
    await run('git', ['-C', repo, 'config', 'user.name', 'T']);
    await run('git', ['-C', repo, 'config', 'gc.auto', '0']);
    await writeFile(join(repo, 'README.md'), 'hi\n');
    await run('git', ['-C', repo, 'add', 'README.md']);
    await run('git', ['-C', repo, 'commit', '-qm', 'seed']);
    await appendFile(join(repo, '.git', 'info', 'exclude'), 'CLAUDE.md\n');
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('commits the rest and says which it left out', async () => {
    await writeFile(join(repo, 'AGENTS.md'), '# Agents\n');
    await writeFile(join(repo, 'CLAUDE.md'), '@AGENTS.md\n');
    const out = await apply();
    expect(out.commitPerformed).toBe(true);
    const tree = await headTree();
    expect(tree).toContain('AGENTS.md');
    expect(tree).not.toContain('CLAUDE.md');
    expect(out.warnings.join('\n')).toContain('CLAUDE.md is ignored by git');
  });

  it('forces nothing in when an ignored rules file is all there is to stage', async () => {
    await writeFile(join(repo, 'CLAUDE.md'), '@AGENTS.md\n');
    const out = await apply();
    expect(out.commitPerformed).toBe(false);
    expect(await headTree()).not.toContain('CLAUDE.md');
    expect(out.warnings.join('\n')).toContain('CLAUDE.md is ignored by git');
  });
});
