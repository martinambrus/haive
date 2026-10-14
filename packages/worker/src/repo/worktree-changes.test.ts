import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { readUncommittedChanges } from './worktree-changes.js';

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
async function git(dir: string, args: string[]): Promise<void> {
  await exec('git', args, { cwd: dir, env: GIT_ENV });
}

async function writeIn(dir: string, files: Record<string, string>): Promise<void> {
  for (const [file, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), body, 'utf8');
  }
}

/** A repo on `main` with a linked worktree at .haive/worktrees/feat, laid out as 01-worktree-setup does. */
async function setup(): Promise<{ root: string; wt: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'wt-changes-'));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'gc.auto', '0']);
  await writeFile(path.join(root, 'f.txt'), 'one\n', 'utf8');
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', 'one']);
  const wt = path.join(root, '.haive', 'worktrees', 'feat');
  await mkdir(path.dirname(wt), { recursive: true });
  await git(root, ['worktree', 'add', '-b', 'feat', wt, 'main']);
  return { root, wt };
}

describe('readUncommittedChanges', () => {
  it('reads a clean worktree as zero changes', async () => {
    const { root, wt } = await setup();
    try {
      expect(await readUncommittedChanges(wt)).toEqual({ count: 0, paths: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('lists an edited tracked file and an untracked one, a name with a space included', async () => {
    const { root, wt } = await setup();
    try {
      await writeIn(wt, { 'f.txt': 'one, edited\n', 'learning notes.md': 'not committed\n' });
      expect(await readUncommittedChanges(wt)).toEqual({
        count: 2,
        paths: ['f.txt', 'learning notes.md'],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('counts a wholly untracked directory once', async () => {
    const { root, wt } = await setup();
    try {
      await writeIn(wt, { 'notes/a.md': 'a\n', 'notes/b.md': 'b\n' });
      expect(await readUncommittedChanges(wt)).toEqual({ count: 1, paths: ['notes/'] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('lists 20 paths unless told otherwise and always reports the total', async () => {
    const { root, wt } = await setup();
    try {
      await writeIn(
        wt,
        Object.fromEntries(
          Array.from({ length: 25 }, (_, i) => [`file ${String(i).padStart(2, '0')}.txt`, 'x\n']),
        ),
      );
      const byDefault = await readUncommittedChanges(wt);
      expect(byDefault?.count).toBe(25);
      expect(byDefault?.paths).toHaveLength(20);
      expect(byDefault?.paths[0]).toBe('file 00.txt');
      expect(byDefault?.paths.at(-1)).toBe('file 19.txt');

      expect(await readUncommittedChanges(wt, 3)).toEqual({
        count: 25,
        paths: ['file 00.txt', 'file 01.txt', 'file 02.txt'],
      });
      expect(await readUncommittedChanges(wt, 0)).toEqual({ count: 25, paths: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reads a worktree that is already gone as zero changes', async () => {
    const { root, wt } = await setup();
    try {
      await git(root, ['worktree', 'remove', '--force', wt]);
      expect(await readUncommittedChanges(wt)).toEqual({ count: 0, paths: [] });
      expect(await readUncommittedChanges(wt, 0)).toEqual({ count: 0, paths: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reads a worktree git cannot read as unknown, never as clean', async () => {
    const { root, wt } = await setup();
    try {
      await writeFile(path.join(wt, '.git'), 'gitdir: /nonexistent/haive-gitdir\n', 'utf8');
      expect(await readUncommittedChanges(wt)).toBeNull();
      expect(await readUncommittedChanges(wt, 0)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('proves absence only for a path under .haive/worktrees, and reads any other missing path as unknown', async () => {
    const { root } = await setup();
    try {
      expect(await readUncommittedChanges(path.join(root, 'not-a-worktree'))).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('readUncommittedChanges and files git is told not to check', () => {
  it('reads a worktree with an assume-unchanged file as unknown, since status hides its edit', async () => {
    const { root, wt } = await setup();
    try {
      await git(wt, ['update-index', '--assume-unchanged', 'f.txt']);
      await writeIn(wt, { 'f.txt': 'edited, hidden from status\n' });
      expect(await readUncommittedChanges(wt)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reads a worktree with a skip-worktree file as unknown, since status hides its edit', async () => {
    const { root, wt } = await setup();
    try {
      await git(wt, ['update-index', '--skip-worktree', 'f.txt']);
      await writeIn(wt, { 'f.txt': 'edited, hidden from status\n' });
      expect(await readUncommittedChanges(wt)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reads a worktree made from a core.ignoreStat repository as unknown', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'wt-changes-ignorestat-'));
    try {
      await git(root, ['init', '-b', 'main']);
      await git(root, ['config', 'gc.auto', '0']);
      await git(root, ['config', 'core.ignoreStat', 'true']);
      await writeIn(root, { 'f.txt': 'one\n' });
      await git(root, ['add', '-A']);
      await git(root, ['commit', '-m', 'one']);
      const wt = path.join(root, '.haive', 'worktrees', 'feat');
      await mkdir(path.dirname(wt), { recursive: true });
      await git(root, ['worktree', 'add', '-b', 'feat', wt, 'main']);
      await writeIn(wt, { 'f.txt': 'edited, hidden from status\n' });
      expect(await readUncommittedChanges(wt)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('readUncommittedChanges and submodules', () => {
  it('counts an edit inside a submodule even when the repository config ignores it', async () => {
    const sub = await mkdtemp(path.join(tmpdir(), 'wt-changes-sub-'));
    const root = await mkdtemp(path.join(tmpdir(), 'wt-changes-super-'));
    try {
      await git(sub, ['init', '-b', 'main']);
      await git(sub, ['config', 'gc.auto', '0']);
      await writeIn(sub, { 'inner.txt': 'one\n' });
      await git(sub, ['add', '-A']);
      await git(sub, ['commit', '-m', 'inner']);
      await git(root, ['init', '-b', 'main']);
      await git(root, ['config', 'gc.auto', '0']);
      await git(root, ['-c', 'protocol.file.allow=always', 'submodule', 'add', sub, 'mod']);
      await git(root, ['commit', '-m', 'add submodule']);
      await git(root, ['config', 'submodule.mod.ignore', 'all']);
      await writeIn(root, { 'mod/inner.txt': 'edited\n' });
      const held = await readUncommittedChanges(root);
      expect(held?.count).toBeGreaterThan(0);
      expect(held?.paths).toContain('mod');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(sub, { recursive: true, force: true });
    }
  });
});
