import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { schema } from '@haive/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { postOnboardingStep } from '../src/step-engine/steps/onboarding/12-post-onboarding.js';
import type { StepContext } from '../src/step-engine/step-definition.js';

const run = promisify(execFile);

describe('12 apply stages what it owns, and nothing git ignores', () => {
  let repo: string;
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

  /** No 07 output, no repository row, no providers, no identity: straight to the commit. The
   *  task's repository and its live artifact rows are the ones given. */
  const fakeDb = (repositoryId: string | null = null, artifactPaths: string[] = []) => {
    const rowsFor = (table: unknown): unknown[] => {
      if (table === schema.tasks) return repositoryId ? [{ repositoryId }] : [];
      if (table === schema.onboardingArtifacts)
        return artifactPaths.map((diskPath) => ({ diskPath }));
      return [];
    };
    const select = () => {
      let table: unknown;
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        from: (t: unknown) => {
          table = t;
          return chain;
        },
        where: () => chain,
        orderBy: () => chain,
        limit: async () => rowsFor(table),
        then: (resolve: (rows: unknown[]) => unknown, reject: (err: unknown) => unknown) =>
          Promise.resolve(rowsFor(table)).then(resolve, reject),
      });
      return chain;
    };
    return {
      select,
      query: {
        cliProviders: { findMany: async () => [] },
        tasks: { findFirst: async () => null },
        users: { findFirst: async () => null },
      },
    };
  };

  const apply = (db = fakeDb()) =>
    postOnboardingStep.apply(
      { db, repoPath: repo, taskId: 't1', userId: 'u1', logger } as never as StepContext,
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

  const writeSettings = async (rel: string): Promise<void> => {
    await mkdir(join(repo, dirname(rel)), { recursive: true });
    await writeFile(join(repo, rel), '{ "theme": "mine" }\n');
  };

  it('leaves a settings file no artifact row records out of the commit', async () => {
    await writeFile(join(repo, 'AGENTS.md'), '# Agents\n');
    await writeSettings('.gemini/settings.json');
    await writeSettings('.claude/settings.json');
    const out = await apply(fakeDb('r1', []));
    expect(out.commitPerformed).toBe(true);
    const tree = await headTree();
    expect(tree).toContain('AGENTS.md');
    expect(tree).not.toContain('.gemini');
    expect(tree).not.toContain('.claude');
  });

  it('keeps a recorded settings file the repository ignores out of the commit, and says so', async () => {
    await appendFile(
      join(repo, '.git', 'info', 'exclude'),
      '.claude/settings.json\n.gemini/settings.json\n',
    );
    await writeFile(join(repo, 'AGENTS.md'), '# Agents\n');
    await writeSettings('.claude/settings.json');
    await writeSettings('.gemini/settings.json');
    const out = await apply(fakeDb('r1', ['.claude/settings.json', '.gemini/settings.json']));
    expect(out.commitPerformed).toBe(true);
    const tree = await headTree();
    expect(tree).toContain('AGENTS.md');
    expect(tree).not.toContain('.claude');
    expect(tree).not.toContain('.gemini');
    const warnings = out.warnings.join('\n');
    expect(warnings).toContain('.claude/settings.json is ignored by git');
    expect(warnings).toContain('.gemini/settings.json is ignored by git');
  });
});
