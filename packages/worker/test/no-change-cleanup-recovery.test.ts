import { execFileSync } from 'node:child_process';
import { schema } from '@haive/database';
import { noChangeCleanupStep } from '../src/step-engine/steps/core/12-no-change-cleanup.js';
import * as gitExec from '../src/repo/git-exec.js';
import { createHash } from 'node:crypto';
import {
  cpSync,
  chmodSync,
  renameSync,
  symlinkSync,
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
import { discardNoChangeCleanupDirectories } from '../src/step-engine/no-change-cleanup.js';
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
  let cancelled: boolean;
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
    cancelled = false;
    owned = true;
    taskLive = true;
    onRecord = () => {};
    const query = {
      tasks: {
        findFirst: async () =>
          claimant
            ? { id: 'other', status: 'running' }
            : cancelled
              ? { status: 'cancelled', runListSnapshot: ['12-no-change-cleanup'] }
              : null,
      },
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

  it.each(['step', 'cancel'] as const)(
    'refuses a swapped staged directory in %s removal',
    async (caller) => {
      const remove = fsSafe.removeNoFollow;
      if (caller === 'cancel') {
        vi.spyOn(fsSafe, 'removeNoFollow').mockRejectedValueOnce(new Error('pause'));
        await expect(run()).rejects.toThrow('pause');
        vi.restoreAllMocks();
      }
      vi.spyOn(fsSafe, 'removeNoFollow').mockImplementationOnce(async (...args) => {
        const staged = join(args[0], args[1]);
        renameSync(staged, staged + '-original');
        mkdirSync(staged);
        writeFileSync(join(staged, 'keep'), 'replacement');
        return remove(...args);
      });
      if (caller === 'cancel') {
        cancelled = true;
        await expect(discardNoChangeCleanupDirectories(ctx.db, ctx.taskId)).rejects.toMatchObject({
          code: 'EDIRECTORYIDENTITY',
        });
      } else await expect(run()).rejects.toMatchObject({ code: 'EDIRECTORYIDENTITY' });
      expect(readFileSync(join(stage(), 'keep'), 'utf8')).toBe('replacement');
      expect(readFileSync(join(stage() + '-original', 'a'), 'utf8')).toBe('base\n');
      expect(git(root, 'branch', '--list', 'task')).toContain('task');
    },
  );
  it.each(['step', 'cancel'] as const)(
    'refuses a swapped staged symlink in %s removal',
    async (caller) => {
      const remove = fsSafe.removeNoFollow;
      // Pause first for cancel, then inject the same race at its actual removal call.
      if (caller === 'cancel') {
        vi.spyOn(fsSafe, 'removeNoFollow').mockRejectedValueOnce(new Error('pause'));
        await expect(run()).rejects.toThrow('pause');
        vi.restoreAllMocks();
        cancelled = true;
      }
      vi.spyOn(fsSafe, 'removeNoFollow').mockImplementationOnce(async (...args) => {
        const staged = join(args[0], args[1]);
        renameSync(staged, staged + '-original');
        symlinkSync(staged + '-original', staged);
        return remove(...args);
      });
      const action =
        caller === 'cancel' ? discardNoChangeCleanupDirectories(ctx.db, ctx.taskId) : run();
      await expect(action).rejects.toMatchObject({ code: 'EDIRECTORYIDENTITY' });
      expect(readFileSync(join(stage(), 'a'), 'utf8')).toBe('base\n');
    },
  );
  async function initializeSubmodule(nested = false) {
    const sub = mkdtempSync(join(tmpdir(), 'no-change-submodule-'));
    try {
      cpSync(template, sub, { recursive: true });
      if (nested) {
        git(sub, '-c', 'protocol.file.allow=always', 'submodule', 'add', template, 'inner');
        git(sub, 'commit', '-qam', 'add nested submodule');
      }
      git(tree, '-c', 'protocol.file.allow=always', 'submodule', 'add', sub, 'mod');
      git(tree, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive');
      git(tree, 'commit', '-qam', 'add submodule');
      git(root, 'merge', '--ff-only', 'task');
    } finally {
      rmSync(sub, { recursive: true, force: true });
    }
  }
  it('removes a clean worktree with an initialized submodule', async () => {
    await initializeSubmodule();
    expect(await run()).toMatchObject({ removed: true, branchDeleted: true });
    expect(existsSync(tree)).toBe(false);
  });
  it('checks initialized nested submodules at their relocated paths', async () => {
    await initializeSubmodule(true);
    const rename = fsSafe.renameNoFollow;
    vi.spyOn(fsSafe, 'renameNoFollow').mockImplementationOnce(async (...args) => {
      await rename(...args);
      writeFileSync(join(root, args[2], 'mod/inner/new'), 'nested work');
    });
    await expect(run()).rejects.toThrow('the worktree holds uncommitted changes');
    expect(readFileSync(join(tree, 'mod/inner/new'), 'utf8')).toBe('nested work');
    rmSync(join(tree, 'mod/inner/new'));
    vi.restoreAllMocks();
    expect(await run()).toMatchObject({ removed: true, branchDeleted: true });
  });
  it('refuses dirty submodules before staging', async () => {
    await initializeSubmodule();
    writeFileSync(join(tree, 'mod/a'), 'dirty');
    await preserved(/the worktree holds uncommitted changes/);
  });
  it.each(['tracked', 'staged', 'head', 'hidden'] as const)(
    'restores a submodule with %s changes after relocation without changing config',
    async (kind) => {
      await initializeSubmodule();
      const config = git(join(tree, 'mod'), 'rev-parse', '--absolute-git-dir') + '/config';
      const before = readFileSync(config, 'utf8');
      const rename = fsSafe.renameNoFollow;
      vi.spyOn(fsSafe, 'renameNoFollow').mockImplementationOnce(async (...args) => {
        await rename(...args);
        const child = join(root, args[2], 'mod');
        const at = [`--work-tree=${child}`];
        writeFileSync(join(child, 'a'), 'dirty after move');
        if (kind === 'staged') git(child, ...at, 'add', 'a');
        if (kind === 'head')
          git(
            child,
            ...at,
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.com',
            'commit',
            '-qam',
            'local submodule commit',
          );
        if (kind === 'hidden') git(child, ...at, 'update-index', '--assume-unchanged', 'a');
      });
      await expect(run()).rejects.toThrow(
        kind === 'hidden'
          ? 'the worktree index is unreadable'
          : 'the worktree holds uncommitted changes',
      );
      expect(readFileSync(join(tree, 'mod/a'), 'utf8')).toBe('dirty after move');
      expect(readFileSync(config, 'utf8')).toBe(before);
      expect(existsSync(stage())).toBe(false);
    },
  );
  it('preserves an edit made by the journal write before rename', async () => {
    onRecord = vi.fn(() => writeFileSync(join(tree, 'late'), 'keep'));
    const move = vi.spyOn(fsSafe, 'renameNoFollow');
    await expect(run()).rejects.toThrow('the worktree holds uncommitted changes');
    expect(onRecord).toHaveBeenCalledOnce();
    expect(move).not.toHaveBeenCalled();
    expect(readFileSync(join(tree, 'late'), 'utf8')).toBe('keep');
    expect(git(root, 'branch', '--list', 'task')).toContain('task');
  });
  it('checks changes through the staged gitfile and restores an edit after rename', async () => {
    const rename = fsSafe.renameNoFollow;
    vi.spyOn(fsSafe, 'renameNoFollow').mockImplementationOnce(async (...args) => {
      const result = await rename(...args);
      writeFileSync(join(root, args[2], 'late'), 'keep after move');
      return result;
    });
    const remove = vi.spyOn(fsSafe, 'removeNoFollow');
    const gitSpy = vi.spyOn(gitExec, 'gitRun');
    await expect(run()).rejects.toThrow('the worktree holds uncommitted changes');
    expect(gitSpy.mock.calls.some(([cwd, args]) => cwd === stage() && args.includes('diff'))).toBe(
      true,
    );
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
