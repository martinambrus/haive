import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';

const h = vi.hoisted(() => ({
  tree: null as string | null | Error,
  treeCalls: [] as Array<{ taskId: string; rel: string | undefined }>,
  setup: undefined as unknown,
}));

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
  HOUSE_RULES_UNAVAILABLE_EVENT,
  plannedFiles,
  readChangedFiles,
  readDispatchChange,
  recordHouseRulesUnavailable,
  selectForDispatch,
} from '../src/orchestrator/house-rules-dispatch.js';
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
