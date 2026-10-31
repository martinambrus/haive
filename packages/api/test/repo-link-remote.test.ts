import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFileSync, type ChildProcess, type ExecFileOptions } from 'node:child_process';
const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({ db: undefined as unknown, git: vi.fn(), entry: vi.fn() }));
vi.mock('@haive/shared/fs-safe', async (original) => ({
  ...(await original<typeof import('@haive/shared/fs-safe')>()),
  lstatNoFollow: h.entry,
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set(key: string, value: string): void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: h.git }) };
});
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { hardenGitArgs } from '@haive/shared/git-args';
import { repoRoutes } from '../src/routes/repos.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const app = new Hono<AppEnv>();
app.route('/', repoRoutes);
app.onError(errorHandler);
let fake: ReturnType<typeof createFakeDb>;
beforeEach(() => {
  fake = createFakeDb({
    repositories: schema.repositories,
    auditEvents: schema.auditEvents,
    repoCredentials: schema.repoCredentials,
  });
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: 'repo',
    storagePath: '/repo',
    remoteUrl: null,
  });
  h.db = fake.db;
  h.entry.mockReset().mockResolvedValue({ kind: 'directory' });
  h.git.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
});
const link = () =>
  app.request(`/${REPO}/remote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ remoteUrl: 'https://example.test/r' }),
  });
const fail = (code: number | string, stderr: string) =>
  Object.assign(new Error(stderr), { code, stderr });

// The controls that fake the clock still wait on real children, so these keep the real timers.
const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;
const sleep = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms));

/** The pending value, or an error naming the wait when `ms` pass first. */
async function answeredWithin<T>(ms: number, pending: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = realSetTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    realClearTimeout(timer);
  }
}

/** Resolves once `ready()` holds, or fails naming what never happened. */
async function until(what: string, ready: () => boolean): Promise<void> {
  for (let waited = 0; !ready(); waited += 10) {
    if (waited >= 3_000) throw new Error(`${what} did not happen within 3000 ms`);
    await sleep(10);
  }
}

// The relink's git child gets 10 s before SIGTERM, then 2 s before SIGKILL.
const DEADLINE_MS = 10_000;
const GRACE_MS = 2_000;
let realExecFile!: typeof import('node:child_process').execFile;
let child: ChildProcess | undefined;
const dirs: string[] = [];
beforeAll(async () => {
  ({ execFile: realExecFile } =
    await vi.importActual<typeof import('node:child_process')>('node:child_process'));
});
afterEach(async () => {
  vi.useRealTimers();
  child?.kill('SIGKILL');
  child = undefined;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A real child run in place of the route's git, with the options the route passed except its
 *  directory, which is fake. A deadline left to execFile (`timeout`) is cut to 200 ms, since the
 *  fake clock does not drive it; the route's own timers are driven by the fake clock. Not async:
 *  the route reads `.child` off the promise. */
const startChild = (command: string, args: string[], options: ExecFileOptions, cwd: string) => {
  const run = promisify(realExecFile)(command, args, {
    ...options,
    cwd,
    ...(options.timeout ? { timeout: 200 } : {}),
  });
  child = run.child;
  return run;
};
const alive = (c: ChildProcess) => c.exitCode === null && c.signalCode === null;

describe('link origin uses git exit codes', () => {
  it('updates after exit 3 regardless of human wording', async () => {
    h.git
      .mockResolvedValueOnce({ stdout: 'true\n', stderr: '' })
      .mockRejectedValueOnce(fail(3, 'different language'))
      .mockResolvedValueOnce({ stdout: 'https://old.test/r', stderr: '' })
      .mockRejectedValueOnce(fail(1, 'no push URL'));
    expect((await link()).status).toBe(200);
    expect(h.git.mock.calls[4]![1]).toContain('--unset-all');
    expect(h.git.mock.calls[5]![1]).toContain('--replace-all');
    expect(fake.rows(schema.repositories)[0]!.remoteUrl).toBe('https://example.test/r');
  });
  it('does not mistake an unrelated failure with already-exists words for exit 3', async () => {
    h.git
      .mockResolvedValueOnce({ stdout: 'true\n', stderr: '' })
      .mockRejectedValueOnce(fail(128, 'remote origin already exists'));
    expect((await link()).status).toBe(409);
    expect(h.git).toHaveBeenCalledTimes(2);
    expect(fake.rows(schema.repositories)[0]!.remoteUrl).toBeNull();
  });
  it('fails a non-zero URL replacement without persisting the row', async () => {
    h.git
      .mockResolvedValueOnce({ stdout: 'true\n', stderr: '' })
      .mockRejectedValueOnce(fail(3, 'remote origin already exists'))
      .mockResolvedValueOnce({ stdout: 'https://old.test/r', stderr: '' })
      .mockRejectedValueOnce(fail(1, 'no push URL'))
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(fail(128, 'broken config'));
    const res = await link();
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('Could not update');
    expect(fake.rows(schema.repositories)[0]!.remoteUrl).toBeNull();
  });
});
it.each([0, 5])('accepts push URL cleanup exit %s', async (code) => {
  h.git
    .mockResolvedValueOnce({ stdout: 'true\n', stderr: '' })
    .mockRejectedValueOnce(fail(3, 'different language'))
    .mockResolvedValueOnce({ stdout: 'https://old.test/r', stderr: '' })
    .mockRejectedValueOnce(fail(1, 'no push URL'));
  if (code === 5) h.git.mockRejectedValueOnce(fail(5, 'missing key'));
  expect((await link()).status).toBe(200);
  expect(h.git.mock.calls[4]![1]).toContain('--unset-all');
});
it('does not persist a relink whose push URL cleanup failed', async () => {
  h.git
    .mockResolvedValueOnce({ stdout: 'true\n', stderr: '' })
    .mockRejectedValueOnce(fail(3, 'different language'))
    .mockResolvedValueOnce({ stdout: 'https://old.test/r', stderr: '' })
    .mockRejectedValueOnce(fail(1, 'no push URL'))
    .mockRejectedValueOnce(fail(128, 'different language'));
  const response = await link();
  expect(response.status).toBe(409);
  expect(await response.text()).toContain("Could not clear the remote's push URLs");
  expect(h.git.mock.calls.at(-1)![1]).toEqual(
    expect.arrayContaining(['--unset-all', 'remote.origin.pushurl']),
  );
  expect(fake.rows(schema.repositories)[0]!.remoteUrl).toBeNull();
});

it.each([false, true])(
  'refuses a remote with a mismatched credential (retained=%s) before touching git',
  async (retained) => {
    const credentialId = '00000000-0000-4000-8000-0000000000c1';
    fake.insert(schema.repoCredentials, {
      id: credentialId,
      userId: USER,
      host: 'other.example.test',
    });
    if (retained)
      await fake.db
        .update(schema.repositories)
        .set({ credentialsSecretId: credentialId })
        .where(eq(schema.repositories.id, REPO));
    h.git.mockResolvedValueOnce({ stdout: 'true\n', stderr: '' });
    const res = await app.request(`/${REPO}/remote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        remoteUrl: 'https://example.test/r',
        ...(retained ? {} : { credentialsId: credentialId }),
      }),
    });
    expect(res.status).toBe(400);
    expect(h.git).not.toHaveBeenCalled();
    expect(fake.rows(schema.repositories)[0]!.remoteUrl).toBeNull();
  },
);

it('rechecks a retained credential binding changed between the initial and locked reads', async () => {
  const fitting = '00000000-0000-4000-8000-0000000000c1';
  const changed = '00000000-0000-4000-8000-0000000000c2';
  fake.insert(schema.repoCredentials, { id: fitting, userId: USER, host: 'example.test' });
  fake.insert(schema.repoCredentials, { id: changed, userId: USER, host: 'other.example.test' });
  fake.patch(schema.repositories, REPO, { credentialsSecretId: fitting });
  const transaction = fake.db.transaction.bind(fake.db);
  vi.spyOn(fake.db, 'transaction').mockImplementation(async (fn) => {
    fake.patch(schema.repositories, REPO, { credentialsSecretId: changed });
    return transaction(fn);
  });
  h.git.mockResolvedValueOnce({ stdout: 'true\n', stderr: '' });
  const response = await link();
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: 'The Git credential does not fit the remote',
  });
  expect(h.git).toHaveBeenCalledTimes(1); // Only the pre-transaction checkout probe.
  expect(fake.rows(schema.repositories)[0]).toMatchObject({
    remoteUrl: null,
    credentialsSecretId: changed,
  });
  expect(fake.rows(schema.auditEvents)).toEqual([]);
});

it('waits for a disconnected transaction callback before restoring the remote', async () => {
  const old = 'https://old.test/r';
  const next = 'https://example.test/r';
  fake.patch(schema.repositories, REPO, { remoteUrl: old });
  let checkout = old;
  const events: string[] = [];
  let reached!: () => void;
  let release!: () => void;
  let disconnect!: (error: Error) => void;
  const atWrite = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  const dropped = new Promise<never>((_resolve, reject) => {
    disconnect = reject;
  });
  const failure = new Error('connection closed');
  let callback!: Promise<unknown>;
  h.db = new Proxy(fake.db, {
    get(target, key) {
      if (key === 'transaction')
        return (fn: (tx: any) => Promise<unknown>) => {
          callback = target.transaction((tx) =>
            fn(
              new Proxy(tx, {
                get(t, prop) {
                  if (prop === 'update')
                    return () => ({
                      set: () => ({
                        where: async () => {
                          throw failure;
                        },
                      }),
                    });
                  const value = Reflect.get(t, prop);
                  return typeof value === 'function' ? value.bind(t) : value;
                },
              }),
            ),
          );
          // postgres.js can reject on connection close before its callback finishes.
          return Promise.race([callback, dropped]);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  h.git.mockImplementation(async (_command, args: string[]) => {
    if (args.includes('rev-parse')) return { stdout: 'true', stderr: '' };
    if (args.includes('remote') && args.includes('add')) throw fail(3, 'exists');
    if (args.includes('--get-all')) {
      if (args.at(-1) === 'remote.origin.url') return { stdout: checkout, stderr: '' };
      throw fail(1, 'absent');
    }
    if (args.includes('--replace-all')) {
      const value = args.at(-1)!;
      if (value === next) {
        reached();
        await resume;
      }
      checkout = value;
      events.push(value === next ? 'write finished' : 'restored');
    }
    return { stdout: '', stderr: '' };
  });
  const response = Promise.resolve(link());
  try {
    await atWrite;
    disconnect(failure);
    // Drain the rejection continuation while the git child remains held.
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    release();
  }
  await callback.catch(() => undefined);
  expect((await response).status).toBe(500);
  expect(events).toEqual(['write finished', 'restored']);
  expect(checkout).toBe(old);
  expect(fake.rows(schema.repositories)[0]!.remoteUrl).toBe(old);
  expect(fake.rows(schema.auditEvents)).toEqual([]);
});

it('stops a timed-out git write with SIGTERM, so git removes its own lock file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'relink-lock-'));
  dirs.push(dir);
  // git locks `config` as `config.lock`, then opens the old file to read it. A FIFO with no writer
  // holds that read, and with it the write inside its lock window. Inside a repository git reads
  // `.git/config` before it locks, so the route's own `remote add` cannot be held there: a real
  // `config --file` write, run outside any repository, stands in for it.
  const config = path.join(dir, 'repo', '.git', 'config');
  await mkdir(path.dirname(config), { recursive: true });
  execFileSync('mkfifo', [config]);
  const outside = path.join(dir, 'outside');
  await mkdir(outside);
  h.git.mockImplementation((_command, args: string[], options: ExecFileOptions) =>
    args.includes('rev-parse')
      ? Promise.resolve({ stdout: 'true', stderr: '' })
      : startChild(
          'git',
          hardenGitArgs([
            'config',
            '--file',
            config,
            'remote.origin.url',
            'https://example.test/r',
          ]),
          options,
          outside,
        ),
  );
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const response = Promise.resolve(link());
  await until('git took its lock', () => existsSync(`${config}.lock`));
  await vi.advanceTimersByTimeAsync(DEADLINE_MS);
  expect((await answeredWithin(3_000, response)).status).toBe(409);
  expect(existsSync(`${config}.lock`)).toBe(false);
  expect(child!.signalCode).toBe('SIGTERM');
  expect(vi.getTimerCount()).toBe(0);
});

it('kills a git child that traps SIGTERM once the grace after the deadline is over', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'relink-trap-'));
  dirs.push(dir);
  const told = path.join(dir, 'told-to-stop');
  const ready = path.join(dir, 'ready');
  // A git that notes SIGTERM and carries on.
  const script = `trap ': > "$1"' TERM; : > "$2"; while :; do sleep 0.05; done`;
  h.git.mockImplementation((_command, args: string[], options: ExecFileOptions) =>
    args.includes('rev-parse')
      ? Promise.resolve({ stdout: 'true', stderr: '' })
      : startChild('sh', ['-c', script, 'sh', told, ready], options, dir),
  );
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const response = Promise.resolve(link());
  await until('the child trapped SIGTERM', () => existsSync(ready));
  await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
  expect(existsSync(told)).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await until('the deadline sent SIGTERM', () => existsSync(told));
  await sleep(100);
  expect(alive(child!)).toBe(true);
  await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
  await sleep(100);
  expect(alive(child!)).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect((await answeredWithin(3_000, response)).status).toBe(409);
  expect(child!.signalCode).toBe('SIGKILL');
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  ['answers', undefined],
  ['fails', fail(128, 'broken config')],
])('leaves no timer behind when git %s in time', async (_outcome, failure) => {
  h.git.mockResolvedValueOnce({ stdout: 'true\n', stderr: '' });
  if (failure) h.git.mockRejectedValueOnce(failure);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  expect((await link()).status).toBe(failure ? 409 : 200);
  expect(vi.getTimerCount()).toBe(0);
});

it('answers with the failed restore, not the lost connection, when the callback cannot restore', async () => {
  const old = 'https://old.test/r';
  fake.patch(schema.repositories, REPO, { remoteUrl: old });
  const failure = new Error('connection closed');
  let drop!: (error: Error) => void;
  const dropped = new Promise<never>((_resolve, reject) => {
    drop = reject;
  });
  h.db = new Proxy(fake.db, {
    get(target, key) {
      if (key === 'transaction')
        return (fn: (tx: any) => Promise<unknown>) =>
          // postgres.js can reject on connection close before its callback finishes.
          Promise.race([
            target.transaction((tx) =>
              fn(
                new Proxy(tx, {
                  get(t, prop) {
                    if (prop === 'update')
                      return () => ({
                        set: () => ({
                          where: async () => {
                            drop(failure);
                            throw failure;
                          },
                        }),
                      });
                    const value = Reflect.get(t, prop);
                    return typeof value === 'function' ? value.bind(t) : value;
                  },
                }),
              ),
            ),
            dropped,
          ]);
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  h.git.mockImplementation(async (_command, args: string[]) => {
    if (args.includes('rev-parse')) return { stdout: 'true', stderr: '' };
    if (args.includes('remote') && args.includes('add')) throw fail(3, 'exists');
    if (args.includes('--get-all')) {
      if (args.at(-1) === 'remote.origin.url') return { stdout: old, stderr: '' };
      throw fail(1, 'absent');
    }
    if (args.includes('--replace-all') && args.at(-1) === old) throw fail(128, 'restore refused');
    return { stdout: '', stderr: '' };
  });
  const res = await link();
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({
    error: 'Remote update failed and the previous remote could not be restored',
    code: null,
  });
  expect(fake.rows(schema.repositories)[0]!.remoteUrl).toBe(old);
  expect(fake.rows(schema.auditEvents)).toEqual([]);
});
