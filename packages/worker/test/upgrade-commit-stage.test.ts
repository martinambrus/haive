import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appliedImportStubs,
  appliedWrittenPaths,
  headLacksImport,
  upgradeCommitStep,
} from '../src/step-engine/steps/onboarding-upgrade/03-upgrade-commit.js';
import type { StepContext } from '../src/step-engine/step-definition.js';

const run = promisify(execFile);

describe('appliedWrittenPaths', () => {
  it('stages the repository paths 02 reports writing', () => {
    expect(
      appliedWrittenPaths({ writtenPaths: ['AGENTS.md', 'CLAUDE.md', '.claude/x.md'] }),
    ).toEqual(['AGENTS.md', 'CLAUDE.md', '.claude/x.md']);
  });

  it('drops anything that is not a path inside the repository', () => {
    expect(
      appliedWrittenPaths({ writtenPaths: ['../escape.md', '/etc/passwd', '', 42, 'AGENTS.md'] }),
    ).toEqual(['AGENTS.md']);
  });

  it('reads nothing from an output persisted before the field existed', () => {
    expect(appliedWrittenPaths({ appliedCount: 1 })).toEqual([]);
    expect(appliedWrittenPaths(null)).toEqual([]);
  });
});

describe('appliedImportStubs', () => {
  it('keeps every stub left delivering AGENTS.md, including one 02 did not have to write', () => {
    expect(
      appliedImportStubs({
        rulesImportStubs: [
          { file: 'CLAUDE.md', result: 'unchanged' },
          { file: 'GEMINI.md', result: 'created' },
          { file: 'x/CLAUDE.md', result: 'appended' },
          { file: 'y/CLAUDE.md', result: 'skipped-link' },
        ],
      }),
    ).toEqual([
      { file: 'CLAUDE.md', link: false },
      { file: 'GEMINI.md', link: false },
      { file: 'x/CLAUDE.md', link: false },
      { file: 'y/CLAUDE.md', link: true },
    ]);
  });

  it('skips a refused stub', () => {
    expect(
      appliedImportStubs({ rulesImportStubs: [{ file: 'CLAUDE.md', result: 'refused' }] }),
    ).toEqual([]);
  });

  it('drops malformed entries and paths outside the repository', () => {
    expect(
      appliedImportStubs({
        rulesImportStubs: [
          null,
          { file: 7, result: 'created' },
          { file: '../CLAUDE.md', result: 'created' },
          { file: 'CLAUDE.md' },
        ],
      }),
    ).toEqual([]);
  });

  it('reads nothing from an output persisted before the field existed', () => {
    expect(appliedImportStubs({ writtenPaths: ['CLAUDE.md'] })).toEqual([]);
    expect(appliedImportStubs(null)).toEqual([]);
  });
});

describe('headLacksImport', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'haive-upgrade-commit-'));
    await run('git', ['-C', repo, 'init', '-q']);
    await run('git', ['-C', repo, 'config', 'user.email', 't@example.com']);
    await run('git', ['-C', repo, 'config', 'user.name', 'T']);
    await run('git', ['-C', repo, 'config', 'gc.auto', '0']);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const commit = async (name: string, body: string): Promise<void> => {
    await writeFile(join(repo, name), body);
    await run('git', ['-C', repo, 'add', '--', name]);
    await run('git', ['-C', repo, 'commit', '-qm', name]);
  };

  it('is true before the first commit', async () => {
    await writeFile(join(repo, 'CLAUDE.md'), '@AGENTS.md\n');
    expect(await headLacksImport(repo, 'CLAUDE.md')).toBe(true);
  });

  it('is true for a stub on disk that was never committed', async () => {
    await commit('README.md', 'hi\n');
    await writeFile(join(repo, 'CLAUDE.md'), '@AGENTS.md\n');
    expect(await headLacksImport(repo, 'CLAUDE.md')).toBe(true);
  });

  it('is true when the committed copy lacks the line, however the working copy looks', async () => {
    await commit('CLAUDE.md', '# Notes\n');
    await writeFile(join(repo, 'CLAUDE.md'), '# Notes\n@AGENTS.md\n');
    expect(await headLacksImport(repo, 'CLAUDE.md')).toBe(true);
  });

  it('is false once HEAD carries the line, so a clean stub is never re-staged', async () => {
    await commit('CLAUDE.md', '# Notes\n@AGENTS.md\n');
    await writeFile(join(repo, 'CLAUDE.md'), '# Notes, edited\n@AGENTS.md\n');
    expect(await headLacksImport(repo, 'CLAUDE.md')).toBe(false);
  });

  it('reads a committed file larger than a child-process output buffer', async () => {
    await commit('CLAUDE.md', `${'x'.repeat(2 * 1024 * 1024)}\n@AGENTS.md\n`);
    expect(await headLacksImport(repo, 'CLAUDE.md')).toBe(false);
  });
});

describe('03 apply stages the rules delivery HEAD lacks', () => {
  let repo: string;
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

  /** 02's persisted output, no providers, no git identity: the fallback one commits. */
  const fakeDb = (applyOutput: unknown) => {
    const rows = [{ detectOutput: null, output: applyOutput, iterations: [] }];
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: async () => rows,
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

  const applyWith = (applyOutput: unknown) =>
    upgradeCommitStep.apply(
      {
        db: fakeDb(applyOutput),
        repoPath: repo,
        taskId: 't1',
        userId: 'u1',
        logger,
      } as never as StepContext,
      {
        detected: { hasGit: true },
        formValues: { commit: true, commitMessage: 'upgrade' },
      } as never,
    );

  const headTree = async (): Promise<string> =>
    (await run('git', ['-C', repo, 'ls-tree', 'HEAD'])).stdout;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'haive-upgrade-apply-'));
    await run('git', ['-C', repo, 'init', '-q']);
    await run('git', ['-C', repo, 'config', 'user.email', 't@example.com']);
    await run('git', ['-C', repo, 'config', 'user.name', 'T']);
    await run('git', ['-C', repo, 'config', 'gc.auto', '0']);
    await writeFile(join(repo, 'AGENTS.md'), '# Agents\n');
    await run('git', ['-C', repo, 'add', 'AGENTS.md']);
    await run('git', ['-C', repo, 'commit', '-qm', 'seed']);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('commits a stub 02 found already on disk but that was never committed', async () => {
    await writeFile(join(repo, 'CLAUDE.md'), '@AGENTS.md\n');
    const out = await applyWith({ rulesImportStubs: [{ file: 'CLAUDE.md', result: 'unchanged' }] });
    expect(out.commitPerformed).toBe(true);
    expect(await headTree()).toMatch(/100644 blob \w+\tCLAUDE\.md/);
  });

  it('commits a link to AGENTS.md as a link', async () => {
    await symlink('AGENTS.md', join(repo, 'CLAUDE.md'));
    const out = await applyWith({
      rulesImportStubs: [{ file: 'CLAUDE.md', result: 'skipped-link' }],
    });
    expect(out.commitPerformed).toBe(true);
    expect(await headTree()).toMatch(/120000 blob \w+\tCLAUDE\.md/);
  });

  it('leaves a committed stub and the edits beside it alone', async () => {
    await writeFile(join(repo, 'CLAUDE.md'), '# Notes\n@AGENTS.md\n');
    await run('git', ['-C', repo, 'add', 'CLAUDE.md']);
    await run('git', ['-C', repo, 'commit', '-qm', 'stub']);
    await writeFile(join(repo, 'CLAUDE.md'), '# Notes, unfinished edit\n@AGENTS.md\n');
    const out = await applyWith({ rulesImportStubs: [{ file: 'CLAUDE.md', result: 'unchanged' }] });
    expect(out.commitPerformed).toBe(false);
    expect((await run('git', ['-C', repo, 'status', '--porcelain'])).stdout).toContain(
      ' M CLAUDE.md',
    );
  });
});
