import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileNoFollow } from '@haive/shared/fs-safe';
import { KB_DIR, LEARNINGS_DIR } from '@haive/shared/knowledge-paths';
import type { StepContext } from '../src/step-engine/step-definition.js';
import { gitRun, type GitRunResult } from '../src/repo/git-exec.js';
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

  const apply = async () => {
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

  beforeEach(async () => {
    control.result.mockReset();
    skillTargetDirs = ['.claude/skills'];
    repo = await mkdtemp(path.join(tmpdir(), 'haive-commit-wording-'));
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
    writes.length = 0;
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

    it.each([1, 128, 2, -1, 124])(
      'rejects a failed missing-root tracked read: %i',
      async (code) => {
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
      },
    );

    it.each([128, 2, -1, 124])('rejects a failed missing-root staged read: %i', async (code) => {
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

    it.each([128, 2, -1, 124])(
      'rejects a failed merge read even with scoped changes: %i',
      async (code) => {
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
      },
    );

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
    it('retains the intentional whole-index commit for session edits', async () => {
      await writeFileNoFollow(repo, 'README.md', 'session edits\n');
      await command(repo, ['add', '--', 'README.md']);

      expect(await apply()).toMatchObject({ committed: true, commitSha: expect.any(String) });

      expect(await command(repo, ['show', 'HEAD:README.md'])).toBe('session edits');
      expect(await command(repo, ['diff', '--cached', '--name-only'])).toBe('');
    });
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
    'reports an empty index with reworded commit %s (stubbed exit 1)',
    async (stream) => {
      control.result.mockImplementation((_cwd: string, args: string[]) =>
        args[0] === 'commit'
          ? { code: 1, stdout: '', stderr: '', [stream]: 'Aucun changement à enregistrer' }
          : undefined,
      );
      const head = await command(repo, ['rev-parse', 'HEAD']);
      const out = await apply();
      expect(out).toMatchObject({ committed: false, commitSha: null });
      if (site !== 'skill sync') expect(out).toHaveProperty('message', 'nothing to commit');
      if (site === 'run-app') expect(out).toMatchObject({ finished: true, pushed: false });
      if (site === 'skill sync') expect(out).toMatchObject({ removed: ['already-removed'] });
      expect(writes).toEqual([]);
      expect(await command(repo, ['rev-parse', 'HEAD'])).toBe(head);
    },
  );

  it.each([128, 2, -1, 124])('rejects a failed staged read with code %i', async (code) => {
    control.result.mockImplementation((_cwd: string, args: string[]): GitRunResult | undefined => {
      if (args[0] === 'diff' && args.includes('--cached') && args.includes('--quiet')) {
        return { code, stdout: '', stderr: 'staged read failed' };
      }
      if (args[0] === 'commit') return { code: 1, stdout: 'nothing to commit', stderr: '' };
      return undefined;
    });
    await expect(apply()).rejects.toThrow(/^git staged read failed:/);
    expect(writes).toEqual([]);
    expect(vi.mocked(gitRun).mock.calls.some(([, args]) => args[0] === 'commit')).toBe(false);
  });

  it.each([128, 2, -1, 124])('rejects a failed merge read with code %i', async (code) => {
    control.result.mockImplementation((_cwd: string, args: string[]): GitRunResult | undefined => {
      if (args[0] === 'rev-parse' && args.includes('MERGE_HEAD')) {
        return { code, stdout: '', stderr: 'opaque diagnostic' };
      }
      return undefined;
    });
    await expect(apply()).rejects.toThrow(/^git merge read failed:/);
    expect(writes).toEqual([]);
    expect(vi.mocked(gitRun).mock.calls.some(([, args]) => args[0] === 'commit')).toBe(false);
  });

  it('rejects a real commit failure even when its output mentions nothing to commit', async () => {
    const file =
      site === 'knowledge trees'
        ? `${KB_DIR}/entry.md`
        : site === 'skill sync'
          ? '.claude/skills/kept/SKILL.md'
          : 'README.md';
    await writeFileNoFollow(repo, file, 'changed\n');
    control.result.mockImplementation((_cwd: string, args: string[]) =>
      args[0] === 'commit'
        ? { code: 128, stdout: '', stderr: 'fatal: nothing to commit is not the failure here' }
        : undefined,
    );
    await expect(apply()).rejects.toThrow(/git commit failed/);
    expect(writes).toEqual([]);
  });
});
