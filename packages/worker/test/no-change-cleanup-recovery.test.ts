import { execFileSync } from 'node:child_process';
import { schema } from '@haive/database';
import { noChangeCleanupStep } from '../src/step-engine/steps/core/12-no-change-cleanup.js';
import * as gitExec from '../src/repo/git-exec.js';
import { createHash } from 'node:crypto';
import {
  cpSync,
  chmodSync,
  renameSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StepContext } from '../src/step-engine/step-definition.js';
import * as fsSafe from '@haive/shared/fs-safe';

const state = vi.hoisted(() => ({ setup: {} as Record<string, unknown> }));
vi.mock('../src/step-engine/steps/onboarding/_helpers.js', async (original) => ({
  ...(await original<object>()),
  loadPreviousStepOutput: async () => ({ output: state.setup }),
}));

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

describe('no-change cleanup race and recovery controls', () => {
  let template: string;
  let root: string;
  let tree: string;
  let ctx: StepContext;
  let events: { payload: unknown }[];
  const step = () => noChangeCleanupStep;
  let claimant: boolean;
  let owned: boolean;
  let taskLive: boolean;
  let onRecord: () => void;
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
    claimant = false;
    owned = true;
    taskLive = true;
    onRecord = () => {};
    const query = {
      tasks: { findFirst: async () => (claimant ? { id: 'other', status: 'running' } : null) },
      taskEvents: { findMany: async () => [...events].reverse() },
    };
    const select = () => {
      let table: unknown;
      const builder = {
        from: (value: unknown) => {
          table = value;
          return builder;
        },
        where: () => builder,
        for: async () => ((table === schema.taskSteps ? owned : taskLive) ? [{ id: 'step' }] : []),
      };
      return builder;
    };
    const db = {
      query,
      select,
      insert: () => ({
        values: async (event: { payload: unknown }) => {
          events.push(event);
          onRecord();
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

  const interruptBeforeMove = async () => {
    vi.spyOn(fsSafe, 'renameNoFollow').mockRejectedValueOnce(new Error('before move'));
    await expect(run()).rejects.toThrow('before move');
    vi.restoreAllMocks();
  };
  const stage = () =>
    join(root, '.haive/no-change-cleanup', (events[0]!.payload as { id: string }).id);

  it('preserves an edit made by the journal write before rename', async () => {
    onRecord = vi.fn(() => writeFileSync(join(tree, 'late'), 'keep'));
    const move = vi.spyOn(fsSafe, 'renameNoFollow');
    await expect(run()).rejects.toThrow('the worktree holds uncommitted changes');
    expect(onRecord).toHaveBeenCalledOnce();
    expect(move).not.toHaveBeenCalled();
    expect(readFileSync(join(tree, 'late'), 'utf8')).toBe('keep');
    expect(git(root, 'branch', '--list', 'task')).toContain('task');
  });
  it('checks status through the staged gitfile and restores an edit after rename', async () => {
    const rename = fsSafe.renameNoFollow;
    vi.spyOn(fsSafe, 'renameNoFollow').mockImplementationOnce(async (...args) => {
      const result = await rename(...args);
      writeFileSync(join(root, args[2], 'late'), 'keep after move');
      return result;
    });
    const remove = vi.spyOn(fsSafe, 'removeNoFollow');
    const gitSpy = vi.spyOn(gitExec, 'gitRun');
    await expect(run()).rejects.toThrow('the worktree holds uncommitted changes');
    expect(
      gitSpy.mock.calls.some(([cwd, args]) => cwd === stage() && args.includes('status')),
    ).toBe(true);
    expect(remove).not.toHaveBeenCalled();
    expect(readFileSync(join(tree, 'late'), 'utf8')).toBe('keep after move');
    expect(existsSync(stage())).toBe(false);
  });
  it('rechecks a move whose process died before its staged verification', async () => {
    const rename = fsSafe.renameNoFollow;
    vi.spyOn(fsSafe, 'renameNoFollow').mockImplementationOnce(async (...args) => {
      await rename(...args);
      writeFileSync(join(root, args[2], 'late'), 'keep across recovery');
      throw new Error('died after move');
    });
    await expect(run()).rejects.toThrow('died after move');
    vi.restoreAllMocks();
    await expect(run()).rejects.toThrow('the worktree holds uncommitted changes');
    expect(readFileSync(join(tree, 'late'), 'utf8')).toBe('keep across recovery');
  });
  it('keeps both trees if restoration is blocked, and refuses the next pass too', async () => {
    const rename = fsSafe.renameNoFollow;
    vi.spyOn(fsSafe, 'renameNoFollow').mockImplementationOnce(async (...args) => {
      await rename(...args);
      writeFileSync(join(root, args[2], 'late'), 'keep staged');
      mkdirSync(tree);
      writeFileSync(join(tree, 'keep'), 'keep replacement');
    });
    await expect(run()).rejects.toThrow('the staged worktree could not be restored');
    vi.restoreAllMocks();
    await expect(run()).rejects.toThrow('the cleanup recovery directory changed');
    expect(readFileSync(join(stage(), 'late'), 'utf8')).toBe('keep staged');
    expect(readFileSync(join(tree, 'keep'), 'utf8')).toBe('keep replacement');
  });
  it.each(['step', 'task'] as const)('refuses a lost %s fence during record', async (kind) => {
    if (kind === 'step') owned = false;
    else taskLive = false;
    await preserved(/task step step was reset, skipped or stopped/);
  });
  it.each(['source', 'staged'] as const)('asserts ownership on a resumed %s pass', async (kind) => {
    if (kind === 'source') await interruptBeforeMove();
    else {
      vi.spyOn(fsSafe, 'removeNoFollow').mockRejectedValueOnce(new Error('before unlink'));
      await expect(run()).rejects.toThrow('before unlink');
      vi.restoreAllMocks();
    }
    const before = snapshot(root);
    if (kind === 'source') owned = false;
    else taskLive = false;
    const remove = vi.spyOn(fsSafe, 'removeNoFollow');
    const rename = vi.spyOn(fsSafe, 'renameNoFollow');
    await expect(run()).rejects.toThrow('task step step was reset, skipped or stopped');
    expect(snapshot(root)).toBe(before);
    expect(remove).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
  });
  it('refuses a live claimant before touching the tree', async () => {
    claimant = true;
    await preserved(/another task still holds this worktree/);
  });
  it('refuses detached HEAD specifically', async () => {
    git(tree, 'checkout', '--detach');
    await preserved(/could not read the worktree branch/);
  });
  it('ignores an obsolete setup only once its staged and same-identity source are gone', async () => {
    await interruptBeforeMove();
    const old = tree;
    // A different setup must still refuse while the recorded source exists.
    const next = tree + '-next';
    git(root, 'worktree', 'add', '-qb', 'next', next, 'main');
    tree = next;
    state.setup = { ...state.setup, worktreePath: next, branchName: 'next' };
    await expect(run()).rejects.toThrow('the worktree setup changed during cleanup');
    renameSync(old, old + '-retired');
    // A new, unrelated directory at the old path must not revive the old claim.
    mkdirSync(old);
    writeFileSync(join(old, 'keep'), 'unrelated');
    expect(await run()).toMatchObject({ removed: true });
    expect(readFileSync(join(old, 'keep'), 'utf8')).toBe('unrelated');
  });
  it('allows a moved contained branch before the move when only the intent exists', async () => {
    await interruptBeforeMove();
    writeFileSync(join(tree, 'a'), 'landed later\n');
    git(tree, 'commit', '-qam', 'landed later');
    git(root, 'merge', '--ff-only', 'task');
    vi.spyOn(fsSafe, 'removeNoFollow').mockRejectedValueOnce(new Error('interrupted updated head'));
    await expect(run()).rejects.toThrow('interrupted updated head');
    vi.restoreAllMocks();
    expect(await run()).toMatchObject({ removed: true, branchDeleted: true });
  });
  it('uses the current reflog after an intent when the branch was removed later', async () => {
    await interruptBeforeMove();
    git(tree, 'commit', '--allow-empty', '-qm', 'uncontained empty commit');
    git(root, 'update-ref', '-d', 'refs/heads/task');
    const before = snapshot(root);
    await expect(run()).rejects.toThrow('branch commits are not contained in the base');
    expect(snapshot(root)).toBe(before);
  });
  it('still refuses a branch that changed while staged', async () => {
    vi.spyOn(fsSafe, 'removeNoFollow').mockRejectedValueOnce(new Error('before unlink'));
    await expect(run()).rejects.toThrow('before unlink');
    vi.restoreAllMocks();
    writeFileSync(join(root, 'a'), 'later\n');
    git(root, 'commit', '-qam', 'later');
    git(root, 'update-ref', 'refs/heads/task', git(root, 'rev-parse', 'main'));
    const before = snapshot(root);
    await expect(run()).rejects.toThrow('the branch changed during cleanup');
    expect(snapshot(root)).toBe(before);
  });
  it('skips ancestry on a completed replay even if the base no longer contains the old head', async () => {
    const base = git(root, 'rev-parse', 'main');
    writeFileSync(join(tree, 'a'), 'landed\n');
    git(tree, 'commit', '-qam', 'landed');
    git(root, 'merge', '--ff-only', 'task');
    await run();
    git(root, 'reset', '--hard', base);
    const spy = vi.spyOn(gitExec, 'gitRun');
    expect(await run()).toMatchObject({ removed: true, branchDeleted: true });
    expect(spy.mock.calls.some(([, args]) => args.includes('merge-base'))).toBe(false);
  });
  it('refuses a directory identity changed after the journal', async () => {
    const lstat = fsSafe.lstatNoFollow;
    vi.spyOn(fsSafe, 'lstatNoFollow').mockImplementation(async (...args) => {
      if (events.length && args[1] === '.haive/worktrees/task') {
        renameSync(tree, tree + '-original');
        mkdirSync(tree);
        writeFileSync(join(tree, 'keep'), 'replacement');
      }
      return lstat(...args);
    });
    await expect(run()).rejects.toThrow('the worktree directory changed before removal');
    expect(readFileSync(join(tree, 'keep'), 'utf8')).toBe('replacement');
    expect(readFileSync(join(tree + '-original', 'a'), 'utf8')).toBe('base\n');
  });
  it.skipIf(process.getuid?.() === 0)(
    'removes a 0555 ignored directory as a non-root owner',
    async () => {
      expect(process.getuid?.()).not.toBe(0);
      const dir = join(tree, '.haive/readonly');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'cache'), 'ignored');
      chmodSync(dir, 0o555);
      try {
        expect(await run()).toMatchObject({ removed: true });
      } finally {
        for (const at of [dir, join(stage(), '.haive/readonly')]) {
          if (existsSync(at)) chmodSync(at, 0o755);
        }
      }
    },
  );
});
