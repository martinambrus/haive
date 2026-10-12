import { execFile } from 'node:child_process';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { schema } from '@haive/database';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StepContext } from '../src/step-engine/step-definition.js';
import { postOnboardingStep } from '../src/step-engine/steps/onboarding/12-post-onboarding.js';
import {
  collectOnboardingStagePaths,
  commitOnly,
  stageNamed,
  stagedChanges,
} from '../src/step-engine/steps/onboarding/_stage-paths.js';
import { REFERENCE_CONTEXT } from '../src/step-engine/template-manifest.js';
import { upgradeCommitStep } from '../src/step-engine/steps/onboarding-upgrade/03-upgrade-commit.js';

const stepOutputs = vi.hoisted(() => ({
  current: null as Record<string, { detect?: unknown; output?: unknown }> | null,
}));
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
afterEach(async () => {
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
      detected: { hasGit: true, currentBranch: 'main' } as never,
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
        detected: { hasGit: true, currentBranch: 'main' } as never,
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
        detected: { hasGit: true, currentBranch: 'main' } as never,
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

  const fakeDb = (artifactPaths: string[] = [], repositoryRow?: Record<string, unknown>) => {
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
    const transaction = async (run: (tx: unknown) => Promise<unknown>) => {
      if (++transactions === 1) throw new Error('database refused');
      await run({
        execute: async () => [],
        update: () => ({ set: () => ({ where: async () => [] }) }),
      });
    };
    return { select, transaction, query: new Proxy({}, { get: () => none }) };
  };

  const ctxFor = (
    repo: string,
    artifactPaths?: string[],
    repositoryRow?: Record<string, unknown>,
  ): StepContext =>
    ({
      repoPath: repo,
      workspacePath: repo,
      userId: 'u1',
      taskId: 't1',
      taskStepId: 's1',
      logger,
      db: fakeDb(artifactPaths, repositoryRow),
    }) as unknown as StepContext;

  async function twelve(
    repo: string,
    outputs: Outputs,
    artifactPaths: string[] = [],
    repositoryRow?: Record<string, unknown>,
  ) {
    stepOutputs.current = outputs;
    return postOnboardingStep.apply(ctxFor(repo, artifactPaths, repositoryRow), {
      detected: { hasGit: true, currentBranch: 'main' } as never,
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

  it('12 commits the whole tree of a repository with no git, as before', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'commit-scope-nogit-'));
    dirs.push(repo);
    await put(repo, { 'src/a.ts': 'x\n', '.claude/agents/a.md': 'a\n' });
    stepOutputs.current = {
      '07-generate-files': { output: { wroteFiles: ['.claude/agents/a.md'], skippedFiles: [] } },
    };
    const out = await postOnboardingStep.apply(ctxFor(repo), {
      detected: { hasGit: false, currentBranch: null } as never,
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

  it('9: 12 commits the project state files a failed record write left on disk', async () => {
    const repo = await seeded();
    await put(repo, { '.claude/agents/a.md': 'a\n' });
    const out = await twelve(repo, {
      '07-generate-files': {
        detect: { ...(REFERENCE_CONTEXT as unknown as Record<string, unknown>) },
        output: { wroteFiles: ['.claude/agents/a.md'], skippedFiles: [] },
      },
    });
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

describe('commitOnly commits the entries that were staged, not the worktree', () => {
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

  it('R2-1: a named file that changes after staging is committed as it was staged', async () => {
    const repo = await seededRepo({ 'README.md': 'r\n', '.haive-data/plan.json': 'v0\n' });
    await writeFile(path.join(repo, '.haive-data', 'plan.json'), 'staged\n');
    await writeFile(path.join(repo, 'mine.ts'), 'mine\n');
    await git(repo, ['add', 'mine.ts']);
    const named = ['.haive-data/plan.json'];
    await stageNamed(repo, named, []);
    await writeFile(path.join(repo, '.haive-data', 'plan.json'), 'swept\n');
    await commitOnly(repo, await stagedChanges(repo, named), 'chore: onboard', GIT_ENV);
    expect(await git(repo, ['show', 'HEAD:.haive-data/plan.json'])).toBe('staged\n');
    expect((await git(repo, ['show', '--name-only', '--format=', 'HEAD'])).trim()).toBe(
      '.haive-data/plan.json',
    );
    expect(await git(repo, ['log', '-1', '--format=%s'])).toBe('chore: onboard\n');
    expect((await git(repo, ['diff', '--cached', '--name-only'])).trim()).toBe('mine.ts');
    expect(await git(repo, ['status', '--porcelain', '--', '.haive-data/plan.json'])).toBe(
      ' M .haive-data/plan.json\n',
    );
    expect(await readFile(path.join(repo, '.haive-data', 'plan.json'), 'utf8')).toBe('swept\n');
  });

  it('a directory standing at a recorded file path is never staged', async () => {
    const repo = await seededRepo({ 'README.md': 'r\n' });
    await mkdir(path.join(repo, '.haive-data', 'plan.json'), { recursive: true });
    await writeFile(path.join(repo, '.haive-data', 'plan.json', 'private.md'), 'p\n');
    await writeFile(path.join(repo, 'a.md'), 'a\n');
    await stageNamed(repo, ['.haive-data/plan.json', 'a.md'], []);
    expect((await git(repo, ['diff', '--cached', '--name-only'])).trim()).toBe('a.md');
  });

  it('a file the person staged under a directory standing at a named path is not committed', async () => {
    const repo = await seededRepo({ 'README.md': 'r\n' });
    await mkdir(path.join(repo, '.haive', 'install.json'), { recursive: true });
    await writeFile(path.join(repo, '.haive', 'install.json', 'private.md'), 'p\n');
    await git(repo, ['add', '-f', '.haive/install.json/private.md']);
    await writeFile(path.join(repo, 'a.md'), 'a\n');
    const named = ['.haive/install.json', 'a.md'];
    await stageNamed(repo, named, []);
    const staged = await stagedChanges(repo, named);
    expect(staged).toEqual(['a.md']);
    await commitOnly(repo, staged, 'chore: onboard', GIT_ENV);
    expect((await git(repo, ['show', '--name-only', '--format=', 'HEAD'])).trim()).toBe('a.md');
    expect((await git(repo, ['diff', '--cached', '--name-only'])).trim()).toBe(
      '.haive/install.json/private.md',
    );
  });

  it('R2-2: a staged removal is committed even when the file is back on disk', async () => {
    const repo = await seededRepo({ 'README.md': 'r\n', 'gone.md': 'g\n', 'keep.md': 'k\n' });
    await rm(path.join(repo, 'gone.md'));
    await writeFile(path.join(repo, 'src.ts'), 's\n');
    await git(repo, ['add', 'src.ts']);
    await stageNamed(repo, [], ['gone.md']);
    const named = ['gone.md'];
    await writeFile(path.join(repo, 'gone.md'), 'back\n');
    await commitOnly(repo, await stagedChanges(repo, named), 'chore: drop', GIT_ENV);
    expect(await git(repo, ['ls-tree', '-r', '--name-only', 'HEAD'])).not.toContain('gone.md');
    expect(await git(repo, ['ls-tree', '-r', '--name-only', 'HEAD'])).toContain('keep.md');
    expect((await git(repo, ['diff', '--cached', '--name-only'])).trim()).toBe('src.ts');
  });

  it('R2-3: the first commit of a repository with no commit holds the staged entry only', async () => {
    const repo = await seededRepo({});
    await writeFile(path.join(repo, 'a.md'), 'staged\n');
    await writeFile(path.join(repo, 'mine.ts'), 'mine\n');
    await git(repo, ['add', 'mine.ts']);
    await stageNamed(repo, ['a.md'], []);
    await writeFile(path.join(repo, 'a.md'), 'later\n');
    await commitOnly(repo, await stagedChanges(repo, ['a.md']), 'chore: first', GIT_ENV);
    expect(await git(repo, ['show', 'HEAD:a.md'])).toBe('staged\n');
    expect(await git(repo, ['ls-tree', '-r', '--name-only', 'HEAD'])).toBe('a.md\n');
    expect((await git(repo, ['diff', '--cached', '--name-only'])).trim()).toBe('mine.ts');
    expect(await git(repo, ['symbolic-ref', '--short', 'HEAD'])).toBe('main\n');
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
    await stageNamed(repo, ['a.md'], []);
    await expect(commitOnly(repo, ['a.md'], 'chore: x', GIT_ENV)).rejects.toThrow(/merge/);
  });
});
