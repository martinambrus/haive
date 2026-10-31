import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { namesGitData } from '@haive/shared/project-state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StepContext } from '../src/step-engine/step-definition.js';
import { postOnboardingStep } from '../src/step-engine/steps/onboarding/12-post-onboarding.js';
import {
  collectOnboardingStagePaths,
  commitRecorded,
} from '../src/step-engine/steps/onboarding/_stage-paths.js';
import { REFERENCE_CONTEXT } from '../src/step-engine/template-manifest.js';
import { upgradeCommitStep } from '../src/step-engine/steps/onboarding-upgrade/03-upgrade-commit.js';
import { recordWritten } from './support/upgrade-apply-record.js';
import { killGit, type KilledGit } from './support/kill-git.js';
import { dropIgnoredRulesFiles } from '../src/step-engine/steps/onboarding/_rules-files.js';

const stepOutputs = vi.hoisted(() => ({
  current: null as Record<string, { detect?: unknown; output?: unknown }> | null,
}));
const lstatSaysFile = vi.hoisted(() => new Set<string>());
vi.mock('@haive/shared/fs-safe', async (importOriginal) => {
  const original = await importOriginal<typeof import('@haive/shared/fs-safe')>();
  return {
    ...original,
    lstatNoFollow: async (...args: Parameters<typeof original.lstatNoFollow>) => {
      const entry = await original.lstatNoFollow(...args);
      return entry && lstatSaysFile.has(args[1]) ? { ...entry, kind: 'file' as const } : entry;
    },
  };
});
vi.mock('../src/step-engine/steps/onboarding/_helpers.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../src/step-engine/steps/onboarding/_helpers.js')>();
  return {
    ...original,
    loadPreviousStepOutput: (...args: Parameters<typeof original.loadPreviousStepOutput>) => {
      if (stepOutputs.current === null) return original.loadPreviousStepOutput(...args);
      const row = stepOutputs.current[args[2]];
      return Promise.resolve(
        row ? { detect: row.detect ?? null, output: row.output ?? null, iterations: [] } : null,
      );
    },
  };
});

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
let shim: KilledGit | null = null;
afterEach(async () => {
  await shim?.restore();
  shim = null;
  stepOutputs.current = null;
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

function mkCtx(repo: string, generateOutput: unknown = null): StepContext {
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () =>
      generateOutput ? [{ detectOutput: null, output: generateOutput, iterations: [] }] : [],
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
    const out = await postOnboardingStep.apply(mkCtx(repo, { wroteFiles: EXPECTED }), {
      detected: { hasGit: true } as never,
      formValues: { commit: true, commitMessage: 'chore: onboard' },
      iteration: 0,
      previousIterations: [],
    });
    expect(out.commitPerformed).toBe(true);
    expect(out.stagedPaths.filter((p) => p.startsWith('.claude/')).sort()).toEqual(EXPECTED);
  });

  it('12-post-onboarding leaves a file 07 left as it is for its owner to commit', async () => {
    const run = async (generateOutput: unknown) => {
      const repo = await repoWithAgents();
      await writeFile(path.join(repo, 'CLAUDE.md'), 'my own notes\n');
      const out = await postOnboardingStep.apply(mkCtx(repo, generateOutput), {
        detected: { hasGit: true } as never,
        formValues: { commit: true, commitMessage: 'chore: onboard' },
        iteration: 0,
        previousIterations: [],
      });
      return out.stagedPaths;
    };
    expect(
      await run({ wroteFiles: [], skippedFiles: ['CLAUDE.md'], leftAsIs: ['CLAUDE.md'] }),
    ).not.toContain('CLAUDE.md');
    expect(await run({ wroteFiles: [], skippedFiles: [] })).toContain('CLAUDE.md');
  });

  it('12-post-onboarding leaves such a file out even when a record names it', async () => {
    const repo = await repoWithAgents();
    const out = await postOnboardingStep.apply(
      mkCtx(repo, { wroteFiles: EXPECTED, skippedFiles: [], leftAsIs: ['.claude/agents/é.md'] }),
      {
        detected: { hasGit: true } as never,
        formValues: { commit: true, commitMessage: 'chore: onboard' },
        iteration: 0,
        previousIterations: [],
      },
    );
    expect(out.stagedPaths).toContain('.claude/agents/q"uote.md');
    expect(out.stagedPaths).not.toContain('.claude/agents/é.md');
  });

  it('03-upgrade-commit', async () => {
    const repo = await repoWithAgents();
    const out = await upgradeCommitStep.apply(mkCtx(repo, { writtenPaths: EXPECTED }), {
      detected: { hasGit: true } as never,
      formValues: { commit: true, commitMessage: 'chore: upgrade' },
      iteration: 0,
      previousIterations: [],
    });
    expect(out.commitPerformed).toBe(true);
    expect(out.stagedPaths.filter((p) => p.startsWith('.claude/')).sort()).toEqual(EXPECTED);
  });
});

describe('commit steps stage only the paths their step outputs record', () => {
  type Outputs = Record<string, { detect?: unknown; output?: unknown }>;

  async function seeded(files: Record<string, string> = {}): Promise<string> {
    const repo = await mkdtemp(path.join(tmpdir(), 'commit-scope-'));
    dirs.push(repo);
    await git(repo, ['init', '-q', '-b', 'main']);
    await git(repo, ['config', 'gc.auto', '0']);
    await put(repo, { 'README.md': 'r\n', ...files });
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-q', '-m', 'seed']);
    return repo;
  }

  async function put(repo: string, files: Record<string, string>): Promise<void> {
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
      await writeFile(path.join(repo, rel), body);
    }
  }

  const fakeDb = (
    artifactPaths: string[] = [],
    repositoryRow?: Record<string, unknown>,
    planNodes?: unknown[],
  ) => {
    const rowsFor = (table: unknown): unknown[] => {
      if (table === schema.tasks) return [{ repositoryId: 'r1' }];
      if (table === schema.repositories && repositoryRow) return [repositoryRow];
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
    const none = { findFirst: async () => undefined, findMany: async () => [] };
    // The first transaction (the record's own) is refused; the clearing one after it goes through.
    let transactions = 0;
    const planTx = () => {
      const planRows = (table: unknown): unknown[] => {
        if (table === schema.planMirrorState) return [{ revision: 1, writtenRevision: 0 }];
        if (table === schema.planNodes) return planNodes ?? [];
        return [];
      };
      const tx = {
        execute: async () => [],
        update: () => ({ set: () => ({ where: async () => [] }) }),
        select: () => {
          let table: unknown;
          const chain: Record<string, unknown> = {};
          Object.assign(chain, {
            from: (t: unknown) => {
              table = t;
              return chain;
            },
            where: () => chain,
            orderBy: () => chain,
            limit: async () => planRows(table),
            then: (resolve: (rows: unknown[]) => unknown, reject: (err: unknown) => unknown) =>
              Promise.resolve(planRows(table)).then(resolve, reject),
          });
          return chain;
        },
      };
      return tx;
    };
    const transaction = async (run: (tx: unknown) => Promise<unknown>) => {
      if (planNodes) return run(planTx());
      if (++transactions === 1) throw new Error('database refused');
      await run({
        execute: async () => [],
        update: () => ({ set: () => ({ where: async () => [] }) }),
        select: () => ({ from: () => ({ where: () => ({ orderBy: async () => [] }) }) }),
      });
    };
    return { select, transaction, query: new Proxy({}, { get: () => none }) };
  };

  const ctxFor = (
    repo: string,
    artifactPaths?: string[],
    repositoryRow?: Record<string, unknown>,
    planNodes?: unknown[],
  ): StepContext =>
    ({
      repoPath: repo,
      workspacePath: repo,
      userId: 'u1',
      taskId: 't1',
      taskStepId: 's1',
      logger,
      db: fakeDb(artifactPaths, repositoryRow, planNodes),
    }) as unknown as StepContext;

  async function twelve(
    repo: string,
    outputs: Outputs,
    artifactPaths: string[] = [],
    repositoryRow?: Record<string, unknown>,
    planNodes?: unknown[],
  ) {
    stepOutputs.current = outputs;
    return postOnboardingStep.apply(ctxFor(repo, artifactPaths, repositoryRow, planNodes), {
      detected: { hasGit: true } as never,
      formValues: { commit: true, commitMessage: 'chore: onboard' },
      iteration: 0,
      previousIterations: [],
    });
  }

  async function three(repo: string, applyOutput: unknown) {
    stepOutputs.current = { '02-upgrade-apply': { output: applyOutput } };
    return upgradeCommitStep.apply(ctxFor(repo), {
      detected: { hasGit: true } as never,
      formValues: { commit: true, commitMessage: 'chore: upgrade' },
      iteration: 0,
      previousIterations: [],
    });
  }

  const tracked = async (repo: string): Promise<string[]> =>
    (await git(repo, ['ls-tree', '-r', '--name-only', 'HEAD'])).split('\n').filter(Boolean);

  it('1: 12 leaves a file in a skills directory that 09_5 did not write', async () => {
    const repo = await seeded();
    await put(repo, {
      '.claude/skills/a/SKILL.md': 's\n',
      '.claude/skills/README.md': 'i\n',
      '.claude/skills/mine/NOTES.md': 'n\n',
    });
    const out = await twelve(repo, {
      '09_5-skill-generation': {
        output: { written: [{ id: 'a', mirroredDirs: ['.claude/skills'], subSkillSlugs: [] }] },
      },
    });
    expect(out.commitPerformed).toBe(true);
    const files = await tracked(repo);
    expect(files).toContain('.claude/skills/a/SKILL.md');
    expect(files).toContain('.claude/skills/README.md');
    expect(files).not.toContain('.claude/skills/mine/NOTES.md');
  });

  it('2: 12 leaves a git-ignored file in an agents directory out', async () => {
    const repo = await seeded();
    await appendFile(path.join(repo, '.git', 'info', 'exclude'), '.claude/agents/local.md\n');
    await put(repo, { '.claude/agents/a.md': 'a\n', '.claude/agents/local.md': 'l\n' });
    const out = await twelve(repo, {
      '07-generate-files': { output: { wroteFiles: ['.claude/agents/a.md'], skippedFiles: [] } },
    });
    expect(out.commitPerformed).toBe(true);
    const files = await tracked(repo);
    expect(files).toContain('.claude/agents/a.md');
    expect(files).not.toContain('.claude/agents/local.md');
  });

  it('3: 12 does not commit an untracked agent that was moved to -legacy', async () => {
    const repo = await seeded();
    await put(repo, {
      '.claude/agents/a.md': 'a\n',
      '.claude/agents-legacy/mine.md': 'm\n',
      '.claude/agents-legacy/README.md': 'r\n',
    });
    const out = await twelve(repo, {
      '07-generate-files': {
        output: {
          wroteFiles: ['.claude/agents/a.md', '.claude/agents-legacy/README.md'],
          skippedFiles: [],
          quarantinedAgentFiles: [
            { from: '.claude/agents/mine.md', to: '.claude/agents-legacy/mine.md' },
          ],
        },
      },
    });
    expect(out.commitPerformed).toBe(true);
    const files = await tracked(repo);
    expect(files).toContain('.claude/agents/a.md');
    expect(files.filter((f) => f.startsWith('.claude/agents-legacy/'))).toEqual([]);
  });

  it('4: 12 commits the move of a tracked agent to -legacy, and nothing else in that directory', async () => {
    const repo = await seeded({ '.claude/agents/mine.md': 'm\n' });
    await mkdir(path.join(repo, '.claude', 'agents-legacy'), { recursive: true });
    await rename(
      path.join(repo, '.claude', 'agents', 'mine.md'),
      path.join(repo, '.claude', 'agents-legacy', 'mine.md'),
    );
    await put(repo, {
      '.claude/agents/a.md': 'a\n',
      '.claude/agents-legacy/README.md': 'r\n',
      '.claude/agents-legacy/theirs.md': 't\n',
    });
    const out = await twelve(repo, {
      '07-generate-files': {
        output: {
          wroteFiles: ['.claude/agents/a.md', '.claude/agents-legacy/README.md'],
          skippedFiles: [],
          quarantinedAgentFiles: [
            { from: '.claude/agents/mine.md', to: '.claude/agents-legacy/mine.md' },
          ],
        },
      },
    });
    expect(out.commitPerformed).toBe(true);
    const files = await tracked(repo);
    expect(files).toContain('.claude/agents-legacy/mine.md');
    expect(files).toContain('.claude/agents-legacy/README.md');
    expect(files).not.toContain('.claude/agents/mine.md');
    expect(files).not.toContain('.claude/agents-legacy/theirs.md');
  });

  it('5: 12 does not commit a file the person had already staged', async () => {
    const repo = await seeded();
    await put(repo, { 'src/a.ts': 'x\n', '.claude/agents/a.md': 'a\n' });
    await git(repo, ['add', 'src/a.ts']);
    const out = await twelve(repo, {
      '07-generate-files': { output: { wroteFiles: ['.claude/agents/a.md'], skippedFiles: [] } },
    });
    expect(out.commitPerformed).toBe(true);
    expect(await tracked(repo)).not.toContain('src/a.ts');
    expect(await git(repo, ['diff', '--cached', '--name-only'])).toContain('src/a.ts');
  });

  it('6: 03 leaves a knowledge file 02 did not write', async () => {
    const repo = await seeded();
    await put(repo, { '.claude/agents/a.md': 'a\n', '.haive-data/knowledge_base/mine.md': 'k\n' });
    const out = await three(repo, { writtenPaths: ['.claude/agents/a.md'] });
    expect(out.commitPerformed).toBe(true);
    const files = await tracked(repo);
    expect(files).toContain('.claude/agents/a.md');
    expect(files).not.toContain('.haive-data/knowledge_base/mine.md');
  });

  it('7: 12 commits the legacy knowledge move of an 08 Retry that recorded none', async () => {
    const repo = await seeded({
      '.claude/knowledge_base/A.md': 'a\n',
      '.claude/knowledge_base/B.md': 'b-old\n',
      '.claude/learnings/L.md': 'l\n',
      '.haive-data/knowledge_base/B.md': 'b-new\n',
    });
    const kb = path.join(repo, '.haive-data', 'knowledge_base');
    await mkdir(path.join(kb, 'legacy'), { recursive: true });
    await mkdir(path.join(repo, '.haive-data', 'learnings'), { recursive: true });
    await rename(path.join(repo, '.claude/knowledge_base/A.md'), path.join(kb, 'A.md'));
    await rename(path.join(repo, '.claude/knowledge_base/B.md'), path.join(kb, 'legacy', 'B.md'));
    await rename(
      path.join(repo, '.claude/learnings/L.md'),
      path.join(repo, '.haive-data/learnings/L.md'),
    );
    await put(repo, { '.haive-data/knowledge_base/mine.md': 'k\n' });
    const out = await twelve(repo, { '08-knowledge-acquisition': { output: { written: [] } } });
    expect(out.commitPerformed).toBe(true);
    const files = await tracked(repo);
    expect(files).toContain('.haive-data/knowledge_base/A.md');
    expect(files).toContain('.haive-data/knowledge_base/legacy/B.md');
    expect(files).toContain('.haive-data/learnings/L.md');
    expect(files).not.toContain('.claude/knowledge_base/A.md');
    expect(files).not.toContain('.claude/knowledge_base/B.md');
    expect(files).not.toContain('.claude/learnings/L.md');
    expect(await git(repo, ['show', 'HEAD:.haive-data/knowledge_base/B.md'])).toBe('b-new\n');
    expect(files).not.toContain('.haive-data/knowledge_base/mine.md');
  });

  it('7b: 12 leaves the destination of an untracked legacy file to its owner', async () => {
    const repo = await seeded({ '.claude/knowledge_base/A.md': 'a\n' });
    await put(repo, { '.claude/knowledge_base/U.md': 'u\n' });
    const kb = path.join(repo, '.haive-data', 'knowledge_base');
    await mkdir(kb, { recursive: true });
    await rename(path.join(repo, '.claude/knowledge_base/A.md'), path.join(kb, 'A.md'));
    await rename(path.join(repo, '.claude/knowledge_base/U.md'), path.join(kb, 'U.md'));
    const out = await twelve(repo, { '08-knowledge-acquisition': { output: { written: [] } } });
    expect(out.commitPerformed).toBe(true);
    const files = await tracked(repo);
    expect(files).toContain('.haive-data/knowledge_base/A.md');
    expect(files).not.toContain('.haive-data/knowledge_base/U.md');
  });

  it('12 commits recorded removals when nothing else is left to add', async () => {
    const repo = await seeded({ '.claude/knowledge_base/A.md': 'a\n' });
    await rm(path.join(repo, '.claude/knowledge_base/A.md'));
    const out = await twelve(repo, { '08-knowledge-acquisition': { output: { written: [] } } });
    expect(out.commitPerformed).toBe(true);
    expect(await tracked(repo)).not.toContain('.claude/knowledge_base/A.md');
  });

  it('12 commits the whole tree of a repository with no git, as before', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'commit-scope-nogit-'));
    dirs.push(repo);
    await put(repo, { 'src/a.ts': 'x\n', '.claude/agents/a.md': 'a\n' });
    stepOutputs.current = {
      '07-generate-files': { output: { wroteFiles: ['.claude/agents/a.md'], skippedFiles: [] } },
    };
    const out = await postOnboardingStep.apply(ctxFor(repo), {
      detected: { hasGit: false } as never,
      formValues: { commit: true, initBranch: 'main' },
      iteration: 0,
      previousIterations: [],
    });
    expect(out.commitPerformed).toBe(true);
    expect(await tracked(repo)).toEqual(['.claude/agents/a.md', 'src/a.ts']);
  });

  it('12 makes the first commit of a repository that has git but no commit, without the staged file', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'commit-scope-unborn-'));
    dirs.push(repo);
    await git(repo, ['init', '-q', '-b', 'main']);
    await git(repo, ['config', 'gc.auto', '0']);
    await put(repo, { 'src/a.ts': 'x\n', '.claude/agents/a.md': 'a\n' });
    await git(repo, ['add', 'src/a.ts']);
    const out = await twelve(repo, {
      '07-generate-files': { output: { wroteFiles: ['.claude/agents/a.md'], skippedFiles: [] } },
    });
    expect(out.commitPerformed).toBe(true);
    expect(await tracked(repo)).not.toContain('src/a.ts');
    expect(await tracked(repo)).toContain('.claude/agents/a.md');
  });

  it('03 commits a removal 02 recorded, and not a staged file beside it', async () => {
    const repo = await seeded({ '.claude/settings.json': '{}\n' });
    await rm(path.join(repo, '.claude', 'settings.json'));
    await put(repo, { 'src/a.ts': 'x\n' });
    await git(repo, ['add', 'src/a.ts']);
    const out = await three(repo, { writtenPaths: [], deletedPaths: ['.claude/settings.json'] });
    expect(out.commitPerformed).toBe(true);
    expect(await tracked(repo)).not.toContain('.claude/settings.json');
    expect(await tracked(repo)).not.toContain('src/a.ts');
  });

  it('03 stages no removal it cannot prove, as when a link stands in the path', async () => {
    const repo = await seeded({ '.claude/settings.json': '{}\n' });
    const outside = await mkdtemp(path.join(tmpdir(), 'commit-scope-out-'));
    dirs.push(outside);
    await writeFile(path.join(outside, 'settings.json'), '{}\n');
    await rm(path.join(repo, '.claude'), { recursive: true, force: true });
    await symlink(outside, path.join(repo, '.claude'));
    const out = await three(repo, { writtenPaths: [], deletedPaths: ['.claude/settings.json'] });
    expect(await tracked(repo)).toContain('.claude/settings.json');
    expect(
      out.warnings.some((w) =>
        w.startsWith('.claude/settings.json was not staged as removed: it could not be checked'),
      ),
    ).toBe(true);
  });

  it('9: 12 commits the project state files a failed record write left on disk', async () => {
    const repo = await seeded();
    await put(repo, { '.claude/agents/a.md': 'a\n' });
    stepOutputs.current = {
      '07-generate-files': {
        detect: { ...REFERENCE_CONTEXT, cliProviders: [] },
        output: { wroteFiles: ['.claude/agents/a.md'], skippedFiles: [] },
      },
    };
    const fake = createFakeDb({
      tasks: schema.tasks,
      repositories: schema.repositories,
      onboardingArtifacts: schema.onboardingArtifacts,
      customBundles: schema.customBundles,
      customBundleItems: schema.customBundleItems,
      cliProviders: schema.cliProviders,
      users: schema.users,
      projectStateSync: schema.projectStateSync,
      projectStateOutbox: schema.projectStateOutbox,
      projectStateConflicts: schema.projectStateConflicts,
    });
    fake.insert(schema.repositories, {
      id: '00000000-0000-4000-8000-0000000000b1',
      userId: '00000000-0000-4000-8000-0000000000a1',
      name: 'acme',
      source: 'upload',
      rtkEnabled: false,
    });
    fake.insert(schema.tasks, {
      id: '00000000-0000-4000-8000-0000000000c1',
      userId: '00000000-0000-4000-8000-0000000000a1',
      repositoryId: '00000000-0000-4000-8000-0000000000b1',
      type: 'onboarding',
      status: 'running',
    });
    // Refuse the semantic transaction after actual files, never the new committed-intent preparation.
    let refused = false;
    fake.hooks.beforeInsert = (table) => {
      if (table === schema.projectStateSync && !refused) {
        refused = true;
        throw new Error('database refused after record files');
      }
    };
    const ctx = {
      ...ctxFor(repo),
      db: fake.db,
      userId: '00000000-0000-4000-8000-0000000000a1',
      taskId: '00000000-0000-4000-8000-0000000000c1',
    } as unknown as StepContext;
    const out = await recordWritten(
      postOnboardingStep.apply(ctx, {
        detected: { hasGit: true } as never,
        formValues: { commit: true, commitMessage: 'chore: onboard' },
        iteration: 0,
        previousIterations: [],
      }),
      { recordWriteFails: true },
    );
    expect(refused).toBe(true);
    expect(fake.rows(schema.projectStateOutbox)[0]!.writeIntent).toBeTruthy();
    expect(out.warnings.some((w) => w.startsWith('project state record write failed'))).toBe(true);
    expect(out.commitPerformed).toBe(true);
    const files = await tracked(repo);
    expect(files).toContain('.haive-data/state/format.json');
    expect(files).toContain('.haive-data/state/project/render.json');
  });

  it('10: 12 commits the mirror files written before a later mirror file was refused', async () => {
    const repo = await seeded();
    await put(repo, { '.claude/agents/a.md': 'a\n' });
    const outside = await mkdtemp(path.join(tmpdir(), 'commit-scope-out-'));
    dirs.push(outside);
    await mkdir(path.join(repo, '.haive-data'), { recursive: true });
    await symlink(
      path.join(outside, 'elsewhere.json'),
      path.join(repo, '.haive-data/tooling.json'),
    );
    const out = await twelve(
      repo,
      {
        '07-generate-files': { output: { wroteFiles: ['.claude/agents/a.md'], skippedFiles: [] } },
      },
      [],
      {
        onboardingEnvironment: { schemaVersion: 1 },
        onboardingTooling: { schemaVersion: 1, tooling: {} },
        scopeExcludeGlobs: null,
      },
    );
    expect(out.warnings.some((w) => w.startsWith('haive-data mirror write failed'))).toBe(true);
    expect(out.commitPerformed).toBe(true);
    expect(await tracked(repo)).toContain('.haive-data/environment.json');
  });

  it('11: 12 commits the removal of a tracked sub-skill 09_5b dropped with the repaired directory', async () => {
    const repo = await seeded({
      '.claude/skills/a/SKILL.md': 'old\n',
      '.claude/skills/a/sub-skills/stale.md': 'stale\n',
      '.claude/skills/a/sub-skills/kept.md': 'kept\n',
    });
    await rm(path.join(repo, '.claude/skills/a'), { recursive: true });
    await put(repo, {
      '.claude/skills/a/SKILL.md': 'new\n',
      '.claude/skills/a/sub-skills/kept.md': 'kept2\n',
    });
    const out = await twelve(repo, {
      '09_5b-skill-repair': {
        detect: { skillTargetDirs: ['.claude/skills'] },
        output: { repaired: ['a'], repairedSubSkillSlugs: { a: ['kept'] } },
      },
    });
    expect(out.commitPerformed).toBe(true);
    const files = await tracked(repo);
    expect(files).not.toContain('.claude/skills/a/sub-skills/stale.md');
    expect(files).toContain('.claude/skills/a/sub-skills/kept.md');
    expect(await git(repo, ['show', 'HEAD:.claude/skills/a/SKILL.md'])).toBe('new\n');
  });

  it('collects what each step output records, and nothing wider', async () => {
    const repo = await seeded({
      '.claude/agents/gone.md': 'g\n',
      '.claude/skills/s1/sub-skills/y.md': 'y\n',
    });
    await rm(path.join(repo, '.claude/skills/s1'), { recursive: true });
    stepOutputs.current = {
      '07-generate-files': {
        output: {
          wroteFiles: ['.claude/agents/a.md', '../escape.md', 7],
          quarantinedAgentFiles: [
            { from: '.claude/agents/gone.md', to: '.claude/agents-legacy/gone.md' },
            { from: '.claude/agents/mine.md', to: '.claude/agents-legacy/mine.md' },
          ],
        },
      },
      '08-knowledge-acquisition': {
        output: {
          written: [
            { filePath: path.join(repo, '.haive-data/knowledge_base/ARCH.md') },
            { filePath: 'global-kb:abc' },
            { filePath: '/elsewhere/x.md' },
          ],
          mergedRemoved: ['legacy/OLD.md'],
          removedPaths: ['.haive-data/knowledge_base/moved.md'],
        },
      },
      '09_3-qa-review': {
        output: {
          kbWritten: [{ relPath: '.haive-data/knowledge_base/BL.md' }, { relPath: '../x' }],
        },
      },
      '09_5-skill-generation': {
        output: {
          written: [
            {
              id: 's1',
              mirroredDirs: ['.claude/skills', '.agents/skills'],
              subSkillSlugs: ['x', 'y'],
            },
          ],
        },
      },
      '09_5b-skill-repair': {
        detect: { skillTargetDirs: ['.claude/skills'] },
        output: { repaired: ['s1'], repairedSubSkillSlugs: { s1: ['x'] } },
      },
    };
    const plan = await collectOnboardingStagePaths(repo, {} as never, 't1');
    expect(plan.add.sort()).toEqual(
      [
        '.agents/skills/README.md',
        '.agents/skills/s1/SKILL.md',
        '.agents/skills/s1/sub-skills/x.md',
        '.agents/skills/s1/sub-skills/y.md',
        '.claude/agents-legacy/gone.md',
        '.claude/agents/a.md',
        '.claude/skills/README.md',
        '.claude/skills/s1/SKILL.md',
        '.claude/skills/s1/sub-skills/x.md',
        '.claude/skills/s1/sub-skills/y.md',
        '.haive-data/knowledge_base/ARCH.md',
        '.haive-data/knowledge_base/BL.md',
        '.haive-data/knowledge_base/INDEX.md',
      ].sort(),
    );
    expect(plan.remove.sort()).toEqual(
      [
        '.claude/agents/gone.md',
        '.claude/skills/s1/sub-skills/y.md',
        '.haive-data/knowledge_base/legacy/OLD.md',
        '.haive-data/knowledge_base/moved.md',
      ].sort(),
    );
  });

  const planNode = {
    id: '00000000-0000-4000-8000-0000000000c1',
    parentId: null,
    path: 'c1',
    ordinal: 0,
    title: 'Shop',
    kind: 'component',
    body: null,
    status: 'todo',
    taskable: false,
    version: 1,
    createdBy: 'user',
    sourceTaskId: null,
    lastReviewedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const emptyMirrorRow = {
    onboardingEnvironment: null,
    onboardingTooling: null,
    scopeExcludeGlobs: null,
  };

  it('12: the plan file the mirror wrote is committed and the symlink it refused is not', async () => {
    const repo = await seeded();
    await put(repo, { '.claude/agents/a.md': 'a\n' });
    const outside = await mkdtemp(path.join(tmpdir(), 'commit-scope-out-'));
    dirs.push(outside);
    await mkdir(path.join(repo, '.haive-data'), { recursive: true });
    await symlink(path.join(outside, 'elsewhere.md'), path.join(repo, '.haive-data/plan.md'));
    const out = await twelve(
      repo,
      {
        '07-generate-files': { output: { wroteFiles: ['.claude/agents/a.md'], skippedFiles: [] } },
      },
      [],
      emptyMirrorRow,
      [planNode],
    );
    expect(out.warnings.some((w) => w.includes('plan mirror failed'))).toBe(true);
    expect(out.commitPerformed).toBe(true);
    const files = await tracked(repo);
    expect(files).toContain('.haive-data/plan.json');
    expect(files).not.toContain('.haive-data/plan.md');
  });

  it('13: a tracked plan file missing after a failed mirror refresh is not committed as a deletion', async () => {
    const repo = await seeded({ '.haive-data/plan.json': '{}\n', '.haive-data/plan.md': 'p\n' });
    await rm(path.join(repo, '.haive-data/plan.json'));
    await rm(path.join(repo, '.haive-data/plan.md'));
    await put(repo, { '.claude/agents/a.md': 'a\n' });
    const out = await twelve(
      repo,
      {
        '07-generate-files': { output: { wroteFiles: ['.claude/agents/a.md'], skippedFiles: [] } },
      },
      [],
      emptyMirrorRow,
    );
    expect(out.warnings.some((w) => w.includes('plan mirror failed'))).toBe(true);
    expect(out.commitPerformed).toBe(true);
    const files = await tracked(repo);
    expect(files).toContain('.haive-data/plan.json');
    expect(files).toContain('.haive-data/plan.md');
  });

  it('13b: a plan with no nodes still commits the removal of the mirror files it removed', async () => {
    const repo = await seeded({ '.haive-data/plan.json': '{}\n', '.haive-data/plan.md': 'p\n' });
    await put(repo, { '.claude/agents/a.md': 'a\n' });
    const out = await twelve(
      repo,
      {
        '07-generate-files': { output: { wroteFiles: ['.claude/agents/a.md'], skippedFiles: [] } },
      },
      [],
      emptyMirrorRow,
      [],
    );
    expect(out.commitPerformed).toBe(true);
    const files = await tracked(repo);
    expect(files).not.toContain('.haive-data/plan.json');
    expect(files).not.toContain('.haive-data/plan.md');
  });

  it('13c: a plan file removed while its sibling removal fails is still committed as removed', async () => {
    const repo = await seeded({ '.haive-data/plan.json': '{}\n', '.haive-data/plan.md': 'p\n' });
    await rm(path.join(repo, '.haive-data', 'plan.md'));
    await mkdir(path.join(repo, '.haive-data', 'plan.md'), { recursive: true });
    await writeFile(path.join(repo, '.haive-data', 'plan.md', 'keep.txt'), 'k\n');
    await put(repo, { '.claude/agents/a.md': 'a\n' });
    const out = await twelve(
      repo,
      {
        '07-generate-files': { output: { wroteFiles: ['.claude/agents/a.md'], skippedFiles: [] } },
      },
      [],
      emptyMirrorRow,
      [],
    );
    expect(out.commitPerformed).toBe(true);
    const files = await tracked(repo);
    expect(files).not.toContain('.haive-data/plan.json');
    expect(files).not.toContain('.haive-data/plan.md/keep.txt');
  });

  it('14: a canonical legacy move is committed although legacy/<rel> already exists', async () => {
    const repo = await seeded({ '.claude/knowledge_base/A.md': 'a\n' });
    const kb = path.join(repo, '.haive-data', 'knowledge_base');
    await mkdir(path.join(kb, 'legacy'), { recursive: true });
    await writeFile(path.join(kb, 'legacy', 'A.md'), 'imported earlier\n');
    await rename(path.join(repo, '.claude/knowledge_base/A.md'), path.join(kb, 'A.md'));
    const out = await twelve(repo, { '08-knowledge-acquisition': { output: { written: [] } } });
    expect(out.commitPerformed).toBe(true);
    const files = await tracked(repo);
    expect(files).toContain('.haive-data/knowledge_base/A.md');
    expect(files).not.toContain('.claude/knowledge_base/A.md');
  });

  it('8: 12 stages a file 07 skipped on a Retry that has a manifest row', async () => {
    const repo = await seeded();
    await put(repo, { '.claude/agents/a.md': 'a\n' });
    const out = await twelve(
      repo,
      {
        '07-generate-files': { output: { wroteFiles: [], skippedFiles: ['.claude/agents/a.md'] } },
      },
      ['.claude/agents/a.md'],
    );
    expect(out.commitPerformed).toBe(true);
    expect(await tracked(repo)).toContain('.claude/agents/a.md');
  });
});

describe('commitRecorded commits what it staged in a private index', () => {
  async function seededRepo(files: Record<string, string>): Promise<string> {
    const repo = await mkdtemp(path.join(tmpdir(), 'commit-index-'));
    dirs.push(repo);
    await git(repo, ['init', '-q', '-b', 'main']);
    await git(repo, ['config', 'gc.auto', '0']);
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
      await writeFile(path.join(repo, rel), body);
    }
    if (Object.keys(files).length > 0) {
      await git(repo, ['add', '-A']);
      await git(repo, ['commit', '-q', '-m', 'seed']);
    }
    return repo;
  }

  it('R7-1: a newer blob staged in the real index at a named path is not what is committed', async () => {
    const repo = await seededRepo({ 'README.md': 'r\n', '.haive-data/plan.json': 'v0\n' });
    await writeFile(path.join(repo, '.haive-data', 'plan.json'), 'newer\n');
    await git(repo, ['add', '.haive-data/plan.json']);
    await writeFile(path.join(repo, '.haive-data', 'plan.json'), 'ours\n');
    const done = await commitRecorded(
      repo,
      { add: ['.haive-data/plan.json'], remove: [] },
      'chore: onboard',
      GIT_ENV,
    );
    expect(done).toEqual(['.haive-data/plan.json']);
    expect(await git(repo, ['show', 'HEAD:.haive-data/plan.json'])).toBe('ours\n');
    expect(await git(repo, ['log', '-1', '--format=%s'])).toBe('chore: onboard\n');
  });

  it('a name that became a directory after its check commits nothing under it', async () => {
    const repo = await seededRepo({ 'README.md': 'r\n', '.haive/install.json': '{}\n' });
    await rm(path.join(repo, '.haive', 'install.json'));
    await mkdir(path.join(repo, '.haive', 'install.json'), { recursive: true });
    await writeFile(path.join(repo, '.haive', 'install.json', 'private.md'), 'p\n');
    await writeFile(path.join(repo, 'a.md'), 'a\n');
    lstatSaysFile.add('.haive/install.json');
    try {
      const done = await commitRecorded(
        repo,
        { add: ['.haive/install.json', 'a.md'], remove: [] },
        'chore: onboard',
        GIT_ENV,
      );
      expect(done).toEqual(['a.md']);
    } finally {
      lstatSaysFile.clear();
    }
    const files = await git(repo, ['ls-tree', '-r', '--name-only', 'HEAD']);
    expect(files).not.toContain('private.md');
    expect(await git(repo, ['show', 'HEAD:.haive/install.json'])).toBe('{}\n');
  });

  it('a child the person staged under a removed name that is now a directory stays staged', async () => {
    const repo = await seededRepo({ 'README.md': 'r\n', '.haive/install.json': '{}\n' });
    await rm(path.join(repo, '.haive', 'install.json'));
    await mkdir(path.join(repo, '.haive', 'install.json'), { recursive: true });
    await writeFile(path.join(repo, '.haive', 'install.json', 'private.md'), 'p\n');
    await git(repo, ['add', '-f', '.haive/install.json/private.md']);
    await writeFile(path.join(repo, 'a.md'), 'a\n');
    await commitRecorded(
      repo,
      { add: ['a.md'], remove: ['.haive/install.json'] },
      'chore: onboard',
      GIT_ENV,
    );
    expect(await git(repo, ['diff', '--cached', '--name-only'])).toContain(
      '.haive/install.json/private.md',
    );
    expect(await git(repo, ['show', 'HEAD:.haive/install.json'])).toBe('{}\n');
  });

  it('a recorded removal recreated before the commit is not committed as a deletion', async () => {
    const repo = await seededRepo({ 'README.md': 'r\n', 'back.md': 'old\n' });
    await writeFile(path.join(repo, 'back.md'), 'recreated\n');
    await writeFile(path.join(repo, 'a.md'), 'a\n');
    const done = await commitRecorded(
      repo,
      { add: ['a.md'], remove: ['back.md'] },
      'chore: onboard',
      GIT_ENV,
    );
    expect(done).toEqual(['a.md']);
    expect(await git(repo, ['show', 'HEAD:back.md'])).toBe('old\n');
  });

  it('a real index locked briefly by another writer is synced once the lock goes', async () => {
    const repo = await seededRepo({ 'README.md': 'r\n' });
    await writeFile(path.join(repo, 'a.md'), 'a\n');
    const lock = path.join(repo, '.git', 'index.lock');
    await writeFile(lock, '');
    setTimeout(() => void rm(lock, { force: true }), 250);
    const warnings: string[] = [];
    await commitRecorded(repo, { add: ['a.md'], remove: [] }, 'chore: onboard', GIT_ENV, warnings);
    expect(warnings).toEqual([]);
    expect(await git(repo, ['status', '--porcelain', '--', 'a.md'])).toBe('');
  });

  it('a commit landing on top while the index is locked is not reverted in the index', async () => {
    const repo = await seededRepo({ 'README.md': 'r\n' });
    await writeFile(path.join(repo, 'a.md'), 'a\n');
    const lock = path.join(repo, '.git', 'index.lock');
    await writeFile(lock, '');
    const other = (async () => {
      while ((await git(repo, ['log', '-1', '--format=%s'])).trim() !== 'chore: onboard') {
        await new Promise((r) => setTimeout(r, 20));
      }
      const env = { ...GIT_ENV, GIT_INDEX_FILE: path.join(repo, '.git', 'other.index') };
      const newer = path.join(repo, '.git', 'newer.txt');
      await writeFile(newer, 'newer\n');
      const blob = (await git(repo, ['hash-object', '-w', newer])).trim();
      await exec('git', ['read-tree', 'HEAD'], { cwd: repo, env });
      await exec('git', ['update-index', '--cacheinfo', `100644,${blob},a.md`], { cwd: repo, env });
      const tree = (await exec('git', ['write-tree'], { cwd: repo, env })).stdout.trim();
      const next = (
        await git(repo, ['commit-tree', tree, '-p', 'HEAD', '-m', 'chore: newer'])
      ).trim();
      await git(repo, ['update-ref', 'HEAD', next]);
      await rm(lock, { force: true });
    })();
    const warnings: string[] = [];
    await commitRecorded(repo, { add: ['a.md'], remove: [] }, 'chore: onboard', GIT_ENV, warnings);
    await other;
    expect(warnings).toEqual([]);
    expect(await git(repo, ['diff', '--cached', '--name-only', '--', 'a.md'])).toBe('');
  });

  it('a real index that stays locked leaves the commit and reports which names to reset', async () => {
    const repo = await seededRepo({ 'README.md': 'r\n' });
    await writeFile(path.join(repo, 'a.md'), 'a\n');
    const lock = path.join(repo, '.git', 'index.lock');
    await writeFile(lock, '');
    const warnings: string[] = [];
    try {
      await commitRecorded(
        repo,
        { add: ['a.md'], remove: [] },
        'chore: onboard',
        GIT_ENV,
        warnings,
      );
    } finally {
      await rm(lock, { force: true });
    }
    expect(await git(repo, ['show', 'HEAD:a.md'])).toBe('a\n');
    expect(warnings.join('\n')).toContain('a.md');
  });

  it('R7-2: the committed names are clean afterwards and the person staged work stays staged', async () => {
    const repo = await seededRepo({ 'README.md': 'r\n', 'gone.md': 'g\n', 'keep.md': 'k\n' });
    await writeFile(path.join(repo, 'a.md'), 'a\n');
    await rm(path.join(repo, 'gone.md'));
    await writeFile(path.join(repo, 'mine.ts'), 'mine\n');
    await git(repo, ['add', 'mine.ts']);
    const done = await commitRecorded(
      repo,
      { add: ['a.md', 'keep.md'], remove: ['gone.md'] },
      'chore: onboard',
      GIT_ENV,
    );
    expect(done.sort()).toEqual(['a.md', 'gone.md']);
    expect(
      (await git(repo, ['show', '--name-only', '--format=', 'HEAD'])).trim().split('\n'),
    ).toEqual(['a.md', 'gone.md']);
    expect(await git(repo, ['status', '--porcelain'])).toBe('A  mine.ts\n');
  });

  it('a directory standing at a recorded file path is never staged', async () => {
    const repo = await seededRepo({ 'README.md': 'r\n' });
    await mkdir(path.join(repo, '.haive-data', 'plan.json'), { recursive: true });
    await writeFile(path.join(repo, '.haive-data', 'plan.json', 'private.md'), 'p\n');
    await writeFile(path.join(repo, 'a.md'), 'a\n');
    const done = await commitRecorded(
      repo,
      { add: ['.haive-data/plan.json', 'a.md'], remove: [] },
      'chore: onboard',
      GIT_ENV,
    );
    expect(done).toEqual(['a.md']);
    expect((await git(repo, ['show', '--name-only', '--format=', 'HEAD'])).trim()).toBe('a.md');
  });

  it('a file the person staged under a directory standing at a named path is not committed', async () => {
    const repo = await seededRepo({ 'README.md': 'r\n' });
    await mkdir(path.join(repo, '.haive', 'install.json'), { recursive: true });
    await writeFile(path.join(repo, '.haive', 'install.json', 'private.md'), 'p\n');
    await git(repo, ['add', '-f', '.haive/install.json/private.md']);
    await writeFile(path.join(repo, 'a.md'), 'a\n');
    const done = await commitRecorded(
      repo,
      { add: ['.haive/install.json', 'a.md'], remove: [] },
      'chore: onboard',
      GIT_ENV,
    );
    expect(done).toEqual(['a.md']);
    expect((await git(repo, ['show', '--name-only', '--format=', 'HEAD'])).trim()).toBe('a.md');
    expect((await git(repo, ['diff', '--cached', '--name-only'])).trim()).toBe(
      '.haive/install.json/private.md',
    );
  });

  it('R2-2: a removal is committed and the person staged file is left', async () => {
    const repo = await seededRepo({ 'README.md': 'r\n', 'gone.md': 'g\n', 'keep.md': 'k\n' });
    await rm(path.join(repo, 'gone.md'));
    await writeFile(path.join(repo, 'src.ts'), 's\n');
    await git(repo, ['add', 'src.ts']);
    const done = await commitRecorded(
      repo,
      { add: [], remove: ['gone.md'] },
      'chore: drop',
      GIT_ENV,
    );
    expect(done).toEqual(['gone.md']);
    expect(await git(repo, ['ls-tree', '-r', '--name-only', 'HEAD'])).not.toContain('gone.md');
    expect(await git(repo, ['ls-tree', '-r', '--name-only', 'HEAD'])).toContain('keep.md');
    expect((await git(repo, ['diff', '--cached', '--name-only'])).trim()).toBe('src.ts');
  });

  it('R2-3: the first commit of a repository with no commit holds the named entry only', async () => {
    const repo = await seededRepo({});
    await writeFile(path.join(repo, 'a.md'), 'a\n');
    await writeFile(path.join(repo, 'mine.ts'), 'mine\n');
    await git(repo, ['add', 'mine.ts']);
    const done = await commitRecorded(repo, { add: ['a.md'], remove: [] }, 'chore: first', GIT_ENV);
    expect(done).toEqual(['a.md']);
    expect(await git(repo, ['ls-tree', '-r', '--name-only', 'HEAD'])).toBe('a.md\n');
    expect(await git(repo, ['status', '--porcelain'])).toBe('A  mine.ts\n');
    expect(await git(repo, ['symbolic-ref', '--short', 'HEAD'])).toBe('main\n');
  });

  it('commits nothing when the named files already match HEAD', async () => {
    const repo = await seededRepo({ 'README.md': 'r\n' });
    const before = await git(repo, ['rev-parse', 'HEAD']);
    const done = await commitRecorded(
      repo,
      { add: ['README.md'], remove: ['absent.md'] },
      'chore: none',
      GIT_ENV,
    );
    expect(done).toEqual([]);
    expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(before);
  });

  it('R2-4: a commit during a merge is still refused', async () => {
    const repo = await seededRepo({ 'README.md': 'r\n' });
    await git(repo, ['checkout', '-q', '-b', 'side']);
    await writeFile(path.join(repo, 'side.md'), 's\n');
    await git(repo, ['add', 'side.md']);
    await git(repo, ['commit', '-q', '-m', 'side']);
    await git(repo, ['checkout', '-q', 'main']);
    await writeFile(path.join(repo, 'main.md'), 'm\n');
    await git(repo, ['add', 'main.md']);
    await git(repo, ['commit', '-q', '-m', 'main']);
    await git(repo, ['merge', '--no-commit', '--no-ff', 'side']);
    await writeFile(path.join(repo, 'a.md'), 'a\n');
    await expect(
      commitRecorded(repo, { add: ['a.md'], remove: [] }, 'chore: x', GIT_ENV),
    ).rejects.toThrow(/merge/);
  });
});

describe('a git read that gave no answer stops the commit instead of reading as a negative', () => {
  async function repoWith(files: Record<string, string>, commit = true): Promise<string> {
    const repo = await mkdtemp(path.join(tmpdir(), 'commit-noanswer-'));
    dirs.push(repo);
    await git(repo, ['init', '-q', '-b', 'main']);
    await git(repo, ['config', 'gc.auto', '0']);
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
      await writeFile(path.join(repo, rel), body);
    }
    if (commit) {
      await git(repo, ['add', '-A']);
      await git(repo, ['commit', '-q', '-m', 'seed']);
    }
    return repo;
  }
  const collect = (repo: string) => collectOnboardingStagePaths(repo, {} as never, 't1');

  it('commitRecorded refuses when the MERGE_HEAD probe gave no answer, and HEAD stays', async () => {
    const repo = await repoWith({ 'a.md': 'base\n' });
    await git(repo, ['checkout', '-q', '-b', 'side']);
    await writeFile(path.join(repo, 'a.md'), 'side\n');
    await git(repo, ['commit', '-q', '-am', 'side']);
    await git(repo, ['checkout', '-q', 'main']);
    await writeFile(path.join(repo, 'a.md'), 'main\n');
    await git(repo, ['commit', '-q', '-am', 'main']);
    await git(repo, ['merge', 'side']).catch(() => undefined);
    await git(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
    await writeFile(path.join(repo, 'b.md'), 'b\n');
    const before = await git(repo, ['rev-parse', 'HEAD']);
    shim = await killGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
    await expect(
      commitRecorded(repo, { add: ['b.md'], remove: [] }, 'chore: x', GIT_ENV),
    ).rejects.toThrow(/could not check for a merge/);
    expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(before);
  });

  it('commitRecorded refuses when the CHERRY_PICK_HEAD probe gave no answer, and commits without the shim', async () => {
    const repo = await repoWith({ 'a.md': 'a\n' });
    await writeFile(path.join(repo, 'b.md'), 'b\n');
    shim = await killGit(['rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD']);
    await expect(
      commitRecorded(repo, { add: ['b.md'], remove: [] }, 'chore: x', GIT_ENV),
    ).rejects.toThrow(/could not check for a cherry/);
    await shim.restore();
    shim = null;
    expect(await commitRecorded(repo, { add: ['b.md'], remove: [] }, 'chore: x', GIT_ENV)).toEqual([
      'b.md',
    ]);
  });

  const quarantine = {
    '07-generate-files': {
      output: {
        quarantinedAgentFiles: [
          { from: '.claude/agents/mine.md', to: '.claude/agents-legacy/mine.md' },
        ],
      },
    },
  };

  it('a quarantine move is not dropped when the cat-file read gave no answer', async () => {
    const repo = await repoWith({ '.claude/agents/mine.md': 'm\n' });
    await mkdir(path.join(repo, '.claude', 'agents-legacy'), { recursive: true });
    await rename(
      path.join(repo, '.claude/agents/mine.md'),
      path.join(repo, '.claude/agents-legacy/mine.md'),
    );
    stepOutputs.current = quarantine;
    expect((await collect(repo)).remove).toContain('.claude/agents/mine.md');
    shim = await killGit(['cat-file', '-e']);
    await expect(collect(repo)).rejects.toThrow(/could not tell whether .* is in HEAD/);
  });

  it('an untracked quarantined agent is still not tracked (exit 128)', async () => {
    const repo = await repoWith({ 'README.md': 'r\n' });
    stepOutputs.current = quarantine;
    shim = await killGit(['ls-tree']);
    expect((await collect(repo)).remove).toEqual([]);
  });

  it('a legacy knowledge move is not dropped when the ls-tree read gave no answer', async () => {
    const repo = await repoWith({ '.claude/knowledge_base/A.md': 'a\n' });
    await rm(path.join(repo, '.claude/knowledge_base'), { recursive: true });
    stepOutputs.current = { '08-knowledge-acquisition': { output: { written: [] } } };
    expect((await collect(repo)).remove).toContain('.claude/knowledge_base/A.md');
    shim = await killGit(['ls-tree']);
    await expect(collect(repo)).rejects.toThrow(/could not list .* in HEAD/);
  });

  it('a legacy knowledge read on an unborn HEAD does not throw', async () => {
    const repo = await repoWith({ 'README.md': 'r\n' }, false);
    stepOutputs.current = { '08-knowledge-acquisition': { output: { written: [] } } };
    await expect(collect(repo)).resolves.toBeDefined();
  });

  it('a repaired skill removal is not dropped when the ls-tree read gave no answer', async () => {
    const repo = await repoWith({ '.claude/skills/a/sub-skills/stale.md': 's\n' });
    await rm(path.join(repo, '.claude/skills/a'), { recursive: true });
    stepOutputs.current = {
      '09_5b-skill-repair': {
        detect: { skillTargetDirs: ['.claude/skills'] },
        output: { repaired: ['a'] },
      },
    };
    expect((await collect(repo)).remove).toContain('.claude/skills/a/sub-skills/stale.md');
    shim = await killGit(['ls-tree']);
    await expect(collect(repo)).rejects.toThrow(/could not list .* in HEAD/);
  });

  it('dropIgnoredRulesFiles drops an ignored file, keeps a free one, and throws on no answer', async () => {
    const repo = await repoWith({ '.gitignore': 'CLAUDE.md\n' });
    await writeFile(path.join(repo, 'CLAUDE.md'), 'mine\n');
    await writeFile(path.join(repo, 'AGENTS.md'), 'free\n');
    const checked = new Set(['CLAUDE.md', 'AGENTS.md']);
    const done = await dropIgnoredRulesFiles(repo, ['CLAUDE.md', 'AGENTS.md'], checked);
    expect(done.keep).toEqual(['AGENTS.md']);
    expect(done.warnings).toHaveLength(1);
    shim = await killGit(['check-ignore']);
    await expect(dropIgnoredRulesFiles(repo, ['CLAUDE.md'], checked)).rejects.toThrow(
      /could not check whether CLAUDE.md is ignored/,
    );
  });
});

describe('the stage plan keeps a recorded path that names git data out of git', () => {
  // A record from before the writers refused git data still holds these: git rejects the alias
  // spellings outright and quietly adds nothing for the exact one.
  const GIT_DATA = [
    '.git/hooks/code-reviewer.md',
    '.GIT./hooks/code-reviewer.md',
    'git~1/hooks/code-reviewer.md',
  ];

  it('collectOnboardingStagePaths names none of them, whichever step output records it', async () => {
    const repo = await repoWithAgents();
    stepOutputs.current = {
      '07-generate-files': {
        output: {
          wroteFiles: [...GIT_DATA, 'sub/.git/hooks/x.md', '.claude/agents/code-reviewer.md'],
          quarantinedAgentFiles: [
            { from: '.git/hooks/old.md', to: '.git/hooks-legacy/old.md' },
            { from: 'sub/.git/old.md', to: 'sub/.git-legacy/old.md' },
          ],
        },
      },
      '08-knowledge-acquisition': {
        output: {
          written: [
            { filePath: path.join(repo, '.GIT./hooks/kb.md') },
            { filePath: path.join(repo, '.haive-data/knowledge_base/OVERVIEW.md') },
          ],
          removedPaths: [
            '.git/hooks/moved.md',
            '.GIT./moved.md',
            '.haive-data/knowledge_base/moved.md',
          ],
          mergedRemoved: ['.git/OLD'],
        },
      },
      '09_3-qa-review': { output: { kbWritten: [{ relPath: '.GIT./x' }, { relPath: 'ARCH' }] } },
      '09_5-skill-generation': {
        output: {
          written: [
            {
              id: 's1',
              mirroredDirs: ['.git/hooks', '.GIT./hooks', '.claude/skills'],
              subSkillSlugs: ['x'],
            },
          ],
        },
      },
      '09_5b-skill-repair': {
        detect: { skillTargetDirs: ['git~1/hooks', '.claude/skills'] },
        output: { repaired: ['s1'] },
      },
    };
    const plan = await collectOnboardingStagePaths(repo, {} as never, 't1');
    expect({ add: plan.add.sort(), remove: plan.remove.sort() }).toEqual({
      add: [
        '.claude/agents/code-reviewer.md',
        '.claude/skills/README.md',
        '.claude/skills/s1/SKILL.md',
        '.claude/skills/s1/sub-skills/x.md',
        '.haive-data/knowledge_base/ARCH.md',
        '.haive-data/knowledge_base/INDEX.md',
        '.haive-data/knowledge_base/OVERVIEW.md',
      ].sort(),
      remove: ['.haive-data/knowledge_base/moved.md'],
    });
    expect([...plan.add, ...plan.remove].filter(namesGitData)).toEqual([]);
  });

  it('12-post-onboarding commits the ordinary files when a record also names git data', async () => {
    const repo = await repoWithAgents();
    for (const rel of GIT_DATA) {
      await mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
      await writeFile(path.join(repo, rel), 'x\n');
    }
    const out = await postOnboardingStep.apply(
      mkCtx(repo, { wroteFiles: [...EXPECTED, ...GIT_DATA] }),
      {
        detected: { hasGit: true } as never,
        formValues: { commit: true, commitMessage: 'chore: onboard' },
        iteration: 0,
        previousIterations: [],
      },
    );
    expect(out.commitPerformed).toBe(true);
    expect(out.stagedPaths.filter((p) => p.startsWith('.claude/')).sort()).toEqual(EXPECTED);
    expect(out.stagedPaths.filter(namesGitData)).toEqual([]);
    const tree = (await git(repo, ['ls-tree', '-r', '-z', '--name-only', 'HEAD']))
      .split('\0')
      .filter(Boolean);
    expect(tree).not.toContain('.GIT./hooks/code-reviewer.md');
    expect(tree).not.toContain('git~1/hooks/code-reviewer.md');
    expect(tree.filter(namesGitData)).toEqual([]);
  });
});
