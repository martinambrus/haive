import { PassThrough } from 'node:stream';
import type Docker from 'dockerode';
import type { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GIT_CRED_TOKEN_TTL_SECONDS,
  terminalSessionKey,
  verifyRepoGitCredToken,
  type TerminalOpenResult,
} from '@haive/shared';

const h = vi.hoisted(() => {
  const log = {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => log,
  };
  return { log, ensure: vi.fn() };
});

vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  logger: h.log,
}));
vi.mock('../src/queues/cli-exec-queue.js', () => ({
  resolveSandboxImageTag: async () => 'haive-sandbox:test',
  resolveRepoMount: vi.fn(async () => ({ source: 'repo', target: '/haive/workdir' })),
  resolveTaskRepoMount: vi.fn(async () => ({ source: 'repo', target: '/haive/workdir' })),
  resolveTaskSandboxWorkdir: vi.fn(async () => '/haive/workdir'),
}));
vi.mock('../src/queues/cli-exec/gitfile-mask.js', () => ({
  repoGitDataBoundary: vi.fn(async () => ({ mounts: [] })),
}));
vi.mock('../src/terminal/terminal-container.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/terminal/terminal-container.js')>()),
  ensureShellContainer: h.ensure,
}));

import { TerminalSessionReaper } from '../src/sandbox/terminal-session-reaper.js';
import { GIT_CRED_TOKEN_PATH } from '../src/terminal/terminal-container.js';
import { TerminalSessionManager } from '../src/terminal/terminal-session-manager.js';

const SECRET = 'git-credential-reaper-test-secret';
const HOUR = 3_600_000;
const HALF_TTL = (DEFAULT_GIT_CRED_TOKEN_TTL_SECONDS * 1000) / 2;
const USER = 'user-1';
const REPO = 'repo-1';
const TASK = 'task-1';
const PROVIDER = 'prov-1';
const CONTAINER = 'haive-shell-repo-aaaaaaaa-bbbbbbbb-cccccccc';
const KEY = terminalSessionKey(USER, 'repo', REPO, PROVIDER);

type Hash = Record<string, string>;

/** Redis hashes in a map: the commands the manager and the reaper use, nothing else. */
function memoryRedis(seed: Record<string, Hash> = {}): { redis: Redis; store: Map<string, Hash> } {
  const store = new Map<string, Hash>(Object.entries(seed).map(([k, v]) => [k, { ...v }]));
  const redis = {
    scan: async (cursor: string) =>
      (cursor === '0' ? ['0', [...store.keys()]] : ['0', []]) as [string, string[]],
    hgetall: async (key: string) => ({ ...store.get(key) }),
    hset: async (key: string, a: string | Hash, b?: string) => {
      const hash = store.get(key) ?? {};
      if (typeof a === 'string') hash[a] = b as string;
      else Object.assign(hash, a);
      store.set(key, hash);
      return 1;
    },
    hsetnx: async (key: string, field: string, value: string) => {
      const hash = store.get(key) ?? {};
      store.set(key, hash);
      if (field in hash) return 0;
      hash[field] = value;
      return 1;
    },
    del: async (key: string) => {
      store.delete(key);
      return 1;
    },
    publish: async () => 0,
    set: async () => 'OK',
  } as unknown as Redis;
  return { redis, store };
}

interface ExecRecord {
  container: string;
  cmd: string[];
  stdin: string;
}

/** `failWritesIn` makes every file write in that container exit non-zero; `hangExecsIn` never answers. */
function fakeDocker() {
  const execs: ExecRecord[] = [];
  const removed: string[] = [];
  const state = { failWritesIn: null as string | null, hangExecsIn: null as string | null };
  const docker = {
    getContainer: (container: string) => ({
      remove: async () => {
        removed.push(container);
      },
      exec: async (o: { Cmd: string[] }) => {
        const record: ExecRecord = { container, cmd: o.Cmd, stdin: '' };
        execs.push(record);
        if (state.hangExecsIn === container) await new Promise(() => {});
        return {
          start: async (s: { stdin?: boolean }) => {
            const stream = new PassThrough();
            stream.on('data', (d: Buffer) => {
              record.stdin += d.toString('utf8');
            });
            if (!s.stdin) setImmediate(() => stream.end());
            return stream;
          },
          inspect: async () => ({
            ExitCode: state.failWritesIn === container && script(record).includes('cat >') ? 1 : 0,
          }),
        };
      },
    }),
  } as unknown as Docker;
  return { docker, execs, removed, state };
}

const script = (e: ExecRecord): string => e.cmd.join(' ');
const tokenWrites = (execs: ExecRecord[]): ExecRecord[] =>
  execs.filter((e) => script(e).includes('cat >') && script(e).includes(GIT_CRED_TOKEN_PATH));
const nthTokenWrite = (execs: ExecRecord[], n: number): ExecRecord => {
  const writes = tokenWrites(execs);
  expect(writes.length).toBeGreaterThan(n);
  return writes[n]!;
};

/** A repo shell's registry entry as the worker and the api leave it, minted `mintedAgo` ms ago. */
function repoSession(over: Hash = {}, mintedAgo = 7 * HOUR): Hash {
  return {
    containerName: CONTAINER,
    shell: 'bash',
    scope: 'repo',
    scopeId: REPO,
    userId: USER,
    refcount: '1',
    lastSeenAt: String(Date.now()),
    startedAt: String(Date.now() - 100 * HOUR),
    gitCredMintedAt: String(Date.now() - mintedAgo),
    ...over,
  };
}

function logged(): string {
  const calls = [h.log.warn, h.log.info, h.log.error, h.log.debug].flatMap((fn) => fn.mock.calls);
  return JSON.stringify(calls, (_key, value: unknown) =>
    value instanceof Error
      ? { name: value.name, message: value.message, stack: value.stack }
      : value,
  );
}

const savedSecret = process.env.CONFIG_ENCRYPTION_KEY;

beforeEach(() => {
  process.env.CONFIG_ENCRYPTION_KEY = SECRET;
  for (const fn of [h.log.warn, h.log.info, h.log.error, h.log.debug]) fn.mockClear();
  h.ensure.mockReset();
});

afterEach(() => {
  if (savedSecret === undefined) delete process.env.CONFIG_ENCRYPTION_KEY;
  else process.env.CONFIG_ENCRYPTION_KEY = savedSecret;
});

describe('TerminalSessionReaper git credential refresh', () => {
  it('refreshes a live repo shell minted 7 h ago, however long it has been running', async () => {
    const before = Date.now();
    const seed = repoSession();
    const { redis, store } = memoryRedis({ [KEY]: seed });
    const { docker, execs, removed } = fakeDocker();
    const result = await new TerminalSessionReaper({ redis, docker }).sweep();

    expect(result).toEqual({ scanned: 1, reaped: 0 });
    expect(removed).toEqual([]);
    expect(tokenWrites(execs).map((w) => w.container)).toEqual([CONTAINER]);
    expect(verifyRepoGitCredToken(nthTokenWrite(execs, 0).stdin, SECRET)).toEqual({
      repositoryId: REPO,
      userId: USER,
    });
    expect(Number(store.get(KEY)!.gitCredMintedAt)).toBeGreaterThanOrEqual(before);
    expect(store.get(KEY)!.startedAt).toBe(seed.startedAt);
  });

  it('leaves a token minted 1 h ago alone', async () => {
    const seed = repoSession({}, 1 * HOUR);
    const { redis, store } = memoryRedis({ [KEY]: seed });
    const { docker, execs } = fakeDocker();
    await new TerminalSessionReaper({ redis, docker }).sweep();
    expect(execs).toEqual([]);
    expect(store.get(KEY)).toEqual(seed);
  });

  it('refreshes once a token is past half its TTL, and not before', async () => {
    const early = memoryRedis({ [KEY]: repoSession({}, HALF_TTL - 60_000) });
    const earlyDocker = fakeDocker();
    await new TerminalSessionReaper({ redis: early.redis, docker: earlyDocker.docker }).sweep();
    expect(tokenWrites(earlyDocker.execs)).toHaveLength(0);

    const late = memoryRedis({ [KEY]: repoSession({}, HALF_TTL + 60_000) });
    const lateDocker = fakeDocker();
    await new TerminalSessionReaper({ redis: late.redis, docker: lateDocker.docker }).sweep();
    expect(tokenWrites(lateDocker.execs)).toHaveLength(1);
  });

  it('does not refresh a task shell, however old its record', async () => {
    const taskKey = terminalSessionKey(USER, 'task', TASK, PROVIDER);
    const seed = repoSession({ scope: 'task', scopeId: TASK });
    const { redis, store } = memoryRedis({ [taskKey]: seed });
    const { docker, execs } = fakeDocker();
    await new TerminalSessionReaper({ redis, docker }).sweep();
    expect(execs).toEqual([]);
    expect(store.get(taskKey)).toEqual(seed);
  });

  it('does not refresh a session recorded before the mint time was kept', async () => {
    const { gitCredMintedAt: _omitted, ...older } = repoSession();
    const { redis, store } = memoryRedis({ [KEY]: older });
    const { docker, execs } = fakeDocker();
    await new TerminalSessionReaper({ redis, docker }).sweep();
    expect(execs).toEqual([]);
    expect(store.get(KEY)).toEqual(older);
  });

  it('does not refresh a session that is idle past the grace window, which it reaps', async () => {
    const idle = repoSession({ refcount: '0', lastSeenAt: String(Date.now() - 5 * 60_000) });
    const { redis, store } = memoryRedis({ [KEY]: idle });
    const { docker, execs, removed } = fakeDocker();
    const result = await new TerminalSessionReaper({ redis, docker }).sweep();
    expect(result).toEqual({ scanned: 1, reaped: 1 });
    expect(removed).toEqual([CONTAINER]);
    expect(store.has(KEY)).toBe(false);
    expect(tokenWrites(execs)).toEqual([]);
  });

  it('refreshes nothing without the key the token is signed with', async () => {
    delete process.env.CONFIG_ENCRYPTION_KEY;
    const seed = repoSession();
    const { redis, store } = memoryRedis({ [KEY]: seed });
    const { docker, execs } = fakeDocker();
    await new TerminalSessionReaper({ redis, docker }).sweep();
    expect(execs).toEqual([]);
    expect(store.get(KEY)).toEqual(seed);
  });

  it('keeps the mint time on a failed write, logs it without the token, and retries', async () => {
    const seed = repoSession();
    const { redis, store } = memoryRedis({ [KEY]: seed });
    const { docker, execs, state } = fakeDocker();
    const reaper = new TerminalSessionReaper({ redis, docker });

    state.failWritesIn = CONTAINER;
    const failed = await reaper.sweep();
    expect(failed).toEqual({ scanned: 1, reaped: 0 });
    const attempt = nthTokenWrite(execs, 0).stdin;
    expect(attempt).not.toBe('');
    expect(store.get(KEY)!.gitCredMintedAt).toBe(seed.gitCredMintedAt);
    expect(h.log.warn.mock.calls.length).toBeGreaterThan(0);
    expect(logged()).not.toContain(attempt);
    expect(logged()).not.toContain(SECRET);

    state.failWritesIn = null;
    await reaper.sweep();
    expect(tokenWrites(execs)).toHaveLength(2);
    expect(Number(store.get(KEY)!.gitCredMintedAt)).toBeGreaterThan(Number(seed.gitCredMintedAt));
    expect(logged()).not.toContain(nthTokenWrite(execs, 1).stdin);
    expect(logged()).not.toContain(SECRET);
  });

  it('gives up on a refresh whose docker exec hangs, so the sweep ends and the next one retries', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const seed = repoSession();
      const { redis, store } = memoryRedis({ [KEY]: seed });
      const { docker, execs, state } = fakeDocker();
      const reaper = new TerminalSessionReaper({ redis, docker });

      state.hangExecsIn = CONTAINER;
      const hung = reaper.sweep();
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(hung).resolves.toEqual({ scanned: 1, reaped: 0 });
      expect(store.get(KEY)!.gitCredMintedAt).toBe(seed.gitCredMintedAt);
      expect(h.log.warn.mock.calls.length).toBeGreaterThan(0);

      state.hangExecsIn = null;
      const before = execs.length;
      await reaper.sweep();
      expect(execs.length).toBeGreaterThan(before);
      expect(Number(store.get(KEY)!.gitCredMintedAt)).toBeGreaterThan(Number(seed.gitCredMintedAt));
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes the other sessions when one refresh fails', async () => {
    const otherContainer = 'haive-shell-repo-dddddddd-eeeeeeee-ffffffff';
    const otherKey = terminalSessionKey(USER, 'repo', 'repo-2', PROVIDER);
    const { redis, store } = memoryRedis({
      [KEY]: repoSession(),
      [otherKey]: repoSession({ containerName: otherContainer, scopeId: 'repo-2' }),
    });
    const { docker, execs, state } = fakeDocker();
    state.failWritesIn = CONTAINER;
    const result = await new TerminalSessionReaper({ redis, docker }).sweep();
    expect(result).toEqual({ scanned: 2, reaped: 0 });
    expect(tokenWrites(execs).map((w) => w.container)).toEqual([CONTAINER, otherContainer]);
    expect(Number(store.get(otherKey)!.gitCredMintedAt)).toBeGreaterThan(Date.now() - 60_000);
  });
});

describe('the session registry the reaper reads', () => {
  function manager(redis: Redis) {
    const docker = {
      getContainer: () => ({
        exec: async (o: { Cmd: string[] }) => {
          const attach = o.Cmd[1] === 'new-session';
          return {
            start: async () => {
              const stream = new PassThrough();
              if (!attach) setImmediate(() => stream.end());
              return stream;
            },
            inspect: async () => ({ ExitCode: attach ? null : 0 }),
            resize: async () => undefined,
          };
        },
      }),
    };
    const db = {
      query: {
        tasks: {
          findFirst: async () => ({
            id: TASK,
            userId: USER,
            status: 'running',
            type: 'onboarding',
            repositoryId: REPO,
          }),
        },
        taskSteps: { findFirst: async () => ({ status: 'done' }) },
        cliProviders: { findFirst: async () => undefined },
      },
    };
    const subscriber = {
      subscribe: vi.fn(async () => undefined),
      unsubscribe: vi.fn(async () => undefined),
      on: vi.fn(),
    };
    const mgr = new TerminalSessionManager({
      db: db as never,
      redis,
      subscriberRedis: subscriber as never,
      docker: docker as never,
      buildMcpServers: async () => [],
    });
    const priv = mgr as unknown as { openSession: (req: unknown) => Promise<TerminalOpenResult> };
    return {
      openRepo: () =>
        priv.openSession({
          op: 'open',
          correlationId: 'c1',
          userId: USER,
          cliProviderId: PROVIDER,
          scope: 'repo',
          repositoryId: REPO,
        }),
      openTask: () =>
        priv.openSession({
          op: 'open',
          correlationId: 'c2',
          userId: USER,
          cliProviderId: PROVIDER,
          scope: 'task',
          taskId: TASK,
        }),
    };
  }

  it('records what a repo shell needs to have its token renewed', async () => {
    const { redis, store } = memoryRedis();
    h.ensure.mockResolvedValue({ containerName: CONTAINER, shell: 'bash', gitCredMintedAt: 1234 });
    expect((await manager(redis).openRepo()).ok).toBe(true);
    expect(store.get(KEY)).toMatchObject({
      containerName: CONTAINER,
      shell: 'bash',
      scope: 'repo',
      scopeId: REPO,
      userId: USER,
      gitCredMintedAt: '1234',
    });
  });

  it('moves the recorded mint time on when the shell is opened again', async () => {
    const { redis, store } = memoryRedis();
    const mgr = manager(redis);
    h.ensure.mockResolvedValue({ containerName: CONTAINER, shell: 'bash', gitCredMintedAt: 1234 });
    await mgr.openRepo();
    h.ensure.mockResolvedValue({ containerName: CONTAINER, shell: 'bash', gitCredMintedAt: 5678 });
    await mgr.openRepo();
    expect(store.get(KEY)!.gitCredMintedAt).toBe('5678');
  });

  it('keeps the earlier mint time when an open could not write a token', async () => {
    const { redis, store } = memoryRedis();
    const mgr = manager(redis);
    h.ensure.mockResolvedValue({ containerName: CONTAINER, shell: 'bash', gitCredMintedAt: 1234 });
    await mgr.openRepo();
    h.ensure.mockResolvedValue({ containerName: CONTAINER, shell: 'bash' });
    await mgr.openRepo();
    expect(store.get(KEY)!.gitCredMintedAt).toBe('1234');
  });

  it('records no mint time for a shell that was given no token', async () => {
    const { redis, store } = memoryRedis();
    h.ensure.mockResolvedValue({ containerName: CONTAINER, shell: 'bash' });
    await manager(redis).openRepo();
    expect(Object.keys(store.get(KEY)!).sort()).toEqual([
      'containerName',
      'lastSeenAt',
      'refcount',
      'shell',
      'startedAt',
    ]);
  });

  it('records none of it for a task shell', async () => {
    const { redis, store } = memoryRedis();
    h.ensure.mockResolvedValue({ containerName: 'haive-shell-task', shell: 'bash' });
    await manager(redis).openTask();
    const taskKey = terminalSessionKey(USER, 'task', TASK, PROVIDER);
    expect(Object.keys(store.get(taskKey)!).sort()).toEqual([
      'containerName',
      'lastSeenAt',
      'refcount',
      'shell',
      'startedAt',
    ]);
  });

  it('is what the reaper refreshes from, once the recorded mint is old enough', async () => {
    const { redis, store } = memoryRedis();
    h.ensure.mockResolvedValue({
      containerName: CONTAINER,
      shell: 'bash',
      gitCredMintedAt: Date.now() - 7 * HOUR,
    });
    await manager(redis).openRepo();
    store.get(KEY)!.refcount = '1';

    const { docker, execs } = fakeDocker();
    await new TerminalSessionReaper({ redis, docker }).sweep();

    expect(tokenWrites(execs).map((w) => w.container)).toEqual([CONTAINER]);
    expect(verifyRepoGitCredToken(nthTokenWrite(execs, 0).stdin, SECRET)).toEqual({
      repositoryId: REPO,
      userId: USER,
    });
    expect(Number(store.get(KEY)!.gitCredMintedAt)).toBeGreaterThan(Date.now() - 60_000);
  });
});
