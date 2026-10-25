import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileNoFollow } from '@haive/shared/fs-safe';
import { KB_DIR } from '@haive/shared/knowledge-paths';
import type { StepContext } from '../src/step-engine/step-definition.js';
import { gitRun } from '../src/repo/git-exec.js';
import { commitKnowledgeTrees } from '../src/step-engine/steps/workflow/_kb-commit.js';
import { skillSyncStep } from '../src/step-engine/steps/workflow/11d-skill-sync.js';

const io = vi.hoisted(() => ({ leaf: '', code: '' }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    lstat: (...args: Parameters<typeof original.lstat>) => {
      // Inject the syscall error, allowing the real fs-safe readResult contract to decide
      // whether it is absence. Only the classifier's leaf lstat is affected.
      if (
        io.leaf &&
        /^\/proc\/self\/fd\/\d+\//.test(String(args[0])) &&
        String(args[0]).endsWith(`/${io.leaf}`)
      ) {
        throw Object.assign(new Error(`injected ${io.code}`), { code: io.code });
      }
      return original.lstat(...args);
    },
  };
});
vi.mock('../src/repo/git-exec.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/repo/git-exec.js')>();
  return { ...original, gitRun: vi.fn(original.gitRun) };
});
const { gitRun: realGitRun } =
  await vi.importActual<typeof import('../src/repo/git-exec.js')>('../src/repo/git-exec.js');
const identity = {
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
};
async function command(repo: string, args: string[]): Promise<string> {
  const result = await realGitRun(repo, args, identity);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
function context(repo: string): StepContext {
  return {
    workspacePath: repo,
    repoPath: repo,
    userId: 'u',
    taskId: 't',
    taskStepId: 's',
    logger: { info: vi.fn() },
    db: {
      query: {
        users: { findFirst: async () => null },
        tasks: { findFirst: async () => ({ repositoryId: null }) },
      },
    },
  } as unknown as StepContext;
}
const mutations = () =>
  vi.mocked(gitRun).mock.calls.filter(([, args]) => ['add', 'commit'].includes(args[0]!));
const knowledge = (workspace: string) =>
  commitKnowledgeTrees({ workspace, message: 'owned edits', ...context(workspace) });
const skills = (workspace: string) =>
  skillSyncStep.apply(context(workspace), {
    formValues: {},
    iteration: 0,
    previousIterations: [],
    detected: {
      worktreePath: workspace,
      targets: [],
      removals: ['already-removed'],
      skillTargetDirs: ['.claude/skills'],
      framework: 'general',
      language: 'typescript',
      kbFiles: [],
    },
  });

describe('scoped caller path refusals', () => {
  let fixture: string;
  let repo: string;
  beforeEach(async () => {
    io.leaf = '';
    io.code = '';
    fixture = await mkdtemp(path.join(tmpdir(), 'haive-scoped-refusal-'));
    repo = path.join(fixture, 'target');
    await mkdir(repo);
    await command(repo, ['init', '-q', '-b', 'main']);
    await writeFileNoFollow(repo, 'README.md', 'outside base\n');
    await writeFileNoFollow(repo, `${KB_DIR}/entry.md`, 'knowledge base\n', {
      createParents: true,
    });
    await writeFileNoFollow(
      repo,
      '.claude/skills/kept/SKILL.md',
      '---\nname: kept\ndescription: kept skill\n---\n\n# Kept\n\nA surviving skill.\n',
      { createParents: true },
    );
    await command(repo, ['add', '-A']);
    await command(repo, ['commit', '-qm', 'base']);
    await writeFileNoFollow(repo, 'README.md', 'outside staged\n');
    await command(repo, ['add', '--', 'README.md']);
    vi.mocked(gitRun).mockClear();
  });
  afterEach(async () => {
    io.leaf = '';
    io.code = '';
    await rm(fixture, { recursive: true, force: true });
  });

  it('rejects a redirected worktree before Git can change the other checkout', async () => {
    const anchor = path.join(fixture, 'trusted-repository');
    const parent = path.join(anchor, '.haive/worktrees');
    await mkdir(parent, { recursive: true });
    const workspace = path.join(parent, 'task');
    await symlink(repo, workspace);
    await writeFileNoFollow(repo, `${KB_DIR}/entry.md`, 'changed in another checkout\n');
    const head = await command(repo, ['rev-parse', 'HEAD']);
    const index = await command(repo, ['diff', '--cached']);

    const outcome = await knowledge(workspace).catch((error: unknown) => ({ error }));

    expect({
      outcome,
      mutations: mutations(),
      head: await command(repo, ['rev-parse', 'HEAD']),
      index: await command(repo, ['diff', '--cached']),
    }).toMatchObject({
      outcome: { error: { code: 'EPATHCONTAINMENT', reason: 'link' } },
      mutations: [],
      head,
      index,
    });
  });

  it('keeps a leaf knowledge-root symlink excluded instead of classifying it as absent', async () => {
    const other = path.join(fixture, 'other-knowledge');
    await mkdir(other);
    await writeFileNoFollow(other, 'entry.md', 'outside the repository\n');
    await rm(path.join(repo, KB_DIR), { recursive: true });
    await symlink(other, path.join(repo, KB_DIR));
    const head = await command(repo, ['rev-parse', 'HEAD']);
    const index = await command(repo, ['diff', '--cached']);

    expect(await knowledge(repo)).toMatchObject({ committed: false, commitSha: null });

    expect(mutations()).toEqual([]);
    expect(await command(repo, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await command(repo, ['diff', '--cached'])).toBe(index);
  });

  describe.each([
    { site: 'knowledge', apply: knowledge, leaf: 'knowledge_base', ownFile: `${KB_DIR}/entry.md` },
    { site: 'skills', apply: skills, leaf: 'skills', ownFile: '.claude/skills/kept/SKILL.md' },
  ])('$site classifier', ({ apply, leaf, ownFile }) => {
    it.each(['EACCES', 'EIO'])(
      'rejects a real fs-safe IO refusal (%s) before staging',
      async (code) => {
        await writeFileNoFollow(repo, ownFile, 'owned edit\n');
        const head = await command(repo, ['rev-parse', 'HEAD']);
        const index = await command(repo, ['diff', '--cached']);
        io.leaf = leaf;
        io.code = code;

        const outcome = await apply(repo).catch((error: unknown) => ({ error }));

        expect({
          outcome,
          mutations: mutations(),
          head: await command(repo, ['rev-parse', 'HEAD']),
          index: await command(repo, ['diff', '--cached']),
        }).toMatchObject({
          outcome: { error: { code } },
          mutations: [],
          head,
          index,
        });
      },
    );
  });
});
