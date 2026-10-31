import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => {
  process.env.LOG_LEVEL = 'silent';
  return { db: undefined as unknown, queue: vi.fn(), add: vi.fn() };
});

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', async (load) => ({
  ...(await load<typeof import('../src/queues.js')>()),
  getPlanMirrorQueue: () => {
    h.queue();
    return { add: h.add };
  },
}));
vi.mock('../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
}));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: { get: async () => null, getBoolean: async () => true },
}));

import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { hardenGitArgs } from '@haive/shared/git-args';
import type { HaiveDataStatus } from '@haive/shared/haive-data';

// The real app, so the route is reached through the mount and the middleware a request meets.
const { createApiApp } = await import('../src/index.js');

const OTHER_USER = '00000000-0000-4000-8000-0000000000a2';
const REPO = '00000000-0000-4000-8000-0000000000c1';
const OTHER_REPO = '00000000-0000-4000-8000-0000000000c2';
const TASK_A = '00000000-0000-4000-8000-0000000000d1';
const TASK_B = '00000000-0000-4000-8000-0000000000d2';
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
const TABLES = {
  repositories: schema.repositories,
  tasks: schema.tasks,
  projectStateConflicts: schema.projectStateConflicts,
  projectStateOutbox: schema.projectStateOutbox,
  planMirrorState: schema.planMirrorState,
  projectStateSync: schema.projectStateSync,
};

const app = createApiApp('http://localhost:3000');

const PLAN = '.haive-data/plan.json';
const PLAN_MD = '.haive-data/plan.md';
const FORMAT = '.haive-data/state/format.json';
const RENDER = '.haive-data/state/project/render.json';
const COMMITTED = [PLAN, PLAN_MD, FORMAT, RENDER];
const unchanged = (rel: string) => ({ path: rel, change: 'unchanged', staged: false });

let base = '';
let home = '';
let root = '';
let shimDir = '';
let logFile = '';
let fake: ReturnType<typeof createFakeDb<typeof TABLES>>;
const savedPath = process.env.PATH;

function git(...args: string[]): string {
  return execFileSync(
    REAL_GIT,
    hardenGitArgs(['-C', root, ...args], { allowFileTransport: true }),
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
    },
  ).toString();
}

async function put(rel: string, text = 'x\n'): Promise<void> {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), text);
}

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'haive-data-status-'));
  home = path.join(base, 'home');
  root = path.join(home, 'repo');
  shimDir = path.join(base, 'shim');
  logFile = path.join(base, 'git.log');
  await mkdir(root, { recursive: true });
  await mkdir(shimDir);
  await writeFile(logFile, '');
  execFileSync(REAL_GIT, hardenGitArgs(['init', '-q', '-b', 'main', root]), { stdio: 'ignore' });
  git('config', 'gc.auto', '0');
  for (const rel of COMMITTED) await put(rel, '{}\n');
  await put('README.md', 'readme\n');
  git('add', '-A', '-f');
  git('commit', '-q', '-m', 'record');
  git('remote', 'add', 'origin', 'https://example.test/repo.git');
  fake = createFakeDb(TABLES);
  fake.insert(schema.repositories, { id: REPO, userId: USER, name: 'repo', storagePath: root });
  h.db = fake.db;
  h.queue.mockClear();
  h.add.mockClear();
});

afterEach(async () => {
  process.env.PATH = savedPath;
  await chmod(home, 0o755).catch(() => undefined);
  await rm(base, { recursive: true, force: true });
});

/** A git ahead of the real one on PATH: it logs its argv, and answers an argument it is told to
 *  fail with exit 128, or to flood with more output than the reader accepts. */
async function installShim(opts: { failArg?: string; floodArg?: string }): Promise<void> {
  const lines = ['#!/bin/sh', `echo "$*" >> '${logFile}'`];
  if (opts.failArg !== undefined || opts.floodArg !== undefined) {
    lines.push('for a in "$@"; do');
    if (opts.failArg !== undefined) {
      lines.push(
        `  if [ "$a" = '${opts.failArg}' ]; then echo "fatal: simulated failure" >&2; exit 128; fi`,
      );
    }
    if (opts.floodArg !== undefined) {
      lines.push(
        `  if [ "$a" = '${opts.floodArg}' ]; then head -c 1500000 /dev/zero | tr '\\0' a; exit 0; fi`,
      );
    }
    lines.push('done');
  }
  lines.push(`exec ${REAL_GIT} "$@"`, '');
  await writeFile(path.join(shimDir, 'git'), lines.join('\n'));
  await chmod(path.join(shimDir, 'git'), 0o755);
}

/** Every git call the api made, as its argv words. */
async function gitCalls(): Promise<string[][]> {
  return (await readFile(logFile, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' '));
}

async function ran(word: string): Promise<boolean> {
  return (await gitCalls()).some((args) => args.includes(word));
}

async function fetchStatus(opts: { failArg?: string; floodArg?: string; id?: string } = {}) {
  await installShim(opts);
  process.env.PATH = `${shimDir}:${savedPath}`;
  try {
    return await app.request(`/repositories/${opts.id ?? REPO}/haive-data`);
  } finally {
    process.env.PATH = savedPath;
  }
}

async function status(
  opts: { failArg?: string; floodArg?: string } = {},
): Promise<HaiveDataStatus> {
  const res = await fetchStatus(opts);
  expect(res.status).toBe(200);
  return (await res.json()) as HaiveDataStatus;
}

const CLEAN_HOLDS = { save: [], push: [] };

describe('GET /repositories/:id/haive-data', () => {
  it('reads a clean committed record: every file unchanged and nothing held', async () => {
    expect(await status()).toEqual({
      checkout: 'ready',
      branch: 'main',
      files: COMMITTED.map(unchanged),
      record: {
        dirty: false,
        writePending: false,
        lastError: null,
        syncError: null,
        syncedHead: null,
      },
      snapshot: { dirty: false, lastError: null },
      holds: CLEAN_HOLDS,
    });
    expect(h.queue).not.toHaveBeenCalled();
    expect(h.add).not.toHaveBeenCalled();
  });

  it('answers 404 for another user repository and reads nothing of it', async () => {
    fake.insert(schema.repositories, {
      id: OTHER_REPO,
      userId: OTHER_USER,
      name: 'theirs',
      storagePath: root,
    });
    const res = await fetchStatus({ id: OTHER_REPO });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'Repository not found' });
    expect(await gitCalls()).toEqual([]);
    expect(h.queue).not.toHaveBeenCalled();
  });

  it('answers 404 for a repository that does not exist', async () => {
    const res = await fetchStatus({ id: '00000000-0000-4000-8000-0000000000ff' });
    expect(res.status).toBe(404);
  });

  it('selects named columns only, so no repository column reaches the answer', async () => {
    fake.patch(schema.repositories, REPO, {
      onboardingTooling: { ragConnection: 'postgres://app:hunter2@db/app' },
    });
    const selects: unknown[] = [];
    const select = fake.db.select.bind(fake.db);
    fake.db.select = ((fields?: Record<string, unknown>) => {
      selects.push(fields);
      return select(fields);
    }) as typeof fake.db.select;
    const finds: unknown[] = [];
    const findFirst = fake.db.query.repositories.findFirst.bind(fake.db.query.repositories);
    fake.db.query.repositories.findFirst = ((opts?: Record<string, unknown>) => {
      finds.push(opts?.columns);
      return findFirst(opts);
    }) as typeof fake.db.query.repositories.findFirst;
    const res = await fetchStatus();
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(selects.length).toBeGreaterThan(0);
    expect(selects.every((fields) => fields !== undefined)).toBe(true);
    expect(finds.every((columns) => columns !== undefined)).toBe(true);
    expect(text).not.toContain('hunter2');
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual([
      'branch',
      'checkout',
      'files',
      'holds',
      'record',
      'snapshot',
    ]);
  });

  it('reads with the hardened argv and without taking the index lock', async () => {
    await status();
    const calls = await gitCalls();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((args) => args.includes('core.hooksPath=/dev/null'))).toBe(true);
    const statusCall = calls.find((args) => args.includes('status'));
    expect(statusCall).toBeDefined();
    expect(statusCall!.indexOf('--no-optional-locks')).toBeGreaterThan(-1);
    expect(statusCall!.indexOf('--no-optional-locks')).toBeLessThan(statusCall!.indexOf('status'));
    // Nothing that writes: no add, commit, fetch, push, checkout or config write.
    for (const word of ['add', 'commit', 'fetch', 'push', 'checkout', 'reset', 'update-index']) {
      expect(calls.some((args) => args.includes(word))).toBe(false);
    }
  });
});

describe('the state files', () => {
  it('reads a modified plan.json, unstaged and staged', async () => {
    await put(PLAN, 'edited\n');
    expect((await status()).files).toEqual([
      { path: PLAN, change: 'modified', staged: false },
      ...[PLAN_MD, FORMAT, RENDER].map(unchanged),
    ]);
    git('add', PLAN);
    expect((await status()).files).toEqual([
      { path: PLAN, change: 'modified', staged: true },
      ...[PLAN_MD, FORMAT, RENDER].map(unchanged),
    ]);
  });

  it('reads an added, a deleted and an untracked state file', async () => {
    await put('.haive-data/state/settings/new.json');
    git('add', '.haive-data/state/settings/new.json');
    await rm(path.join(root, RENDER));
    await put('.haive-data/state/untracked.json');
    expect((await status()).files).toEqual([
      unchanged(PLAN),
      unchanged(PLAN_MD),
      unchanged(FORMAT),
      { path: RENDER, change: 'deleted', staged: false },
      { path: '.haive-data/state/settings/new.json', change: 'added', staged: true },
      { path: '.haive-data/state/untracked.json', change: 'untracked', staged: false },
    ]);
  });

  it('reads a staged deletion and a staged modification of a state file', async () => {
    git('rm', '-q', FORMAT);
    await put(RENDER, 'edited\n');
    git('add', RENDER);
    expect((await status()).files).toEqual([
      unchanged(PLAN),
      unchanged(PLAN_MD),
      { path: FORMAT, change: 'deleted', staged: true },
      { path: RENDER, change: 'modified', staged: true },
    ]);
  });

  it('lists a path once when a staged deletion has its file back on disk', async () => {
    git('rm', '-q', '--cached', FORMAT);
    const files = (await status()).files!;
    expect(files.filter((file) => file.path === FORMAT)).toEqual([
      { path: FORMAT, change: 'modified', staged: true },
    ]);
  });

  it('reads a staged addition removed from disk as added', async () => {
    const rel = '.haive-data/state/added.json';
    await put(rel);
    git('add', rel);
    await rm(path.join(root, rel));
    expect((await status()).files).toContainEqual({ path: rel, change: 'added', staged: true });
  });

  it('reads an intent-to-add file as added and unstaged', async () => {
    await put('.haive-data/state/intent.json');
    git('add', '-N', '.haive-data/state/intent.json');
    const files = (await status()).files!;
    expect(files.filter((file) => file.path.endsWith('intent.json'))).toEqual([
      { path: '.haive-data/state/intent.json', change: 'added', staged: false },
    ]);
  });

  it('keeps names whole: a leading space, a trailing space, a newline and non-ASCII letters', async () => {
    const names = [
      '.haive-data/state/ lead.json',
      '.haive-data/state/trail.json ',
      '.haive-data/state/two\nlines.json',
      '.haive-data/state/été.json',
      '.haive-data/state/replacement-�.json',
      '.haive-data/state/"quoted".json',
    ];
    for (const rel of names) await put(rel);
    const files = (await status()).files!;
    expect(files.filter((file) => file.change === 'untracked').map((file) => file.path)).toEqual(
      [...names].sort(),
    );
  });

  it.each([false, true])('refuses lossy filename decoding (tracked: %s)', async (tracked) => {
    for (const byte of [0x80, 0x81]) {
      const name = Buffer.concat([
        Buffer.from(`${root}/.haive-data/state/invalid-`),
        Buffer.from([byte]),
        Buffer.from('.json'),
      ]);
      await writeFile(name, '{}\n');
    }
    if (tracked) {
      git('add', '-f', '.haive-data/state');
      git('commit', '-q', '-m', 'byte names');
    }
    const body = await status();
    expect(body.files).toBeNull();
    expect(body.checkout).toBe('ready');
    expect(body.holds).toEqual(CLEAN_HOLDS);
  });

  it('keeps a modified tracked name that starts or ends with a space', async () => {
    await put('.haive-data/state/ lead.json');
    await put('.haive-data/state/tail.json ');
    git('add', '-f', '.haive-data/state/ lead.json', '.haive-data/state/tail.json ');
    git('commit', '-q', '-m', 'spaces');
    await put('.haive-data/state/ lead.json', 'edited\n');
    await put('.haive-data/state/tail.json ', 'edited\n');
    const files = (await status()).files!;
    expect(files).toEqual([
      unchanged(PLAN),
      unchanged(PLAN_MD),
      { path: '.haive-data/state/ lead.json', change: 'modified', staged: false },
      unchanged(FORMAT),
      unchanged(RENDER),
      { path: '.haive-data/state/tail.json ', change: 'modified', staged: false },
    ]);
  });

  it('lists nothing outside the plan files and the state directory', async () => {
    await put('README.md', 'edited\n');
    await put('.haive-data/other.json');
    await put('.haive-data/state-other/x.json');
    await put('.haive-data/.state-writes/x');
    await put('src/app.ts');
    expect((await status()).files).toEqual(COMMITTED.map(unchanged));
  });

  it('reads an unmerged state file as modified and unstaged', async () => {
    git('checkout', '-q', '-b', 'other');
    await put(FORMAT, 'theirs\n');
    git('commit', '-q', '-am', 'theirs');
    git('checkout', '-q', 'main');
    await put(FORMAT, 'ours\n');
    git('commit', '-q', '-am', 'ours');
    expect(() => git('merge', '-q', 'other')).toThrow();
    const body = await status();
    expect(body.files).toContainEqual({ path: FORMAT, change: 'modified', staged: false });
    expect(body.holds.save).toEqual([{ code: 'git_operation' }]);
  });

  it.each(['status', 'ls-files'])(
    'reads files as null when git %s fails, with the holds still answered',
    async (sub) => {
      await put(PLAN, 'edited\n');
      const body = await status({ failArg: sub });
      expect(body.files).toBeNull();
      expect(body.checkout).toBe('ready');
      expect(body.holds).toEqual(CLEAN_HOLDS);
    },
  );

  it.each(['status', 'ls-files'])('reads files as null when git %s outgrows 1 MiB', async (sub) => {
    const body = await status({ floodArg: sub });
    expect(body.files).toBeNull();
    expect(body.holds).toEqual(CLEAN_HOLDS);
  });
});

describe('the checkout', () => {
  it('reads a missing checkout: only checkout_missing, no files, nothing from git', async () => {
    fake.patch(schema.repositories, REPO, { storagePath: path.join(base, 'gone') });
    expect(await status()).toMatchObject({
      checkout: 'missing',
      branch: null,
      files: null,
      holds: {
        save: [{ code: 'checkout_missing' }],
        push: [{ code: 'checkout_missing' }],
      },
    });
    expect(await gitCalls()).toEqual([]);
  });

  it('reads a repository with no checkout path as missing', async () => {
    fake.patch(schema.repositories, REPO, { storagePath: null, localPath: null });
    expect(await status()).toMatchObject({
      checkout: 'missing',
      files: null,
      holds: { save: [{ code: 'checkout_missing' }], push: [{ code: 'checkout_missing' }] },
    });
  });

  it('falls back to the local path when there is no storage path', async () => {
    fake.patch(schema.repositories, REPO, { storagePath: null, localPath: root });
    expect(await status()).toMatchObject({ checkout: 'ready', branch: 'main', holds: CLEAN_HOLDS });
  });

  it('reads a folder with no .git as not_git, and asks git nothing', async () => {
    const plain = path.join(base, 'plain');
    await mkdir(plain);
    fake.patch(schema.repositories, REPO, { storagePath: plain });
    expect(await status()).toMatchObject({
      checkout: 'not_git',
      branch: null,
      files: null,
      holds: { save: [{ code: 'not_git_checkout' }], push: [{ code: 'not_git_checkout' }] },
    });
    expect(await gitCalls()).toEqual([]);
  });

  it('does not borrow the parent repository for a nested folder with no .git', async () => {
    const nested = path.join(root, 'nested');
    await mkdir(nested);
    fake.patch(schema.repositories, REPO, { storagePath: nested });
    expect(await status()).toMatchObject({
      checkout: 'not_git',
      holds: { save: [{ code: 'not_git_checkout' }], push: [{ code: 'not_git_checkout' }] },
    });
    expect(await gitCalls()).toEqual([]);
  });

  it('reads a .git that is a symlink as unreadable and reads nothing after it', async () => {
    await rename(path.join(root, '.git'), path.join(base, 'real.git'));
    await symlink(path.join(base, 'real.git'), path.join(root, '.git'));
    expect(await status()).toMatchObject({
      checkout: 'unreadable',
      branch: null,
      files: null,
      holds: { save: [{ code: 'checkout_unreadable' }], push: [{ code: 'checkout_unreadable' }] },
    });
    expect(await gitCalls()).toEqual([]);
  });

  it('reads a .git that git refuses as unreadable and reads nothing after the probe', async () => {
    await rm(path.join(root, '.git'), { recursive: true });
    await mkdir(path.join(root, '.git'));
    expect(await status()).toMatchObject({
      checkout: 'unreadable',
      files: null,
      holds: { save: [{ code: 'checkout_unreadable' }], push: [{ code: 'checkout_unreadable' }] },
    });
    expect(await gitCalls()).toHaveLength(1);
    expect(await ran('--is-inside-work-tree')).toBe(true);
  });

  it('reads a work-tree probe that fails as unreadable and reads nothing after it', async () => {
    expect(await status({ failArg: '--is-inside-work-tree' })).toMatchObject({
      checkout: 'unreadable',
      files: null,
      holds: { save: [{ code: 'checkout_unreadable' }], push: [{ code: 'checkout_unreadable' }] },
    });
    for (const word of ['--git-path', '--show-current', 'get-url', 'ls-files', 'status']) {
      expect(await ran(word)).toBe(false);
    }
  });

  it.skipIf(process.getuid?.() === 0)(
    'reads a checkout whose parent cannot be searched as unreadable, not missing',
    async () => {
      await chmod(home, 0o000);
      try {
        expect(await status()).toMatchObject({
          checkout: 'unreadable',
          files: null,
          holds: {
            save: [{ code: 'checkout_unreadable' }],
            push: [{ code: 'checkout_unreadable' }],
          },
        });
      } finally {
        await chmod(home, 0o755);
      }
    },
  );
});

describe('an open git operation', () => {
  it.each([
    ['MERGE_HEAD', 'file'],
    ['REBASE_HEAD', 'file'],
    ['rebase-merge', 'directory'],
    ['rebase-apply', 'directory'],
    ['CHERRY_PICK_HEAD', 'file'],
    ['REVERT_HEAD', 'file'],
  ] as const)('holds on %s', async (entry, kind) => {
    const target = path.join(root, '.git', entry);
    if (kind === 'file') await writeFile(target, `${git('rev-parse', 'HEAD').trim()}\n`);
    else await mkdir(target);
    expect((await status()).holds).toEqual({
      save: [{ code: 'git_operation' }],
      push: [{ code: 'git_operation' }],
    });
  });

  it('holds on a merge a conflict left open', async () => {
    git('checkout', '-q', '-b', 'other');
    await put('a.txt', 'theirs\n');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'theirs');
    git('checkout', '-q', 'main');
    await put('a.txt', 'ours\n');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'ours');
    expect(() => git('merge', '-q', 'other')).toThrow();
    expect((await status()).holds.save).toEqual([{ code: 'git_operation' }]);
  });

  it('ignores a branch or tag named like a pseudoref', async () => {
    git('branch', 'MERGE_HEAD');
    git('tag', 'REBASE_HEAD');
    expect((await status()).holds).toEqual(CLEAN_HOLDS);
  });

  it('reads a git dir outside the checkout as an open operation', async () => {
    git('init', '-q', '--separate-git-dir', path.join(base, 'elsewhere.git'));
    expect((await status()).holds.save).toEqual([{ code: 'git_operation' }]);
  });

  it('reads the open operation as unreadable when git cannot say, never as none', async () => {
    const body = await status({ failArg: '--git-path' });
    expect(body.holds).toEqual({
      save: [{ code: 'git_operation_unreadable' }],
      push: [{ code: 'git_operation_unreadable' }],
    });
  });
});

describe('the push holds', () => {
  it('holds a detached HEAD for push only', async () => {
    git('checkout', '-q', '--detach');
    expect(await status()).toMatchObject({
      branch: null,
      holds: { save: [], push: [{ code: 'detached_head' }] },
    });
  });

  it('holds a missing origin for push only', async () => {
    git('remote', 'remove', 'origin');
    expect(await status()).toMatchObject({
      branch: 'main',
      holds: { save: [], push: [{ code: 'no_origin' }] },
    });
  });

  it('holds both, in the order Save checks them', async () => {
    git('checkout', '-q', '--detach');
    git('remote', 'remove', 'origin');
    expect((await status()).holds).toEqual({
      save: [],
      push: [{ code: 'detached_head' }, { code: 'no_origin' }],
    });
  });

  it('reads the branch as unreadable for push only, never as detached', async () => {
    expect(await status({ failArg: '--show-current' })).toMatchObject({
      branch: null,
      holds: { save: [], push: [{ code: 'branch_unreadable' }] },
    });
  });

  it('reads the origin as unreadable for push only, never as missing', async () => {
    expect((await status({ failArg: 'get-url' })).holds).toEqual({
      save: [],
      push: [{ code: 'origin_unreadable' }],
    });
  });

  it.each(['url', 'pushurl'])(
    'reads an origin %s the remote rule refuses as unreadable',
    async (key) => {
      git('config', `remote.origin.${key}`, path.join(base, 'other-user.git'));
      expect((await status()).holds).toEqual({ save: [], push: [{ code: 'origin_unreadable' }] });
    },
  );

  it('keeps every other hold in both lists and adds the push holds after them', async () => {
    git('checkout', '-q', '--detach');
    await writeFile(path.join(root, '.git', 'MERGE_HEAD'), `${git('rev-parse', 'HEAD').trim()}\n`);
    expect((await status()).holds).toEqual({
      save: [{ code: 'git_operation' }],
      push: [{ code: 'git_operation' }, { code: 'detached_head' }],
    });
  });
});

describe('what holds a Save', () => {
  type Row = Record<string, unknown>;
  const task = (row: Row) => ({
    userId: USER,
    repositoryId: REPO,
    type: 'onboarding',
    status: 'running',
    ...row,
  });

  it('holds on a live onboarding task and an onboarding upgrade, ordered by id', async () => {
    fake.insert(schema.tasks, task({ id: TASK_B, type: 'onboarding_upgrade', status: 'paused' }));
    fake.insert(schema.tasks, task({ id: TASK_A }));
    const expected = [{ code: 'checkout_held', taskIds: [TASK_A, TASK_B] }];
    expect((await status()).holds).toEqual({ save: expected, push: expected });
  });

  it.each(['queued', 'running', 'paused', 'waiting_user', 'waiting_pr'])(
    'counts an onboarding task in %s',
    async (state) => {
      fake.insert(schema.tasks, task({ id: TASK_A, status: state }));
      expect((await status()).holds.save).toEqual([{ code: 'checkout_held', taskIds: [TASK_A] }]);
    },
  );

  it.each(['created', 'completed', 'failed', 'cancelled'])(
    'does not count an onboarding task in %s',
    async (state) => {
      fake.insert(schema.tasks, task({ status: state }));
      expect((await status()).holds).toEqual(CLEAN_HOLDS);
    },
  );

  it('does not count a dead task, another type or another repository', async () => {
    fake.insert(schema.tasks, task({ deadAt: new Date() }));
    fake.insert(schema.tasks, task({ type: 'workflow' }));
    fake.insert(schema.tasks, task({ type: 'plan_build' }));
    fake.insert(schema.repositories, { id: OTHER_REPO, userId: USER, name: 'other' });
    fake.insert(schema.tasks, task({ repositoryId: OTHER_REPO }));
    expect((await status()).holds).toEqual(CLEAN_HOLDS);
  });

  it.each(['created', 'queued', 'running', 'paused', 'waiting_user'])(
    'holds on a plan merge in %s',
    async (state) => {
      fake.insert(schema.tasks, task({ id: TASK_A, type: 'plan_merge', status: state }));
      const expected = [{ code: 'plan_merge', taskId: TASK_A }];
      expect((await status()).holds).toEqual({ save: expected, push: expected });
    },
  );

  it.each(['waiting_pr', 'completed', 'failed', 'cancelled'])(
    'does not hold on a plan merge in %s',
    async (state) => {
      fake.insert(schema.tasks, task({ type: 'plan_merge', status: state }));
      expect((await status()).holds).toEqual(CLEAN_HOLDS);
    },
  );

  it('does not hold on a plan merge of another repository', async () => {
    fake.insert(schema.repositories, { id: OTHER_REPO, userId: USER, name: 'other' });
    fake.insert(schema.tasks, task({ type: 'plan_merge', repositoryId: OTHER_REPO }));
    expect((await status()).holds).toEqual(CLEAN_HOLDS);
  });

  it('lists an open question about the record and leaves a plan question out', async () => {
    fake.insert(schema.projectStateConflicts, {
      repositoryId: REPO,
      unit: 'project/render.json#framework',
    });
    fake.insert(schema.projectStateConflicts, { repositoryId: REPO, unit: 'plan/abc#title' });
    const expected = [
      { code: 'project_state_questions', units: ['project/render.json#framework'] },
    ];
    expect((await status()).holds).toEqual({ save: expected, push: expected });
  });

  it('does not list a plan question alone, an answered one or another repository', async () => {
    fake.insert(schema.projectStateConflicts, { repositoryId: REPO, unit: 'plan/abc#title' });
    fake.insert(schema.projectStateConflicts, {
      repositoryId: REPO,
      unit: 'project/render.json#framework',
      resolvedAt: new Date(),
    });
    fake.insert(schema.repositories, { id: OTHER_REPO, userId: USER, name: 'other' });
    fake.insert(schema.projectStateConflicts, {
      repositoryId: OTHER_REPO,
      unit: 'project/render.json#framework',
    });
    expect((await status()).holds).toEqual(CLEAN_HOLDS);
  });

  it('holds on a pending record write and reports it', async () => {
    fake.insert(schema.projectStateOutbox, {
      repositoryId: REPO,
      revision: 3,
      writtenRevision: 2,
      writeIntent: { files: ['x'] },
    });
    const expected = [{ code: 'write_pending' }];
    expect(await status()).toMatchObject({
      record: { dirty: true, writePending: true },
      holds: { save: expected, push: expected },
    });
  });

  it('reports a dirty record and a dirty snapshot without holding on them', async () => {
    fake.insert(schema.projectStateOutbox, { repositoryId: REPO, revision: 3, writtenRevision: 2 });
    fake.insert(schema.planMirrorState, { repositoryId: REPO, revision: 5, writtenRevision: 4 });
    expect(await status()).toMatchObject({
      record: { dirty: true, writePending: false },
      snapshot: { dirty: true },
      holds: CLEAN_HOLDS,
    });
  });

  it('reports a settled record and snapshot as clean', async () => {
    fake.insert(schema.projectStateOutbox, { repositoryId: REPO, revision: 3, writtenRevision: 3 });
    fake.insert(schema.planMirrorState, { repositoryId: REPO, revision: 5, writtenRevision: 5 });
    expect(await status()).toMatchObject({
      record: { dirty: false, writePending: false },
      snapshot: { dirty: false },
    });
  });

  it('holds on a live root claim, not on a stale one', async () => {
    fake.patch(schema.repositories, REPO, { rootClaimedAt: new Date() });
    const expected = [{ code: 'root_claim' }];
    expect((await status()).holds).toEqual({ save: expected, push: expected });
    fake.patch(schema.repositories, REPO, { rootClaimedAt: new Date(Date.now() - 3_600_000) });
    expect((await status()).holds).toEqual(CLEAN_HOLDS);
  });

  it('lists every hold in the order the Save checks them', async () => {
    fake.patch(schema.repositories, REPO, { rootClaimedAt: new Date() });
    fake.insert(schema.tasks, task({ id: TASK_A }));
    fake.insert(schema.tasks, task({ id: TASK_B, type: 'plan_merge' }));
    fake.insert(schema.projectStateOutbox, {
      repositoryId: REPO,
      revision: 1,
      writtenRevision: 0,
      writeIntent: { files: [] },
    });
    fake.insert(schema.projectStateConflicts, {
      repositoryId: REPO,
      unit: 'project/render.json#framework',
    });
    await writeFile(path.join(root, '.git', 'MERGE_HEAD'), `${git('rev-parse', 'HEAD').trim()}\n`);
    expect((await status()).holds.save.map((hold) => hold.code)).toEqual([
      'root_claim',
      'checkout_held',
      'write_pending',
      'git_operation',
      'plan_merge',
      'project_state_questions',
    ]);
  });
});

describe('the last errors', () => {
  it('scrubs an absolute path out of each, and reports the synced head', async () => {
    fake.insert(schema.projectStateOutbox, {
      repositoryId: REPO,
      revision: 1,
      writtenRevision: 0,
      lastError: `EACCES: permission denied, open '${root}/.haive-data/state/format.json'`,
    });
    fake.insert(schema.planMirrorState, {
      repositoryId: REPO,
      revision: 1,
      writtenRevision: 0,
      lastError: `git status failed in ${root}: fatal: bad config`,
    });
    fake.insert(schema.projectStateSync, {
      repositoryId: REPO,
      baseSnapshot: {},
      lastError: `could not read "${root}/.haive-data/state" (ENOENT)`,
      syncedHead: 'a'.repeat(40),
    });
    const body = await status();
    expect(body.record).toEqual({
      dirty: true,
      writePending: false,
      lastError: "EACCES: permission denied, open '[path]'",
      syncError: 'could not read "[path]" (ENOENT)',
      syncedHead: 'a'.repeat(40),
    });
    expect(body.snapshot).toEqual({
      dirty: true,
      lastError: 'git status failed in [path]: fatal: bad config',
    });
    expect(JSON.stringify(body)).not.toContain(base);
  });
});
