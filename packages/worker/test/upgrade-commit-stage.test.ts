import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentsRulesVerdict,
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

const RULES = (body: string) =>
  `# Project\n\n<!-- haive:cli-rules -->\n${body}\n<!-- /haive:cli-rules -->\n`;

describe('agentsRulesVerdict', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'haive-agents-verdict-'));
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

  it('stages a rules block when there is no HEAD, or HEAD has no AGENTS.md', async () => {
    await writeFile(join(repo, 'AGENTS.md'), RULES('- rule one'));
    expect(await agentsRulesVerdict(repo)).toEqual({ verdict: 'stage' });
    await commit('README.md', 'hi\n');
    expect(await agentsRulesVerdict(repo)).toEqual({ verdict: 'stage' });
  });

  it('stages a block that differs from HEAD, or that HEAD lacks', async () => {
    await commit('AGENTS.md', RULES('- rule one'));
    await writeFile(join(repo, 'AGENTS.md'), RULES('- rule two'));
    expect(await agentsRulesVerdict(repo)).toEqual({ verdict: 'stage' });
    await commit('AGENTS.md', '# Project\n');
    await writeFile(join(repo, 'AGENTS.md'), RULES('- rule one'));
    expect(await agentsRulesVerdict(repo)).toEqual({ verdict: 'stage' });
  });

  it('leaves the file alone when only lines outside the block changed', async () => {
    await commit('AGENTS.md', RULES('- rule one'));
    await writeFile(join(repo, 'AGENTS.md'), `${RULES('- rule one')}\nA note of my own.\n`);
    expect(await agentsRulesVerdict(repo)).toEqual({ verdict: 'current' });
  });

  it('has nothing to stage without a block on disk', async () => {
    await commit('README.md', 'hi\n');
    await writeFile(join(repo, 'AGENTS.md'), '# Project\n');
    expect(await agentsRulesVerdict(repo)).toEqual({ verdict: 'current' });
  });

  it('stages a regular file over a link HEAD holds', async () => {
    await writeFile(join(repo, 'OTHER.md'), RULES('- rule one'));
    await symlink('OTHER.md', join(repo, 'AGENTS.md'));
    await run('git', ['-C', repo, 'add', '--', 'OTHER.md', 'AGENTS.md']);
    await run('git', ['-C', repo, 'commit', '-qm', 'link']);
    await rm(join(repo, 'AGENTS.md'));
    await writeFile(join(repo, 'AGENTS.md'), RULES('- rule one'));
    expect(await agentsRulesVerdict(repo)).toEqual({ verdict: 'stage' });
  });

  it('cannot tell through a link on disk, and says why', async () => {
    await writeFile(join(repo, 'OTHER.md'), RULES('- rule one'));
    await symlink('OTHER.md', join(repo, 'AGENTS.md'));
    expect((await agentsRulesVerdict(repo)).verdict).toBe('unknown');
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

  it('keeps a rules file the repository ignores out of the commit, and says so', async () => {
    await writeFile(join(repo, '.gitignore'), 'CLAUDE.md\n');
    await run('git', ['-C', repo, 'add', '.gitignore']);
    await run('git', ['-C', repo, 'commit', '-qm', 'ignore']);
    await writeFile(join(repo, 'CLAUDE.md'), '# private\n@AGENTS.md\n');
    for (const result of ['unchanged', 'created'] as const) {
      const out = await applyWith({
        writtenPaths: result === 'created' ? ['CLAUDE.md'] : [],
        rulesImportStubs: [{ file: 'CLAUDE.md', result }],
      });
      expect(out.commitPerformed).toBe(false);
      expect(out.warnings.join('\n')).toContain('CLAUDE.md is ignored by git');
    }
    expect(await headTree()).not.toContain('CLAUDE.md');
  });

  it('keeps out an ignored rules file of a provider no longer enabled, which the RTK strip wrote', async () => {
    await writeFile(join(repo, '.gitignore'), 'GEMINI.md\n');
    await run('git', ['-C', repo, 'add', '.gitignore']);
    await run('git', ['-C', repo, 'commit', '-qm', 'ignore']);
    await writeFile(join(repo, 'GEMINI.md'), '# private\n');
    const out = await applyWith({ writtenPaths: ['GEMINI.md'] });
    expect(out.commitPerformed).toBe(false);
    expect(out.warnings.join('\n')).toContain('GEMINI.md is ignored by git');
    expect(await headTree()).not.toContain('GEMINI.md');
  });

  it('commits the removal of a file 02 deleted, and skips a path git never tracked', async () => {
    await mkdir(join(repo, '.claude'), { recursive: true });
    await writeFile(join(repo, '.claude', 'settings.json'), '{}\n');
    await run('git', ['-C', repo, 'add', '.claude/settings.json']);
    await run('git', ['-C', repo, 'commit', '-qm', 'rtk hook']);
    await rm(join(repo, '.claude', 'settings.json'));
    const out = await applyWith({
      writtenPaths: [],
      deletedPaths: ['.claude/settings.json', '.gemini/settings.json'],
    });
    expect(out.commitPerformed).toBe(true);
    expect(await headTree()).not.toContain('.claude');
  });

  it('commits an AGENTS.md whose rules block HEAD lacks', async () => {
    await writeFile(join(repo, 'AGENTS.md'), RULES('- rule one'));
    const out = await applyWith({ writtenPaths: [] });
    expect(out.commitPerformed).toBe(true);
    const head = (await run('git', ['-C', repo, 'show', 'HEAD:AGENTS.md'])).stdout;
    expect(head).toContain('- rule one');
  });

  it('keeps an AGENTS.md the repository ignores out of the commit, whatever route named it', async () => {
    await writeFile(join(repo, '.gitignore'), 'AGENTS.md\n');
    await run('git', ['-C', repo, 'rm', '-q', '--cached', 'AGENTS.md']);
    await run('git', ['-C', repo, 'add', '.gitignore']);
    await run('git', ['-C', repo, 'commit', '-qm', 'ignore']);
    await writeFile(join(repo, 'AGENTS.md'), RULES('- rule one'));
    const out = await applyWith({ writtenPaths: ['AGENTS.md'] });
    expect(out.commitPerformed).toBe(false);
    expect(out.warnings.join('\n')).toContain('AGENTS.md is ignored by git');
    expect(await headTree()).not.toContain('AGENTS.md');
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

describe('03 apply on a repository with no git yet', () => {
  let dir: string;
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'haive-upgrade-nogit-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('checks the new repository against its .gitignore before forcing anything in', async () => {
    await writeFile(join(dir, 'AGENTS.md'), '# Agents\n');
    await writeFile(join(dir, '.gitignore'), 'CLAUDE.md\n');
    await writeFile(join(dir, 'CLAUDE.md'), '# private\n@AGENTS.md\n');
    const rows = [
      {
        detectOutput: null,
        output: { rulesImportStubs: [{ file: 'CLAUDE.md', result: 'unchanged' }] },
        iterations: [],
      },
    ];
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: async () => rows,
    });
    const db = {
      select: () => chain,
      query: {
        cliProviders: { findMany: async () => [] },
        tasks: { findFirst: async () => null },
        users: { findFirst: async () => null },
      },
    };
    const out = await upgradeCommitStep.apply(
      { db, repoPath: dir, taskId: 't1', userId: 'u1', logger } as never as StepContext,
      { detected: { hasGit: false }, formValues: { commit: true, initBranch: 'main' } } as never,
    );
    expect(out.commitPerformed).toBe(true);
    const tree = (await run('git', ['-C', dir, 'ls-tree', '--name-only', 'HEAD'])).stdout;
    expect(tree).toContain('AGENTS.md');
    expect(tree).not.toContain('CLAUDE.md');
    expect(out.warnings.join('\n')).toContain('CLAUDE.md is ignored by git');
  });
});
