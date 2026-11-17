import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateComposition } from '@haive/shared/modularity';
import type { StepContext } from '../src/step-engine/step-definition.js';
import { StepRegistry } from '../src/step-engine/registry.js';
import { registerAllSteps } from '../src/step-engine/steps/index.js';
import { CORE_COMPOSABLE_STEPS } from '../src/step-engine/composable-core.js';
import * as fsSafe from '@haive/shared/fs-safe';
import { discardNoChangeCleanupDirectories } from '../src/step-engine/no-change-cleanup.js';

const state = vi.hoisted(() => ({ setup: {} as Record<string, unknown> }));
vi.mock('../src/step-engine/steps/onboarding/_helpers.js', async (original) => ({
  ...(await original<object>()),
  loadPreviousStepOutput: async () => ({ output: state.setup }),
}));

const ID = '12-no-change-cleanup';
const git = (cwd: string, ...args: string[]) =>
  execFileSync('/usr/bin/git', args, { cwd, stdio: 'pipe' }).toString().trim();
function snapshot(dir: string): string {
  const hash = createHash('sha256');
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const file = join(at, entry.name);
      hash.update(file.slice(dir.length));
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) hash.update(readFileSync(file));
    }
  };
  walk(dir);
  return hash.digest('hex');
}

describe('no-change cleanup with real Git', () => {
  let template: string;
  let root: string;
  let tree: string;
  let ctx: StepContext;
  let events: { payload: unknown }[];
  const registry = new StepRegistry();
  registerAllSteps(registry);
  const step = () => registry.require(ID);
  const run = async () =>
    step().apply(ctx, {
      detected: await step().detect!(ctx),
      formValues: {},
      iteration: 0,
      previousIterations: [],
    });
  const preserved = async (reason: RegExp) => {
    const before = snapshot(root);
    await expect(run()).rejects.toThrow(reason);
    expect(snapshot(root)).toBe(before);
    expect(events).toEqual([]);
  };

  beforeAll(() => {
    template = mkdtempSync(join(tmpdir(), 'no-change-template-'));
    git(template, 'init', '-q', '-b', 'main');
    git(template, 'config', 'user.name', 'Test');
    git(template, 'config', 'user.email', 'test@example.com');
    git(template, 'config', 'gc.auto', '0');
    writeFileSync(join(template, 'a'), 'base\n');
    writeFileSync(join(template, '.gitignore'), '.haive/\n');
    git(template, 'add', '.');
    git(template, 'commit', '-qm', 'base');
  });
  afterAll(() => rmSync(template, { recursive: true, force: true }));
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'no-change-cleanup-'));
    cpSync(template, root, { recursive: true });
    tree = join(root, '.haive/worktrees/task');
    git(root, 'worktree', 'add', '-qb', 'task', tree, 'main');
    state.setup = { mode: 'worktree', worktreePath: tree, branchName: 'task', baseBranch: 'main' };
    events = [];
    const query = {
      tasks: { findFirst: async () => null },
      taskEvents: { findMany: async () => [...events].reverse() },
    };
    const select = () => {
      const builder = {
        from: () => builder,
        where: () => builder,
        for: async () => [{ id: 'step' }],
      };
      return builder;
    };
    const db = {
      query,
      select,
      insert: () => ({
        values: async (event: { payload: unknown }) => {
          events.push(event);
        },
      }),
      transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    };
    ctx = {
      taskId: 'task',
      taskStepId: 'step',
      repoPath: root,
      workspacePath: tree,
      db,
      throwIfCancelled: () => undefined,
    } as unknown as StepContext;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('removes the worktree and branch, without moving the base, then replays', async () => {
    const base = git(root, 'rev-parse', 'main');
    expect(await run()).toMatchObject({ removed: true, branchDeleted: true });
    expect(existsSync(tree)).toBe(false);
    expect(git(root, 'branch', '--list', 'task')).toBe('');
    expect(git(root, 'rev-parse', 'main')).toBe(base);
    expect(git(root, 'worktree', 'list', '--porcelain')).not.toContain(tree);
    expect(await run()).toMatchObject({ removed: true, branchDeleted: true });
  });
  it.each(['tracked', 'staged', 'untracked'])(
    'refuses %s changes without changing anything',
    async (kind) => {
      writeFileSync(join(tree, kind === 'untracked' ? 'new' : 'a'), 'changed\n');
      if (kind === 'staged') git(tree, 'add', 'a');
      await preserved(/the worktree holds uncommitted/);
    },
  );
  it.each([
    'MERGE_HEAD',
    'REBASE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'rebase-merge',
    'rebase-apply',
    'sequencer',
  ])('refuses an open %s without changing anything', async (marker) => {
    const file = git(tree, 'rev-parse', '--git-path', marker);
    if (marker.startsWith('rebase-') || marker === 'sequencer') mkdirSync(file);
    else writeFileSync(file, git(root, 'rev-parse', 'main') + '\n');
    await preserved(/a Git operation is open/);
  });
  it('refuses branch commits not contained in base', async () => {
    writeFileSync(join(tree, 'a'), 'own\n');
    git(tree, 'commit', '-qam', 'own');
    await preserved(/branch commits are not contained in the base/);
  });
  it('refuses an unreadable index', async () => {
    writeFileSync(git(tree, 'rev-parse', '--git-path', 'index'), 'broken');
    await preserved(/the worktree is unreadable/);
  });
  it('refuses a missing gitfile rather than discovering the parent repo', async () => {
    rmSync(join(tree, '.git'));
    await preserved(/the worktree gitfile is unreadable/);
  });
  it('refuses a symlink at the worktree path', async () => {
    const saved = tree + '-saved';
    cpSync(tree, saved, { recursive: true });
    rmSync(tree, { recursive: true });
    symlinkSync(saved, tree);
    await preserved(/the worktree path is not a readable directory/);
  });
  it.each(['--assume-unchanged', '--skip-worktree'])(
    'refuses hidden index entries (%s)',
    async (flag) => {
      git(tree, 'update-index', flag, 'a');
      await preserved(/the worktree is unreadable/);
    },
  );
  it('allows an advanced base that contains the branch', async () => {
    writeFileSync(join(root, 'a'), 'advanced\n');
    git(root, 'commit', '-qam', 'advance');
    expect(await run()).toMatchObject({ removed: true, branchDeleted: true });
  });
  it('allows branch commits already contained in the base', async () => {
    writeFileSync(join(tree, 'a'), 'landed\n');
    git(tree, 'commit', '-qam', 'landed');
    git(root, 'merge', '--ff-only', 'task');
    expect(await run()).toMatchObject({ removed: true, branchDeleted: true });
  });
  it('resumes with worktree gone and branch present', async () => {
    rmSync(tree, { recursive: true });
    expect(await run()).toMatchObject({ removed: true, branchDeleted: true });
  });
  it('resumes with branch gone and worktree present', async () => {
    git(root, 'update-ref', '-d', 'refs/heads/task');
    expect(await run()).toMatchObject({ removed: true, branchDeleted: true });
  });
  it('still refuses dirty work after the branch is gone', async () => {
    git(root, 'update-ref', '-d', 'refs/heads/task');
    writeFileSync(join(tree, 'a'), 'keep this\n');
    await preserved(/the worktree holds uncommitted/);
  });
  it('refuses staged work even when the worktree bytes match the removed branch tip', async () => {
    git(root, 'update-ref', '-d', 'refs/heads/task');
    writeFileSync(join(tree, 'a'), 'staged work\n');
    git(tree, 'add', 'a');
    writeFileSync(join(tree, 'a'), 'base\n');
    await preserved(/the worktree holds uncommitted/);
  });
  it('keeps a deleted branch’s own commits recoverable through the worktree log', async () => {
    writeFileSync(join(tree, 'a'), 'own\n');
    git(tree, 'commit', '-qam', 'own');
    git(root, 'update-ref', '-d', 'refs/heads/task');
    await preserved(/branch commits are not contained in the base/);
  });
  it('refuses an unreadable removed-branch log', async () => {
    const log = git(tree, 'rev-parse', '--git-path', 'logs/HEAD');
    git(root, 'update-ref', '-d', 'refs/heads/task');
    writeFileSync(log, 'unreadable');
    await preserved(/could not read the removed branch history/);
  });
  it('refuses a symbolic branch without deleting its target', async () => {
    git(root, 'symbolic-ref', 'refs/heads/task', 'refs/heads/main');
    await preserved(/the worktree is on a different branch/);
  });
  it('refuses missing base history before touching the worktree', async () => {
    state.setup.baseBranch = 'missing';
    await preserved(/base commit/i);
  });
  it('refuses a locked worktree rather than leaving locked registration behind', async () => {
    git(root, 'worktree', 'lock', tree);
    await preserved(/locked/i);
  });
  it('resumes a crash after the durable intent but before the atomic move', async () => {
    vi.spyOn(fsSafe, 'renameNoFollow').mockRejectedValueOnce(
      new Error('simulated crash before move'),
    );
    await expect(run()).rejects.toThrow(/simulated crash/);
    vi.restoreAllMocks();
    expect(readFileSync(join(tree, 'a'), 'utf8')).toBe('base\n');
    expect(await run()).toMatchObject({ removed: true, branchDeleted: true });
  });
  it('resumes after a worker dies during recursive removal', async () => {
    const remove = fsSafe.removeNoFollow;
    vi.spyOn(fsSafe, 'removeNoFollow').mockImplementationOnce(async (anchor, rel) => {
      await remove(anchor, rel + '/a');
      throw new Error('simulated worker death after first unlink');
    });
    await expect(run()).rejects.toThrow(/simulated worker death/);
    vi.restoreAllMocks();
    expect(await run()).toMatchObject({ removed: true, branchDeleted: true });
    expect(await run()).toMatchObject({ removed: true, branchDeleted: true });
  });
  it('discards the interrupted removal directory on Cancel and replays that discard', async () => {
    vi.spyOn(fsSafe, 'removeNoFollow').mockRejectedValueOnce(new Error('interrupted removal'));
    await expect(run()).rejects.toThrow(/interrupted removal/);
    vi.restoreAllMocks();
    const journal = events[0]!.payload as { id: string };
    const staged = join(root, '.haive/no-change-cleanup', journal.id);
    expect(existsSync(staged)).toBe(true);
    const db = ctx.db;
    const cancelledDb = {
      query: {
        ...db.query,
        tasks: { findFirst: async () => ({ status: 'cancelled', runListSnapshot: [ID] }) },
      },
    } as unknown as typeof db;
    await discardNoChangeCleanupDirectories(cancelledDb, ctx.taskId);
    await discardNoChangeCleanupDirectories(cancelledDb, ctx.taskId);
    expect(existsSync(staged)).toBe(false);
  });
  it('rechecks the tree in apply rather than trusting detect', async () => {
    const detected = await step().detect!(ctx);
    writeFileSync(join(tree, 'a'), 'late edit\n');
    await expect(
      step().apply(ctx, { detected, formValues: {}, iteration: 0, previousIterations: [] }),
    ).rejects.toThrow(/the worktree holds uncommitted/);
    expect(readFileSync(join(tree, 'a'), 'utf8')).toBe('late edit\n');
  });
});

describe('no-change cleanup composition and registry', () => {
  const catalog = new Map(CORE_COMPOSABLE_STEPS.map((e) => [e.stepId, e]));
  it('accepts the no-change path without a commit and consumes the worktree', () => {
    expect(validateComposition(['01-worktree-setup', ID], catalog)).toEqual([]);
    expect(catalog.get(ID)).toMatchObject({
      dispatchesCli: false,
      closes: true,
      requires: [
        expect.objectContaining({ needs: 'worktree' }),
        expect.objectContaining({ needs: 'clean-tree' }),
      ],
      removes: ['worktree'],
    });
  });
  it('still requires a commit for ordinary cleanup', () => {
    expect(
      validateComposition(['01-worktree-setup', '12-worktree-cleanup'], catalog),
    ).toContainEqual(expect.objectContaining({ kind: 'unmet-need', needs: 'commit' }));
  });
  it('registers only for explicit composition, outside every built-in workflow list', () => {
    const registry = new StepRegistry();
    registerAllSteps(registry);
    expect(registry.require(ID).metadata.requiresCli).toBe(false);
    expect(registry.listByWorkflow('workflow').map((s) => s.metadata.id)).not.toContain(ID);
  });
});
