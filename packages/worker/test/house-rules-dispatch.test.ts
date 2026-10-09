import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Database } from '@haive/database';

const h = vi.hoisted(() => ({
  tree: null as string | null | Error,
  treeCalls: [] as Array<{ taskId: string; rel: string | undefined }>,
  setup: undefined as unknown,
  gitCalls: [] as string[][],
  lsFilesFails: false,
}));

vi.mock('../src/repo/git-exec.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/repo/git-exec.js')>();
  return {
    ...original,
    gitRun: async (...args: Parameters<typeof original.gitRun>) => {
      h.gitCalls.push(args[1]);
      if (h.lsFilesFails && args[1].includes('ls-files')) {
        return { stdout: '', stderr: 'fatal: made to fail', code: 128 };
      }
      return original.gitRun(...args);
    },
  };
});
vi.mock('../src/repo/worktree-git-boundary.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveInvocationWorkerTree: async (_db: unknown, taskId: string, rel?: string) => {
    h.treeCalls.push({ taskId, rel });
    if (h.tree instanceof Error) throw h.tree;
    return h.tree;
  },
}));
vi.mock('../src/step-engine/steps/onboarding/_helpers.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadPreviousStepOutput: async () => h.setup ?? null,
}));

import {
  CHANGE_READ_GIT_TIMEOUT_MS,
  readTrackedFiles,
  FINGERPRINT_READ_BYTES,
  HOUSE_RULES_UNAVAILABLE_EVENT,
  changeFingerprint,
  plannedFiles,
  readChangedFiles,
  readDispatchChange,
  recordHouseRulesUnavailable,
  selectForDispatch,
} from '../src/orchestrator/house-rules-dispatch.js';
import { gitRun } from '../src/repo/git-exec.js';
import type { HouseRuleCandidate } from '../src/orchestrator/house-rules.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });

async function put(root: string, rel: string, text = `${rel}\n`): Promise<void> {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), text);
}

/** main holds the base; `feature` committed one change on top of it; the working tree holds another. */
async function repo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'haive-house-rules-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@test.local');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'gc.auto', '0');
  for (const rel of ['a.txt', 'b.txt', 'src/keep.php', 'templates/node.tpl.php', 'docs/old.md']) {
    await put(dir, rel);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feature');
  await put(dir, 'templates/node.tpl.php', 'changed\n');
  await put(dir, 'src/committed.php');
  git(dir, 'rm', '-q', 'docs/old.md');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'task change');
  return dir;
}

/** The branch adds `protected/a` in a commit, then moves it to `public/a` in the index only. */
async function stageRenameOfBranchFile(dir: string): Promise<void> {
  await put(dir, 'protected/a');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'add protected/a');
  await mkdir(path.join(dir, 'public'));
  git(dir, 'mv', 'protected/a', 'public/a');
}

describe('readChangedFiles', () => {
  it('unions what is dirty or untracked with what the branch holds against its fork point', async () => {
    const dir = await repo();
    await put(dir, 'src/keep.php', 'edited\n');
    await put(dir, 'new/deep/file.css');
    await put(dir, 'my file.php');
    expect((await readChangedFiles(dir, 'main'))!.sort()).toEqual([
      'docs/old.md',
      'my file.php',
      'new/deep/file.css',
      'src/committed.php',
      'src/keep.php',
      'templates/node.tpl.php',
    ]);
  });

  it('reads a path as it is, whatever it holds, since the lists are NUL separated', async () => {
    const dir = await repo();
    const odd = `web/caf${String.fromCodePoint(0xe9)}.css`;
    await put(dir, odd);
    await put(dir, 'quo"te.css');
    const files = (await readChangedFiles(dir, 'main'))!;
    expect(files).toContain(odd);
    expect(files).toContain('quo"te.css');
    expect(files.some((f) => f.startsWith('"'))).toBe(false);
  });

  it('names a file the change deleted: in a commit on the branch, staged, or in the working tree', async () => {
    const dir = await repo();
    git(dir, 'rm', '-q', 'a.txt');
    await rm(path.join(dir, 'b.txt'));
    const files = (await readChangedFiles(dir, 'main'))!;
    expect(files).toContain('docs/old.md');
    expect(files).toContain('a.txt');
    expect(files).toContain('b.txt');
  });

  it('names a file the branch added and the working tree then deleted, which the fork point never held', async () => {
    const dir = await repo();
    await rm(path.join(dir, 'src/committed.php'));
    expect(git(dir, 'diff', '--name-only', 'main', '--', 'src/committed.php')).toBe('');
    expect(await readChangedFiles(dir, 'main')).toContain('src/committed.php');
  });

  it('names both sides of a rename, since its source is a deletion', async () => {
    const dir = await repo();
    git(dir, 'mv', 'a.txt', 'renamed.txt');
    const files = (await readChangedFiles(dir, 'main'))!;
    expect(files).toContain('renamed.txt');
    expect(files).toContain('a.txt');
  });

  it('names both sides of a staged rename of a file the branch itself added, which the fork point never held', async () => {
    const dir = await repo();
    await stageRenameOfBranchFile(dir);
    expect(git(dir, 'diff', '--name-only', 'main', '--', 'protected/a')).toBe('');
    const files = (await readChangedFiles(dir, 'main'))!;
    expect(files).toContain('public/a');
    expect(files).toContain('protected/a');
  });

  it('holds only the dirty files when the fork point is unknown, which is all the work of a single agent', async () => {
    const dir = await repo();
    await put(dir, 'src/keep.php', 'edited\n');
    expect(await readChangedFiles(dir, null)).toEqual(['src/keep.php']);
    expect(await readChangedFiles(dir, 'a-branch-that-is-gone')).toEqual(['src/keep.php']);
  });

  it('is empty, not unreadable, for a tree that changed nothing', async () => {
    const dir = await repo();
    git(dir, 'checkout', '-q', 'main');
    expect(await readChangedFiles(dir, 'main')).toEqual([]);
  });

  it('is null for a checkout git does not recognise, and for a tree that is not there', async () => {
    const broken = await mkdtemp(path.join(tmpdir(), 'haive-house-rules-'));
    dirs.push(broken);
    await writeFile(path.join(broken, '.git'), 'gitdir: /nonexistent/gitdir\n');
    expect(await readChangedFiles(broken, 'main')).toBeNull();
    expect(await readChangedFiles(path.join(broken, 'gone'), 'main')).toBeNull();
  });

  it('does not rewrite the index of the tree it reads', async () => {
    const dir = await repo();
    const before = git(dir, 'rev-parse', 'HEAD');
    await readChangedFiles(dir, 'main');
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(before);
  });
});

describe('changeFingerprint', () => {
  const DIGEST = /^[0-9a-f]{64}$/;
  const of = async (dir: string) => (await changeFingerprint(dir, 'main'))!;

  it('is a sha256 digest, the same while the change has not moved', async () => {
    const dir = await repo();
    await put(dir, 'src/keep.php', 'edited\n');
    const first = await of(dir);
    expect(first).toMatch(DIGEST);
    expect(await of(dir)).toBe(first);
  });

  it.each([
    ['a changed file is edited again', 'templates/node.tpl.php', 'edited again\n'],
    ['a changed file is edited to the same size', 'src/keep.php', 'EDITED\n'],
    ['a file is added', 'new/added.php', '<?php\n'],
    ['a file the change had not touched is edited', 'a.txt', 'edited\n'],
  ])('moves when %s', async (_name, rel, text) => {
    const dir = await repo();
    await put(dir, 'src/keep.php', 'edited\n');
    const before = await of(dir);
    await put(dir, rel, text);
    expect(await of(dir)).not.toBe(before);
  });

  it.each([
    ['a file the change added', 'src/committed.php'],
    ['a file the change had not touched', 'b.txt'],
  ])('moves when %s is deleted', async (_name, rel) => {
    const dir = await repo();
    await put(dir, 'src/keep.php', 'edited\n');
    const before = await of(dir);
    await rm(path.join(dir, rel));
    expect(await of(dir)).not.toBe(before);
  });

  it('does not move when the work in the tree is committed between the check and the gate', async () => {
    const dir = await repo();
    await put(dir, 'src/keep.php', 'edited\n');
    await put(dir, 'new/added.php', '<?php\n');
    await rm(path.join(dir, 'b.txt'));
    const before = await of(dir);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'the commit gate 3 makes');
    expect(await of(dir)).toBe(before);
  });

  it('names a path: the same bytes under another name are another change', async () => {
    const one = await repo();
    const two = await repo();
    await put(one, 'new/one.php', 'same\n');
    await put(two, 'new/two.php', 'same\n');
    expect(await of(one)).not.toBe(await of(two));
  });

  it('holds only the dirty files when the fork point is unknown, as the change itself does', async () => {
    const dir = await repo();
    const clean = await changeFingerprint(dir, null);
    expect(clean).toMatch(DIGEST);
    await put(dir, 'src/keep.php', 'edited\n');
    expect(await changeFingerprint(dir, null)).not.toBe(clean);
  });

  it('is null, not a digest of nothing, when the change cannot be read', async () => {
    const broken = await mkdtemp(path.join(tmpdir(), 'haive-house-rules-'));
    dirs.push(broken);
    await writeFile(path.join(broken, '.git'), 'gitdir: /nonexistent/gitdir\n');
    expect(await changeFingerprint(broken, 'main')).toBeNull();
    expect(await changeFingerprint(path.join(broken, 'gone'), 'main')).toBeNull();
  });

  it('does not follow a link: what it points at is no part of the digest', async () => {
    const dir = await repo();
    const outside = await mkdtemp(path.join(tmpdir(), 'haive-outside-'));
    dirs.push(outside);
    await writeFile(path.join(outside, 'secret.txt'), 'one\n');
    const without = await of(dir);
    await symlink(path.join(outside, 'secret.txt'), path.join(dir, 'link.txt'));
    const linked = await of(dir);
    expect(linked).not.toBe(without);
    await writeFile(path.join(outside, 'secret.txt'), 'two\n');
    expect(await of(dir)).toBe(linked);
  });

  it('reads the files of a worktree under .haive/worktrees, anchored at the repository root', async () => {
    const dir = await repo();
    await appendFile(path.join(dir, '.git/info/exclude'), '.haive/\n');
    const wt = path.join(dir, '.haive/worktrees/task');
    git(dir, 'worktree', 'add', '-q', '-b', 'task', wt, 'main');
    await put(wt, 'src/new.php', 'one\n');
    const before = (await changeFingerprint(wt, 'main'))!;
    expect(before).toMatch(DIGEST);
    await put(wt, 'src/new.php', 'two\n');
    expect(await changeFingerprint(wt, 'main')).not.toBe(before);
  });

  it('takes a bounded prefix of a large file and its size, so one file cannot exhaust the worker', async () => {
    const dir = await repo();
    const big = Buffer.alloc(FINGERPRINT_READ_BYTES + 4096, 97);
    await writeFile(path.join(dir, 'big.bin'), big);
    const before = await of(dir);
    const tail = Buffer.from(big);
    tail[tail.length - 1] = 98;
    await writeFile(path.join(dir, 'big.bin'), tail);
    expect(await of(dir)).toBe(before);
    const head = Buffer.from(big);
    head[0] = 98;
    await writeFile(path.join(dir, 'big.bin'), head);
    expect(await of(dir)).not.toBe(before);
    await writeFile(path.join(dir, 'big.bin'), Buffer.concat([big, Buffer.from('x')]));
    expect(await of(dir)).not.toBe(before);
  });
});

describe('a git that hangs', () => {
  const BOUND_MS = 600;
  const SLEEP = 'exec sleep 120';
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const originalPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = originalPath;
  });

  /** Puts a `git` first on PATH that runs `script` instead of git; the tree is built before it. */
  async function fakeGit(script: string): Promise<void> {
    const bin = await mkdtemp(path.join(tmpdir(), 'haive-fake-git-'));
    dirs.push(bin);
    await writeFile(path.join(bin, 'git'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
  }
  async function within<T>(run: () => Promise<T>): Promise<T> {
    const started = performance.now();
    const value = await run();
    expect(performance.now() - started).toBeLessThan(BOUND_MS + 2000);
    return value;
  }

  it('bounds the change read at 30 seconds unless told otherwise', () => {
    expect(CHANGE_READ_GIT_TIMEOUT_MS).toBe(30_000);
  });

  it('is killed by gitRun once it outlives its timeout, and reads as a failed run', async () => {
    const dir = await repo();
    await fakeGit(SLEEP);
    const run = await within(() => gitRun(dir, ['--version'], undefined, { timeout: BOUND_MS }));
    expect(run.code).not.toBe(0);
  }, 10_000);

  it('leaves the tracked-file read for named paths with null inside its bound', async () => {
    const dir = await repo();
    await fakeGit(SLEEP);
    expect(await within(() => readTrackedFiles(dir, BOUND_MS))).toBeNull();
  }, 10_000);

  it('leaves readChangedFiles with null inside its bound', async () => {
    const dir = await repo();
    await fakeGit(SLEEP);
    expect(await within(() => readChangedFiles(dir, 'main', BOUND_MS))).toBeNull();
  }, 10_000);

  it('leaves changeFingerprint with null inside its bound', async () => {
    const dir = await repo();
    await fakeGit(SLEEP);
    expect(await within(() => changeFingerprint(dir, 'main', BOUND_MS))).toBeNull();
  }, 10_000);

  // Falling back to HEAD would answer a narrower question: a DAG task's commits would vanish.
  it('answers null, not the dirty files alone, when only the fork-point lookup hangs', async () => {
    const dir = await repo();
    await put(dir, 'src/keep.php', 'edited\n');
    await fakeGit(
      `for a in "$@"; do [ "$a" = merge-base ] && exec sleep 120; done\nexec '${realGit}' "$@"`,
    );
    expect(await within(() => readChangedFiles(dir, 'main', BOUND_MS))).toBeNull();
    expect(await within(() => changeFingerprint(dir, 'main', BOUND_MS))).toBeNull();
  }, 10_000);

  it('reads the change as before when git answers inside the bound', async () => {
    const dir = await repo();
    await put(dir, 'src/keep.php', 'edited\n');
    expect(await readChangedFiles(dir, 'main', 15_000)).toContain('src/keep.php');
    expect(await changeFingerprint(dir, 'main', 15_000)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('readDispatchChange', () => {
  beforeEach(() => {
    h.tree = null;
    h.treeCalls = [];
    h.setup = undefined;
  });

  it('reads the tree the invocation mounts, against the base branch the task was set up with', async () => {
    const dir = await repo();
    h.tree = dir;
    h.setup = { output: { baseBranch: 'main' } };
    const files = await readDispatchChange({} as Database, 'task-1', 'issues/a');
    expect(files).toContain('templates/node.tpl.php');
    expect(h.treeCalls).toEqual([{ taskId: 'task-1', rel: 'issues/a' }]);
  });

  it('reads only the dirty files when the task recorded no base branch', async () => {
    const dir = await repo();
    await put(dir, 'src/keep.php', 'edited\n');
    h.tree = dir;
    expect(await readDispatchChange({} as Database, 'task-1', undefined)).toEqual(['src/keep.php']);
  });

  it('is null for a task with no repository tree', async () => {
    h.tree = null;
    expect(await readDispatchChange({} as Database, 'task-1', undefined)).toBeNull();
  });

  it('is null, never a throw, when resolving or reading the tree fails', async () => {
    h.tree = new Error('database is down');
    expect(await readDispatchChange({} as Database, 'task-1', undefined)).toBeNull();
  });
});

describe('plannedFiles', () => {
  it('keeps repository-relative paths and cleans the common spellings', () => {
    expect(
      plannedFiles(['src/a.php', './src/b.php', '/haive/workdir/web/c.css', '  lib/d.js  ']),
    ).toEqual(['src/a.php', 'src/b.php', 'web/c.css', 'lib/d.js']);
  });

  it('drops what is absolute, climbs out of the repository or names nothing', () => {
    expect(
      plannedFiles(['/etc/passwd', '../outside.php', 'a/../../b.php', '', '   ', './']),
    ).toEqual([]);
  });

  it('is empty for no plan', () => {
    expect(plannedFiles(undefined)).toEqual([]);
    expect(plannedFiles([])).toEqual([]);
  });
});

describe('selectForDispatch', () => {
  beforeEach(() => {
    h.tree = null;
    h.treeCalls = [];
    h.setup = undefined;
  });

  let seq = 0;
  const rule = (over: Partial<HouseRuleCandidate> = {}): HouseRuleCandidate => {
    seq += 1;
    return {
      id: `${String(seq).padStart(8, '0')}-0000-4000-8000-${String(seq).padStart(12, '0')}`,
      hash: `hr1:${seq}`,
      title: `Rule ${seq}`,
      category: 'best_practice',
      description: 'A rule.',
      body: 'Do it.\n',
      spec: { mode: 'always' },
      enforcedAt: null,
      ...over,
    };
  };
  const files = (globs: string[]) => rule({ spec: { mode: 'files', globs } });
  const kb = (over = {}) => ({ status: 'ok' as const, rules: [], refused: [], ...over });
  const select = (request: Parameters<typeof selectForDispatch>[2], k: ReturnType<typeof kb>) =>
    selectForDispatch({} as Database, 'task-1', request, undefined, k);

  it('shows nothing and says the switch is off when it is', async () => {
    expect(await select({ mode: 'write' }, kb({ status: 'disabled' as const }))).toMatchObject({
      status: 'disabled',
      block: null,
    });
  });

  it('says only the class when the store could not be read', async () => {
    expect(
      await select(
        { mode: 'write' },
        kb({ status: 'unavailable' as const, errorClass: 'auth' as const }),
      ),
    ).toMatchObject({ status: 'unavailable', errorClass: 'auth', block: null });
  });

  it('reads no change for always rules, which no file scopes', async () => {
    const out = await select({ mode: 'write' }, kb({ rules: [rule()] }));
    expect(out.entries).toHaveLength(1);
    expect(h.treeCalls).toEqual([]);
  });

  it('scopes a files rule by the change of the tree the dispatch mounts', async () => {
    const dir = await repo();
    h.tree = dir;
    h.setup = { output: { baseBranch: 'main' } };
    const out = await select(
      { mode: 'review' },
      kb({ rules: [files(['**/*.tpl.php']), files(['**/*.twig'])] }),
    );
    expect(out.entries.map((e) => e.why)).toEqual([{ scope: 'files', glob: '**/*.tpl.php' }]);
    expect(h.treeCalls).toHaveLength(1);
  });

  it('counts the files rules that matched nothing in the change, which a later write may match', async () => {
    const dir = await repo();
    h.tree = dir;
    h.setup = { output: { baseBranch: 'main' } };
    const out = await select(
      { mode: 'review' },
      kb({ rules: [files(['**/*.tpl.php']), files(['**/*.twig']), files(['**/*.scss'])] }),
    );
    expect(out.entries).toHaveLength(1);
    expect(out.filesRulesUnmatched).toBe(2);
  });

  it('counts none when every files rule matched, or when the change could not be read', async () => {
    const dir = await repo();
    h.tree = dir;
    h.setup = { output: { baseBranch: 'main' } };
    const matched = await select({ mode: 'review' }, kb({ rules: [files(['**/*.tpl.php'])] }));
    expect('filesRulesUnmatched' in matched).toBe(false);
    h.tree = null;
    const unread = await select({ mode: 'review' }, kb({ rules: [files(['**/*.twig'])] }));
    expect('filesRulesUnmatched' in unread).toBe(false);
  });

  it('selects a files rule that only a deleted file matches, with that glob', async () => {
    const dir = await repo();
    await rm(path.join(dir, 'b.txt'));
    h.tree = dir;
    h.setup = { output: { baseBranch: 'main' } };
    const scoped = (title: string, globs: string[]) =>
      rule({ title, spec: { mode: 'files', globs } });
    const out = await select(
      { mode: 'review' },
      kb({
        rules: [
          scoped('Deleted in a commit', ['docs/**']),
          scoped('Deleted in the working tree', ['b.txt']),
          scoped('Nothing changed here', ['**/*.twig']),
        ],
      }),
    );
    expect(Object.fromEntries(out.entries.map((e) => [e.title, e.why]))).toEqual({
      'Deleted in a commit': { scope: 'files', glob: 'docs/**' },
      'Deleted in the working tree': { scope: 'files', glob: 'b.txt' },
    });
  });

  it('selects a files rule that only the source of a staged rename matches, with that glob', async () => {
    const dir = await repo();
    await stageRenameOfBranchFile(dir);
    h.tree = dir;
    h.setup = { output: { baseBranch: 'main' } };
    const out = await select({ mode: 'review' }, kb({ rules: [files(['protected/**'])] }));
    expect(out.entries.map((e) => e.why)).toEqual([{ scope: 'files', glob: 'protected/**' }]);
  });

  it('shows every files rule, unscoped, when the change cannot be read', async () => {
    h.tree = null;
    const out = await select(
      { mode: 'review' },
      kb({ rules: [files(['**/*.tpl.php']), files(['**/*.twig'])] }),
    );
    expect(out.entries.map((e) => e.why)).toEqual([
      { scope: 'files', glob: null },
      { scope: 'files', glob: null },
    ]);
  });

  it('counts the files an issue plans to touch when the change is still empty', async () => {
    const dir = await repo();
    git(dir, 'checkout', '-q', 'main');
    h.tree = dir;
    const out = await select(
      { mode: 'write', estimatedFiles: ['./src/new.php'] },
      kb({ rules: [files(['src/*.php']), files(['web/*.css'])] }),
    );
    expect(out.entries.map((e) => e.why)).toEqual([{ scope: 'files', glob: 'src/*.php' }]);
  });

  it('carries the rows it refused into the omitted', async () => {
    const refused = [{ id: 'x', hash: 'h', title: 'Bad', why: 'refused' as const }];
    const out = await select({ mode: 'write' }, kb({ rules: [rule()], refused }));
    expect(out.omitted).toEqual(refused);
  });

  describe('the paths the task names', () => {
    const queries: SQL[] = [];
    let rows: Array<Record<string, unknown>> = [];
    let readFails: Error | null = null;
    const db = {
      execute: async (query: SQL) => {
        queries.push(query);
        if (readFails !== null) throw readFails;
        return rows;
      },
    } as unknown as Database;
    const task = (over: { title?: string; description?: string | null; spec?: string | null }) => {
      rows = [{ title: 'Task', description: null, spec: null, ...over }];
    };
    const lsFiles = () => h.gitCalls.filter((args) => args.includes('ls-files'));
    const titled = (title: string, globs: string[]) =>
      rule({ title, spec: { mode: 'files', globs } });
    const selectNamed = (
      request: Parameters<typeof selectForDispatch>[2],
      k: ReturnType<typeof kb>,
    ) => selectForDispatch(db, 'task-1', request, undefined, k);

    /** A tree with nothing changed, as at the first write dispatch; `tracked` is committed on main. */
    async function emptyTree(...tracked: string[]): Promise<void> {
      const dir = await repo();
      git(dir, 'checkout', '-q', 'main');
      for (const rel of tracked) await put(dir, rel);
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '--allow-empty', '-m', 'tracked');
      h.tree = dir;
      h.setup = { output: { baseBranch: 'main' } };
    }

    beforeEach(() => {
      queries.length = 0;
      rows = [];
      readFails = null;
      h.gitCalls = [];
      h.lsFilesFails = false;
    });

    it('selects a files rule through a path the description names, while the change is still empty', async () => {
      await emptyTree();
      task({ description: 'Replace the inline svg in `templates/node.tpl.php`.' });
      const out = await selectNamed({ mode: 'write' }, kb({ rules: [files(['**/*.tpl.php'])] }));
      expect(out.entries.map((e) => e.why)).toStrictEqual([
        { scope: 'files', glob: '**/*.tpl.php', via: 'named' },
      ]);
      expect('filesRulesUnmatched' in out).toBe(false);
      expect(queries).toHaveLength(1);
      expect(lsFiles()).toEqual([['ls-files', '-z']]);
    });

    it('reads the title and the spec as well as the description', async () => {
      await emptyTree();
      task({
        title: 'Tidy docs/old.md',
        description: 'Nothing here.',
        spec: 'Then `src/keep.php`.',
      });
      const rules = [files(['**/*.md']), files(['**/*.php']), files(['**/*.twig'])];
      const out = await selectNamed({ mode: 'write' }, kb({ rules }));
      expect(out.entries.map((e) => JSON.stringify(e.why)).sort()).toEqual([
        JSON.stringify({ scope: 'files', glob: '**/*.md', via: 'named' }),
        JSON.stringify({ scope: 'files', glob: '**/*.php', via: 'named' }),
      ]);
      expect(out.filesRulesUnmatched).toBe(1);
    });

    it('leaves the marker off a rule a written file matched, though the names are read all the same', async () => {
      h.tree = await repo();
      h.setup = { output: { baseBranch: 'main' } };
      task({ description: 'Edit templates/node.tpl.php.' });
      const out = await selectNamed({ mode: 'write' }, kb({ rules: [files(['**/*.tpl.php'])] }));
      expect(out.entries.map((e) => e.why)).toStrictEqual([
        { scope: 'files', glob: '**/*.tpl.php' },
      ]);
      expect(queries).toHaveLength(1);
    });

    it('resolves a path to the one tracked file it ends, so an anchored glob meets it and css/** does not', async () => {
      await emptyTree('sites/all/modules/custom/m/css/m.css');
      task({ description: 'Restyle css/m.css.' });
      const anchored = titled('Anchored', ['sites/all/modules/custom/**/*.css']);
      const rooted = titled('Rooted', ['css/**']);
      const out = await selectNamed({ mode: 'write' }, kb({ rules: [anchored, rooted] }));
      expect(out.entries.map((e) => e.title)).toEqual(['Anchored']);
      expect(out.filesRulesUnmatched).toBe(1);
    });

    it('keeps as written a path two tracked files end, and one no tracked file ends', async () => {
      await emptyTree('a/css/m.css', 'b/css/m.css');
      task({ description: 'Restyle css/m.css and add includes/new.inc.' });
      const rules = [
        titled('Rooted', ['css/**']),
        titled('New', ['includes/*.inc']),
        titled('Resolved', ['a/**/*.css']),
      ];
      const out = await selectNamed({ mode: 'write' }, kb({ rules }));
      expect(out.entries.map((e) => e.title).sort()).toEqual(['New', 'Rooted']);
    });

    it('reads nothing for a review, which is scoped by the change it checks', async () => {
      await emptyTree();
      task({ description: 'Edit templates/node.tpl.php.' });
      const out = await selectNamed({ mode: 'review' }, kb({ rules: [files(['**/*.tpl.php'])] }));
      expect(out.entries).toEqual([]);
      expect(out.filesRulesUnmatched).toBe(1);
      expect(queries).toHaveLength(0);
      expect(lsFiles()).toHaveLength(0);
    });

    it.each([[[]], [['src/other.php']]])(
      'reads nothing for a DAG coder, whose estimate is %j',
      async (estimatedFiles) => {
        await emptyTree();
        task({ description: 'Edit templates/node.tpl.php.' });
        const out = await selectNamed(
          { mode: 'write', estimatedFiles },
          kb({ rules: [files(['**/*.tpl.php'])] }),
        );
        expect(out.entries).toEqual([]);
        expect(out.filesRulesUnmatched).toBe(1);
        expect(queries).toHaveLength(0);
        expect(lsFiles()).toHaveLength(0);
      },
    );

    it('reads nothing when no files rule is enforced', async () => {
      await emptyTree();
      task({ description: 'Edit templates/node.tpl.php.' });
      const out = await selectNamed({ mode: 'write' }, kb({ rules: [rule()] }));
      expect(out.entries).toHaveLength(1);
      expect(queries).toHaveLength(0);
      expect(lsFiles()).toHaveLength(0);
    });

    it('reads nothing when the change could not be read, and shows the rule unscoped as it always did', async () => {
      h.tree = null;
      task({ description: 'Edit templates/node.tpl.php.' });
      const out = await selectNamed({ mode: 'write' }, kb({ rules: [files(['**/*.tpl.php'])] }));
      expect(out.entries.map((e) => e.why)).toStrictEqual([{ scope: 'files', glob: null }]);
      expect(queries).toHaveLength(0);
      expect(lsFiles()).toHaveLength(0);
    });

    it('reads nothing when the switch is off or the store could not be read', async () => {
      await emptyTree();
      task({ description: 'Edit templates/node.tpl.php.' });
      const rules = [files(['**/*.tpl.php'])];
      await selectNamed({ mode: 'write' }, kb({ rules, status: 'disabled' as const }));
      await selectNamed(
        { mode: 'write' },
        kb({ rules, status: 'unavailable' as const, errorClass: 'timeout' as const }),
      );
      expect(queries).toHaveLength(0);
      expect(lsFiles()).toHaveLength(0);
    });

    it('runs no git when the text names nothing, or the task has no row', async () => {
      await emptyTree();
      const rules = [files(['**/*.tpl.php'])];
      task({ description: 'Make the badge look right.' });
      const prose = await selectNamed({ mode: 'write' }, kb({ rules }));
      rows = [];
      const none = await selectNamed({ mode: 'write' }, kb({ rules }));
      expect(prose.entries).toEqual([]);
      expect(none).toStrictEqual(prose);
      expect(queries).toHaveLength(2);
      expect(lsFiles()).toHaveLength(0);
    });

    it('takes a failed read of the task for no names, and fails no dispatch', async () => {
      await emptyTree();
      const rules = [files(['**/*.tpl.php'])];
      task({ description: 'Make the badge look right.' });
      const without = await selectNamed({ mode: 'write' }, kb({ rules }));
      readFails = new Error('relation "tasks" does not exist');
      task({ description: 'Edit templates/node.tpl.php.' });
      const failed = await selectNamed({ mode: 'write' }, kb({ rules }));
      expect(failed).toStrictEqual(without);
      expect(lsFiles()).toHaveLength(0);
    });

    it('takes a failed git ls-files for no names, and fails no dispatch', async () => {
      await emptyTree();
      const rules = [files(['**/*.tpl.php'])];
      task({ description: 'Make the badge look right.' });
      const without = await selectNamed({ mode: 'write' }, kb({ rules }));
      h.lsFilesFails = true;
      task({ description: 'Edit templates/node.tpl.php.' });
      const failed = await selectNamed({ mode: 'write' }, kb({ rules }));
      expect(failed).toStrictEqual(without);
      expect(lsFiles()).toEqual([['ls-files', '-z']]);
    });

    it('reads each part of the task text up to a bound, since none of them has a length limit', async () => {
      await emptyTree();
      task({ description: 'Make the badge look right.' });
      await selectNamed({ mode: 'write' }, kb({ rules: [files(['**/*.css'])] }));
      const { sql: text } = new PgDialect().sqlToQuery(queries[0]!);
      const read = text.replace(/\s+/g, ' ');
      expect(read).toContain('select left("tasks"."title", $1::int) as title,');
      expect(read).toContain('left("tasks"."description", $2::int) as description,');
      expect(read).toContain(`(select left("task_steps"."output"->>'spec', $3::int) from`);
    });

    it('asks for the freshest spec: the highest round, then 05a over 05 over 04', async () => {
      await emptyTree();
      task({ description: 'Make the badge look right.' });
      await selectNamed({ mode: 'write' }, kb({ rules: [files(['**/*.css'])] }));
      const { sql: text, params } = new PgDialect().sqlToQuery(queries[0]!);
      expect(text.replace(/\s+/g, ' ')).toContain(
        'order by "task_steps"."round" desc, case "task_steps"."step_id" when $7 then 3 when $8 then 2 else 1 end desc limit 1',
      );
      expect(params).toEqual([
        262_144,
        262_144,
        262_144,
        '04-phase-0b-pre-planning',
        '05-phase-0b5-spec-quality',
        '05a-resolve-spec-warnings',
        '05a-resolve-spec-warnings',
        '05-phase-0b5-spec-quality',
        'task-1',
      ]);
    });
  });
});

describe('recordHouseRulesUnavailable', () => {
  const statements: string[] = [];
  const params: unknown[][] = [];
  const stub = (fail = false) => {
    statements.length = 0;
    params.length = 0;
    return {
      transaction: async (fn: (tx: unknown) => Promise<void>) => {
        if (fail) throw new Error('write CONNECT_TIMEOUT kb.internal.example:5432');
        await fn({
          execute: async (query: { queryChunks: unknown[] }) => {
            statements.push(
              query.queryChunks
                .map((c) =>
                  typeof c === 'object' && c && 'value' in c ? (c.value as string[]).join('') : '?',
                )
                .join(''),
            );
            params.push(query.queryChunks.filter((c) => typeof c === 'string'));
          },
        });
      },
    } as unknown as Database;
  };

  it('takes the task lock, then inserts the event only if the task has none, carrying the class alone', async () => {
    await recordHouseRulesUnavailable(stub(), 'task-1', 'timeout');
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('pg_advisory_xact_lock');
    expect(statements[1]).toContain('insert into');
    expect(statements[1]).toContain('where not exists');
    expect(params[0]).toEqual([`${HOUSE_RULES_UNAVAILABLE_EVENT}:task-1`]);
    expect(params[1]).toEqual([
      'task-1',
      HOUSE_RULES_UNAVAILABLE_EVENT,
      '{"errorClass":"timeout"}',
      'task-1',
      HOUSE_RULES_UNAVAILABLE_EVENT,
    ]);
  });

  it('never throws, and says nothing of why it failed', async () => {
    await expect(
      recordHouseRulesUnavailable(stub(true), 'task-1', 'other'),
    ).resolves.toBeUndefined();
  });
});
