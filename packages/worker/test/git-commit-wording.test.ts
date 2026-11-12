import { gitTemplate } from './support/git-template.js';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileNoFollow } from '@haive/shared/fs-safe';
import { KB_DIR, LEARNINGS_DIR } from '@haive/shared/knowledge-paths';
import type { StepContext } from '../src/step-engine/step-definition.js';
import { gitRun, type GitRunResult } from '../src/repo/git-exec.js';
import { gitPreview, type GitPreview } from '../src/repo/git-preview.js';
import { commitKnowledgeTrees } from '../src/step-engine/steps/workflow/_kb-commit.js';
import { gate3CommitStep } from '../src/step-engine/steps/workflow/10-gate-3-commit.js';
import { skillSyncStep } from '../src/step-engine/steps/workflow/11d-skill-sync.js';
import { runAppReadyStep } from '../src/step-engine/steps/run-app/99-run-app-ready.js';

const control = vi.hoisted(() => ({ result: vi.fn() }));
vi.mock('../src/repo/git-exec.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/repo/git-exec.js')>();
  return {
    ...original,
    gitRun: vi.fn(
      (...args: Parameters<typeof original.gitRun>) =>
        control.result(...args) ?? original.gitRun(...args),
    ),
  };
});

const { gitRun: realGitRun } =
  await vi.importActual<typeof import('../src/repo/git-exec.js')>('../src/repo/git-exec.js');
const identity = {
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
};
const command = async (repo: string, args: string[]) => {
  const result = await realGitRun(repo, args, identity);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
};

function context(repo: string): { ctx: StepContext; writes: unknown[] } {
  const writes: unknown[] = [];
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => [],
  };
  const ctx = {
    workspacePath: repo,
    repoPath: repo,
    userId: 'u',
    taskId: 't',
    taskStepId: 's',
    logger: { info: vi.fn(), warn: vi.fn() },
    db: {
      select: () => chain,
      query: {
        users: { findFirst: async () => null },
        tasks: { findFirst: async () => ({ repositoryId: null, changedPaths: [] }) },
      },
      update: () => ({
        set: (value: unknown) => {
          writes.push(value);
          return { where: async () => undefined };
        },
      }),
    },
  } as unknown as StepContext;
  return { ctx, writes };
}

const sites = ['knowledge trees', 'gate 3', 'skill sync', 'run-app'] as const;
describe.each(sites)('%s commit decisions', (site) => {
  let repo: string;
  let ctx: StepContext;
  let writes: unknown[];
  let skillTargetDirs: string[];

  const apply = async (preview?: GitPreview) => {
    const common = {
      formValues: { commit: true, commitMessage: 'test commit' },
      iteration: 0,
      previousIterations: [],
    };
    switch (site) {
      case 'knowledge trees':
        return commitKnowledgeTrees({ workspace: repo, message: 'test commit', ...ctx });
      case 'gate 3':
        return gate3CommitStep.apply(ctx, {
          ...common,
          detected: {
            hasGit: true,
            workspacePath: repo,
            diffSummary: '',
            dirtyFiles: 0,
            diffArtifactPath: null,
            changedFileCount: 0,
            diffArtifactTruncated: false,
          },
        });
      case 'skill sync':
        // Repeating an approved removal leaves the surviving skill and its index unchanged.
        return skillSyncStep.apply(ctx, {
          ...common,
          detected: {
            worktreePath: repo,
            targets: [],
            removals: ['already-removed'],
            skillTargetDirs,
            framework: 'general',
            language: 'typescript',
            kbFiles: [],
          },
        });
      case 'run-app':
        return runAppReadyStep.apply(ctx, {
          ...common,
          detected: {
            hasGit: true,
            workspacePath: repo,
            hasOrigin: false,
            commitPreview: preview ?? (await gitPreview(repo)),
            branch: 'main',
            mode: 'none',
            appUrl: null,
            liveBrowser: null,
            directAccess: false,
            dbAccess: false,
            dirtyFiles: 0,
            diffArtifactPath: null,
            changedFileCount: 0,
          },
        });
    }
  };

  const template = gitTemplate(async (dir) => {
    repo = dir;
    skillTargetDirs = ['.claude/skills'];
    ({ ctx, writes } = context(repo));
    await command(repo, ['init', '-q', '-b', 'main']);
    await writeFileNoFollow(repo, 'README.md', 'base\n');
    await writeFileNoFollow(repo, `${KB_DIR}/entry.md`, 'knowledge\n', { createParents: true });
    await writeFileNoFollow(
      repo,
      '.claude/skills/kept/SKILL.md',
      '---\nname: kept\ndescription: kept skill\n---\n\n# Kept\n\nA surviving skill.\n',
      { createParents: true },
    );
    await command(repo, ['add', '-A']);
    await command(repo, ['commit', '-qm', 'base']);
    if (site === 'skill sync') await apply(); // Materialise and commit the stable README index.
  });
  beforeEach(async () => {
    control.result.mockReset();
    skillTargetDirs = ['.claude/skills'];
    repo = (await template.copy()).dir;
    ({ ctx, writes } = context(repo));
    vi.mocked(gitRun).mockClear();
  });

  afterEach(async () => {
    control.result.mockReset();
    await rm(repo, { recursive: true, force: true });
  });

  if (site === 'knowledge trees' || site === 'skill sync') {
    it('scoped control: leaves an outside staged file out of the commit and staged afterwards', async () => {
      const ownFile =
        site === 'knowledge trees' ? `${KB_DIR}/entry.md` : '.claude/skills/kept/SKILL.md';
      await writeFileNoFollow(repo, ownFile, 'changed\n');
      await writeFileNoFollow(repo, 'README.md', 'personal staged work\n');
      await command(repo, ['add', '--', 'README.md']);
      await writeFileNoFollow(repo, 'README.md', 'personal unstaged work\n');

      const out = await apply();

      expect(out).toMatchObject({ committed: true, commitSha: expect.any(String) });
      expect(await command(repo, ['show', 'HEAD:README.md'])).toBe('base');
      expect(await command(repo, ['diff', '--cached', '--name-only'])).toBe('README.md');
      expect(await command(repo, ['show', ':README.md'])).toBe('personal staged work');
      expect(await command(repo, ['diff', '--name-only'])).toBe('README.md');
      expect(await command(repo, ['show', `HEAD:${ownFile}`])).toBe('changed');
    });

    it.each([
      { staged: true, survivingEdit: false },
      { staged: true, survivingEdit: true },
      { staged: false, survivingEdit: false },
      { staged: false, survivingEdit: true },
    ])(
      'commits a deleted owned root with staged=$staged and survivingEdit=$survivingEdit',
      async ({ staged, survivingEdit }) => {
        const removedRoot = site === 'knowledge trees' ? LEARNINGS_DIR : '.gemini/skills';
        const removedFile = `${removedRoot}/old/SKILL.md`;
        const survivingFile =
          site === 'knowledge trees' ? `${KB_DIR}/entry.md` : '.claude/skills/kept/SKILL.md';
        await writeFileNoFollow(repo, removedFile, 'old owned content\n', { createParents: true });
        await command(repo, ['add', '--', removedRoot]);
        await command(repo, ['commit', '-qm', 'second owned root']);
        if (site === 'skill sync') skillTargetDirs.push(removedRoot);
        if (staged) await command(repo, ['rm', '-r', '--', removedRoot]);
        else await rm(path.join(repo, removedRoot), { recursive: true });
        if (survivingEdit) await writeFileNoFollow(repo, survivingFile, 'changed\n');
        await writeFileNoFollow(repo, 'README.md', 'personal staged work\n');
        await command(repo, ['add', '--', 'README.md']);
        await writeFileNoFollow(repo, 'README.md', 'personal unstaged work\n');

        expect(await apply()).toMatchObject({ committed: true, commitSha: expect.any(String) });

        expect(
          await command(repo, ['ls-tree', '-r', '--name-only', 'HEAD', '--', removedRoot]),
        ).toBe('');
        expect(await command(repo, ['show', 'HEAD:README.md'])).toBe('base');
        expect(await command(repo, ['show', ':README.md'])).toBe('personal staged work');
        expect(await command(repo, ['diff', '--cached', '--name-only'])).toBe('README.md');
        expect(await command(repo, ['diff', '--name-only'])).toBe('README.md');
        if (survivingEdit)
          expect(await command(repo, ['show', `HEAD:${survivingFile}`])).toBe('changed');
        const head = await command(repo, ['rev-parse', 'HEAD']);
        expect(await apply()).toMatchObject({ committed: false, commitSha: null });
        expect(await command(repo, ['rev-parse', 'HEAD'])).toBe(head);
        expect(await command(repo, ['diff', '--cached', '--name-only'])).toBe('README.md');
      },
    );

    it.each([false, true])(
      'commits when every owned root is deleted (staged: %s)',
      async (staged) => {
        const root = site === 'knowledge trees' ? KB_DIR : '.claude/skills';
        if (staged) await command(repo, ['rm', '-r', '--', root]);
        else await rm(path.join(repo, root), { recursive: true });
        await writeFileNoFollow(repo, 'README.md', 'personal staged work\n');
        await command(repo, ['add', '--', 'README.md']);

        expect(await apply()).toMatchObject({ committed: true, commitSha: expect.any(String) });
        expect(await command(repo, ['ls-tree', '-r', '--name-only', 'HEAD', '--', root])).toBe('');
        expect(await command(repo, ['diff', '--cached', '--name-only'])).toBe('README.md');
        const head = await command(repo, ['rev-parse', 'HEAD']);
        expect(await apply()).toMatchObject({ committed: false, commitSha: null });
        expect(await command(repo, ['rev-parse', 'HEAD'])).toBe(head);
        expect(await command(repo, ['diff', '--cached', '--name-only'])).toBe('README.md');
      },
    );

    // Exit-code variants are covered without git in git-commit-decisions.test.ts.
    // Keep one real checkout per caller/behaviour to prove propagation and no writes.
    it.each([128])('rejects a failed missing-root tracked read: %i', async (code) => {
      if (site === 'skill sync') skillTargetDirs.push('.gemini/skills');
      control.result.mockImplementation((_cwd: string, args: string[]) =>
        args[0] === 'ls-files'
          ? { code, stdout: 'not a successful read', stderr: 'opaque diagnostic' }
          : undefined,
      );

      await expect(apply()).rejects.toThrow(/^git tracked paths read failed:/);
      expect(
        vi.mocked(gitRun).mock.calls.some(([, args]) => ['add', 'commit'].includes(args[0]!)),
      ).toBe(false);
    });

    it.each([128])('rejects a failed missing-root staged read: %i', async (code) => {
      if (site === 'skill sync') skillTargetDirs.push('.gemini/skills');
      control.result.mockImplementation((_cwd: string, args: string[]) =>
        args[0] === 'diff' && args.includes('--cached') && args.includes('--quiet')
          ? { code, stdout: '', stderr: 'opaque diagnostic' }
          : undefined,
      );

      await expect(apply()).rejects.toThrow(/^git staged read failed:/);
      expect(
        vi.mocked(gitRun).mock.calls.some(([, args]) => ['add', 'commit'].includes(args[0]!)),
      ).toBe(false);
    });

    it.each([128])('rejects a failed merge read even with scoped changes: %i', async (code) => {
      const ownFile =
        site === 'knowledge trees' ? `${KB_DIR}/entry.md` : '.claude/skills/kept/SKILL.md';
      await writeFileNoFollow(repo, ownFile, 'changed\n');
      control.result.mockImplementation((_cwd: string, args: string[]) =>
        args[0] === 'rev-parse' && args.includes('MERGE_HEAD')
          ? { code, stdout: '', stderr: 'opaque diagnostic' }
          : undefined,
      );
      await expect(apply()).rejects.toThrow(/^git merge read failed:/);
      expect(vi.mocked(gitRun).mock.calls.some(([, args]) => args[0] === 'commit')).toBe(false);
    });

    it('leaves an open merge alone even with no changes in its own paths', async () => {
      await command(repo, ['checkout', '-q', '-b', 'side']);
      await command(repo, ['commit', '-q', '--allow-empty', '-m', 'side']);
      const side = await command(repo, ['rev-parse', 'HEAD']);
      await command(repo, ['checkout', '-q', 'main']);
      await command(repo, ['commit', '-q', '--allow-empty', '-m', 'main']);
      const head = await command(repo, ['rev-parse', 'HEAD']);
      await command(repo, ['merge', '--no-commit', '--no-ff', 'side']);

      await expect(apply()).rejects.toThrow(/open merge/);

      expect(await command(repo, ['rev-parse', 'HEAD'])).toBe(head);
      expect(await command(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).toBe(side);
    });

    it('leaves outside staged work alone when its own paths are unchanged', async () => {
      const head = await command(repo, ['rev-parse', 'HEAD']);
      await writeFileNoFollow(repo, 'README.md', 'personal staged work\n');
      await command(repo, ['add', '--', 'README.md']);

      expect(await apply()).toMatchObject({ committed: false, commitSha: null });

      expect(await command(repo, ['rev-parse', 'HEAD'])).toBe(head);
      expect(await command(repo, ['diff', '--cached', '--name-only'])).toBe('README.md');
    });
  } else {
    it(
      site === 'run-app'
        ? 'commits all reviewed session edits and leaves later staged work alone'
        : 'retains the intentional whole-index commit for session edits',
      async () => {
        await writeFileNoFollow(repo, 'README.md', 'session edits\n');
        await command(repo, ['add', '--', 'README.md']);

        let preview: GitPreview | undefined;
        if (site === 'run-app') {
          await writeFileNoFollow(repo, 'reviewed.txt', 'reviewed session edit\n');
          preview = await gitPreview(repo);
          await writeFileNoFollow(repo, 'late.txt', 'later staged work\n');
          await command(repo, ['add', '--', 'late.txt']);
        }
        expect(await apply(preview)).toMatchObject({
          committed: true,
          commitSha: expect.any(String),
        });

        expect(await command(repo, ['show', 'HEAD:README.md'])).toBe('session edits');
        expect(await command(repo, ['diff', '--cached', '--name-only'])).toBe(
          site === 'run-app' ? 'late.txt' : '',
        );
        if (site === 'run-app') {
          expect(await command(repo, ['show', 'HEAD:reviewed.txt'])).toBe('reviewed session edit');
          expect(await command(repo, ['ls-tree', '--name-only', 'HEAD', '--', 'late.txt'])).toBe(
            '',
          );
          expect(await command(repo, ['show', ':late.txt'])).toBe('later staged work');
        }
      },
    );
  }

  if (site === 'knowledge trees') {
    it('scoped control: reports nothing to commit when only an outside file is staged', async () => {
      const head = await command(repo, ['rev-parse', 'HEAD']);
      await writeFileNoFollow(repo, 'README.md', 'personal staged work\n');
      await command(repo, ['add', '--', 'README.md']);

      expect(await apply()).toMatchObject({
        committed: false,
        commitSha: null,
        message: 'nothing to commit',
      });
      expect(await command(repo, ['rev-parse', 'HEAD'])).toBe(head);
      expect(await command(repo, ['diff', '--cached', '--name-only'])).toBe('README.md');
    });

    it('scoped control: refuses an open merge instead of concluding it', async () => {
      await command(repo, ['checkout', '-q', '-b', 'side']);
      await command(repo, ['commit', '-q', '--allow-empty', '-m', 'side']);
      const side = await command(repo, ['rev-parse', 'HEAD']);
      await command(repo, ['checkout', '-q', 'main']);
      await command(repo, ['commit', '-q', '--allow-empty', '-m', 'main']);
      const head = await command(repo, ['rev-parse', 'HEAD']);
      await command(repo, ['merge', '--no-commit', '--no-ff', 'side']);
      await writeFileNoFollow(repo, `${KB_DIR}/entry.md`, 'changed\n');

      await expect(apply()).rejects.toThrow(/open merge/);

      expect(await command(repo, ['rev-parse', 'HEAD'])).toBe(head);
      expect(await command(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).toBe(side);
      expect(await command(repo, ['diff', '--cached', '--name-only'])).toBe(`${KB_DIR}/entry.md`);
    });
  }

  it.each(['stdout', 'stderr'] as const)(
    site === 'run-app'
      ? 'reports an empty preview without invoking commit plumbing (reworded %s, exit 1)'
      : 'reports an empty index with reworded commit %s (stubbed exit 1)',
    async (stream) => {
      control.result.mockImplementation((_cwd: string, args: string[]) =>
        ['commit', 'commit-tree'].includes(args[0]!)
          ? { code: 1, stdout: '', stderr: '', [stream]: 'Aucun changement à enregistrer' }
          : undefined,
      );
      const head = await command(repo, ['rev-parse', 'HEAD']);
      const out = await apply();
      expect(out).toMatchObject({ committed: false, commitSha: null });
      if (site !== 'skill sync') expect(out).toHaveProperty('message', 'nothing to commit');
      if (site === 'run-app') {
        expect(out).toMatchObject({ finished: true, pushed: false });
        expect(
          vi
            .mocked(gitRun)
            .mock.calls.some(([, args]) =>
              ['commit', 'commit-tree', 'update-ref'].includes(args[0]!),
            ),
        ).toBe(false);
      }
      if (site === 'skill sync') expect(out).toMatchObject({ removed: ['already-removed'] });
      expect(writes).toEqual([]);
      expect(await command(repo, ['rev-parse', 'HEAD'])).toBe(head);
    },
  );

  // Run-app's pinned-tree write fence replaces gitCommitStaged's index read.
  it.each(site === 'run-app' ? [128, 2, -1, 124] : [128])(
    site === 'run-app'
      ? 'rejects a failed preview ref update with code %i'
      : 'rejects a failed staged read with code %i',
    async (code) => {
      if (site === 'run-app') await writeFileNoFollow(repo, 'README.md', 'session edits\n');
      const head = await command(repo, ['rev-parse', 'HEAD']);
      control.result.mockImplementation(
        (_cwd: string, args: string[]): GitRunResult | undefined => {
          if (
            site === 'run-app'
              ? args[0] === 'update-ref'
              : args[0] === 'diff' && args.includes('--cached') && args.includes('--quiet')
          ) {
            return { code, stdout: '', stderr: 'staged read failed' };
          }
          if (args[0] === 'commit') return { code: 1, stdout: 'nothing to commit', stderr: '' };
          return undefined;
        },
      );
      await expect(apply()).rejects.toThrow(
        site === 'run-app' ? /^git update-ref failed:/ : /^git staged read failed:/,
      );
      expect(await command(repo, ['rev-parse', 'HEAD'])).toBe(head);
      expect(writes).toEqual([]);
      expect(vi.mocked(gitRun).mock.calls.some(([, args]) => args[0] === 'commit')).toBe(false);
      if (site === 'run-app') {
        expect(vi.mocked(gitRun).mock.calls.some(([, args]) => args[0] === 'commit-tree')).toBe(
          true,
        );
        expect(vi.mocked(gitRun).mock.calls.some(([, args]) => args[0] === 'reset')).toBe(false);
      }
    },
  );

  it.each(site === 'run-app' ? [128, 2, -1, 124] : [128])(
    'rejects a failed merge read with code %i',
    async (code) => {
      if (site === 'run-app') await writeFileNoFollow(repo, 'README.md', 'session edits\n');
      const head = await command(repo, ['rev-parse', 'HEAD']);
      control.result.mockImplementation(
        (_cwd: string, args: string[]): GitRunResult | undefined => {
          if (args[0] === 'rev-parse' && args.includes('MERGE_HEAD')) {
            return { code, stdout: '', stderr: 'opaque diagnostic' };
          }
          return undefined;
        },
      );
      await expect(apply()).rejects.toThrow(/^git merge read failed:/);
      expect(await command(repo, ['rev-parse', 'HEAD'])).toBe(head);
      expect(writes).toEqual([]);
      expect(vi.mocked(gitRun).mock.calls.some(([, args]) => args[0] === 'commit')).toBe(false);
      expect(vi.mocked(gitRun).mock.calls.some(([, args]) => args[0] === 'commit-tree')).toBe(
        false,
      );
    },
  );

  it('rejects a real commit failure even when its output mentions nothing to commit', async () => {
    const file =
      site === 'knowledge trees'
        ? `${KB_DIR}/entry.md`
        : site === 'skill sync'
          ? '.claude/skills/kept/SKILL.md'
          : 'README.md';
    await writeFileNoFollow(repo, file, 'changed\n');
    control.result.mockImplementation((_cwd: string, args: string[]) =>
      args[0] === (site === 'run-app' ? 'commit-tree' : 'commit')
        ? { code: 128, stdout: '', stderr: 'fatal: nothing to commit is not the failure here' }
        : undefined,
    );
    await expect(apply()).rejects.toThrow(
      site === 'run-app' ? /git preview commit failed/ : /git commit failed/,
    );
    expect(writes).toEqual([]);
  });
});
