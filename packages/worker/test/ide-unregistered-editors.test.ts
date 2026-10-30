import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import {
  IDE_IDLE_GRACE_MS,
  IDE_RUNNER_LABEL,
  ideRunnerName,
  ideSessionKey,
  repoIdeSessionId,
} from '@haive/shared';

interface FakeContainer {
  running: boolean;
  labels: Record<string, string>;
}

// A stateful fake docker and a Map-backed fake Redis. `calls` holds only stops and removals. `ps`
// honours `--filter label=K[=V]` and fills the placeholders of the code's own `--format` (docker
// reads `\t` and `\n` in it as characters), so the columns parsed are those its template produced.
const h = vi.hoisted(() => {
  const state = {
    containers: new Map<string, FakeContainer>(),
    registry: new Map<string, Record<string, string>>(),
    calls: [] as string[],
    psFails: false,
    hsetnxFails: false,
  };
  const out = (stdout: string) => ({ stdout, stderr: '' });
  const docker = async (_command: string, args: string[]) => {
    const [verb, ...rest] = args;
    const last = rest[rest.length - 1]!;
    if (verb === 'ps') {
      if (state.psFails) throw new Error('docker ps timed out');
      const valuesOf = (flag: string) => rest.filter((_arg, index) => rest[index - 1] === flag);
      for (const flag of rest.filter((arg) => arg.startsWith('-'))) {
        if (flag !== '--filter' && flag !== '--format') {
          throw new Error(`fake docker: unhandled ps flag ${flag}`);
        }
      }
      const wanted = valuesOf('--filter').map((filter) => {
        const [, key, value] = /^label=([^=]+)(?:=(.*))?$/.exec(filter) ?? [];
        if (key === undefined) throw new Error(`fake docker: unhandled ps filter ${filter}`);
        return { key, value };
      });
      const format = (valuesOf('--format')[0] ?? '{{.ID}}')
        .replaceAll('\\t', '\t')
        .replaceAll('\\n', '\n');
      const rows = [...state.containers]
        .filter(
          ([, container]) =>
            container.running &&
            wanted.every(
              ({ key, value }) =>
                key in container.labels && (value === undefined || container.labels[key] === value),
            ),
        )
        .map(([name, container]) =>
          format
            .replaceAll('{{.Names}}', name)
            .replaceAll('{{.ID}}', `id-${name}`)
            .replace(
              /\{\{\.Label "([^"]+)"\}\}/g,
              (_match, key: string) => container.labels[key] ?? '',
            ),
        );
      if (rows.some((row) => row.includes('{{'))) {
        throw new Error(`fake docker: unhandled ps placeholder in ${format}`);
      }
      return out(rows.map((row) => `${row}\n`).join(''));
    }
    if (verb === 'inspect') {
      if (!state.containers.has(last)) throw new Error(`Error: No such object: ${last}`);
      return out('[{}]');
    }
    if (verb === 'stop') {
      const container = state.containers.get(last);
      if (container) {
        container.running = false;
        state.calls.push(`stop ${last}`);
      }
      return out('');
    }
    if (verb === 'rm') {
      for (const name of rest.filter((arg) => !arg.startsWith('-'))) {
        if (state.containers.delete(name)) state.calls.push(`rm ${name}`);
      }
      return out('');
    }
    if (verb === 'run' && rest[0] === '-d') {
      const labels: Record<string, string> = {};
      let name = '';
      rest.forEach((arg, index) => {
        if (rest[index - 1] === '--name') name = arg;
        if (rest[index - 1] === '--label') {
          labels[arg.slice(0, arg.indexOf('='))] = arg.slice(arg.indexOf('=') + 1);
        }
      });
      state.containers.set(name, { running: true, labels });
      return out('container-id\n');
    }
    throw new Error(`fake docker: unhandled ${verb}`);
  };
  const redis = {
    scan: async (_cursor: string, _match: string, pattern: string) =>
      ['0', [...state.registry.keys()].filter((key) => key.startsWith(pattern.slice(0, -1)))] as [
        string,
        string[],
      ],
    hgetall: async (key: string) => ({ ...state.registry.get(key) }),
    hset: async (key: string, field: string, value: string) => {
      state.registry.set(key, { ...state.registry.get(key), [field]: value });
      return 1;
    },
    hsetnx: async (key: string, field: string, value: string) => {
      if (state.hsetnxFails) throw new Error('redis is down');
      const entry = state.registry.get(key);
      if (entry && field in entry) return 0;
      state.registry.set(key, { ...entry, [field]: value });
      return 1;
    },
    hincrby: async (key: string, field: string, by: number) => {
      const next = Number(state.registry.get(key)?.[field] ?? 0) + by;
      state.registry.set(key, { ...state.registry.get(key), [field]: String(next) });
      return next;
    },
    del: async (key: string) => (state.registry.delete(key) ? 1 : 0),
  };
  return { state, docker, redis };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: h.docker }) };
});
vi.mock('../src/redis.js', () => ({ getRedis: () => h.redis, getBullRedis: vi.fn() }));
vi.mock('../src/sandbox/sandbox-core-image.js', () => ({ ensureSandboxCoreImage: async () => {} }));
vi.mock('../src/queues/cli-exec/gitfile-mask.js', () => ({
  repoGitDataBoundary: async () => ({ mounts: [] }),
}));
// Nothing here may reach a real docker through the runner.
vi.mock('../src/sandbox/docker-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/docker-runner.js')>()),
  defaultDockerRunner: {},
}));

import { startIdeRunner } from '../src/sandbox/ide-runner.js';
import { IdeSessionReaper } from '../src/sandbox/ide-session-reaper.js';

const REPO = '00000000-0000-4000-8000-0000000000b1';
const TASK = '00000000-0000-4000-8000-0000000000c1';
const OTHER_TASK = '00000001-0000-4000-8000-0000000000c2';
const REPO_SESSION = repoIdeSessionId(REPO);
const START = Date.parse('2026-10-30T12:00:00Z');
const MINUTE = 60_000;
const GRACE = IDE_IDLE_GRACE_MS;

// Launched by the code that stamps the labels, so the sweep reads what it really writes.
const mounts = {
  workspaceSubpath: 'user/repository',
  gitDataMounts: [],
  extVolume: 'ext',
  udataVolume: 'udata',
};
const launchTaskEditor = (taskId: string) => startIdeRunner({ taskId, ...mounts });
const launchRepoEditor = (repositoryId: string) =>
  startIdeRunner({ taskId: repoIdeSessionId(repositoryId), repositoryId, ...mounts });

const reaper = new IdeSessionReaper({ redis: h.redis as unknown as Redis });
/** A sweep at START + `ms`. */
const sweepAt = (ms: number) => {
  vi.setSystemTime(START + ms);
  return reaper.sweep();
};
const registryOf = (session: string) => h.state.registry.get(ideSessionKey(session));
const idleEntry = () => ({ refcount: '0', lastSeenAt: String(START - GRACE - 1000) });

beforeEach(() => {
  h.state.containers.clear();
  h.state.registry.clear();
  h.state.calls.length = 0;
  h.state.psFails = false;
  h.state.hsetnxFails = false;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('a running editor with no session entry', () => {
  it.each([
    ['task', TASK, () => launchTaskEditor(TASK)],
    ['repository', REPO_SESSION, () => launchRepoEditor(REPO)],
  ])('is registered, not stopped: %s editor', async (_kind, session, launch) => {
    await launch();

    expect(await reaper.sweep()).toEqual({ scanned: 0, reaped: 0 });

    expect(registryOf(session)).toEqual({ lastSeenAt: String(START) });
    expect(h.state.calls).toEqual([]);
    expect(h.state.containers.has(ideRunnerName(session))).toBe(true);
  });
});

describe('a running editor that has a session entry', () => {
  it('is left as it is: attached, or closed a minute ago', async () => {
    await launchTaskEditor(TASK);
    await launchRepoEditor(REPO);
    const attached = { refcount: '1', lastSeenAt: String(START - GRACE - 1000) };
    const closed = { refcount: '0', lastSeenAt: String(START - MINUTE) };
    h.state.registry.set(ideSessionKey(TASK), { ...attached });
    h.state.registry.set(ideSessionKey(REPO_SESSION), { ...closed });

    expect(await reaper.sweep()).toEqual({ scanned: 2, reaped: 0 });

    expect(registryOf(TASK)).toEqual(attached);
    expect(registryOf(REPO_SESSION)).toEqual(closed);
    expect(h.state.calls).toEqual([]);
    expect(h.state.containers.size).toBe(2);
  });

  it('is stopped and removed by the idle rule when no socket is attached, and not registered again', async () => {
    await launchTaskEditor(TASK);
    h.state.registry.set(ideSessionKey(TASK), idleEntry());
    const name = ideRunnerName(TASK);

    expect(await reaper.sweep()).toEqual({ scanned: 1, reaped: 1 });

    expect(h.state.calls).toEqual([`stop ${name}`, `rm ${name}`]);
    expect(h.state.containers.has(name)).toBe(false);
    expect(h.state.registry.has(ideSessionKey(TASK))).toBe(false);
  });
});

describe('an editor session the sweep registered', () => {
  const name = ideRunnerName(TASK);
  /** A socket opening (+1) or closing (-1), recorded the way the api records it. */
  const socket = async (ms: number, by: 1 | -1) => {
    vi.setSystemTime(START + ms);
    await h.redis.hincrby(ideSessionKey(TASK), 'refcount', by);
    await h.redis.hset(ideSessionKey(TASK), 'lastSeenAt', String(Date.now()));
  };

  it('is never stopped while a socket is attached, nor before a grace after the last one left', async () => {
    await launchTaskEditor(TASK);

    expect(await sweepAt(0)).toEqual({ scanned: 0, reaped: 0 });
    expect(registryOf(TASK)).toEqual({ lastSeenAt: String(START) });

    // A socket attaches the way the api records it, ten minutes in. The registration alone would
    // have run out before the next sweep.
    await socket(10 * MINUTE, 1);
    expect(await sweepAt(GRACE + 5 * MINUTE)).toEqual({ scanned: 1, reaped: 0 });
    // A whole grace after the attach, only the refcount keeps it.
    const detached = GRACE + 10 * MINUTE;
    expect(await sweepAt(detached)).toEqual({ scanned: 1, reaped: 0 });

    await socket(detached, -1);
    expect(await sweepAt(detached + GRACE - 1000)).toEqual({ scanned: 1, reaped: 0 });
    expect(h.state.calls).toEqual([]);

    expect(await sweepAt(detached + GRACE + 1000)).toEqual({ scanned: 1, reaped: 1 });
    expect(h.state.calls).toEqual([`stop ${name}`, `rm ${name}`]);
    expect(h.state.containers.has(name)).toBe(false);
    expect(h.state.registry.has(ideSessionKey(TASK))).toBe(false);
  });

  it('is stopped one grace after it was registered when no socket ever attaches', async () => {
    await launchTaskEditor(TASK);

    expect(await sweepAt(0)).toEqual({ scanned: 0, reaped: 0 });
    expect(await sweepAt(GRACE - 1000)).toEqual({ scanned: 1, reaped: 0 });
    expect(h.state.calls).toEqual([]);

    expect(await sweepAt(GRACE + 1000)).toEqual({ scanned: 1, reaped: 1 });
    expect(h.state.calls).toEqual([`stop ${name}`, `rm ${name}`]);
    expect(h.state.containers.has(name)).toBe(false);
    expect(h.state.registry.has(ideSessionKey(TASK))).toBe(false);
  });
});

// IDE containers carry no install label: whose editor one is can only be read off its name, and the
// reaper later stops whatever it registered.
describe('a running editor container that is not this install’s', () => {
  const name = ideRunnerName(TASK);
  const arrangements: [string, () => Promise<void> | void][] = [
    [
      'launched under another install id',
      async () => {
        vi.stubEnv('HAIVE_INSTALL_ID', 'another');
        await launchTaskEditor(TASK);
        vi.unstubAllEnvs();
      },
    ],
    [
      'whose task label names another task',
      () => {
        h.state.containers.set(name, {
          running: true,
          labels: { [IDE_RUNNER_LABEL]: '1', 'haive.task.id': OTHER_TASK },
        });
      },
    ],
    [
      'with neither a task nor a repository label',
      () => {
        h.state.containers.set(name, { running: true, labels: { [IDE_RUNNER_LABEL]: '1' } });
      },
    ],
  ];

  it.each(arrangements)('is neither registered nor stopped: %s', async (_case, arrange) => {
    await arrange();
    expect(h.state.containers.size).toBe(1);

    expect(await reaper.sweep()).toEqual({ scanned: 0, reaped: 0 });

    expect(h.state.registry.size).toBe(0);
    expect(h.state.calls).toEqual([]);
    expect(h.state.containers.size).toBe(1);
  });
});

describe('a sweep that cannot register the running editors', () => {
  const arrange = async () => {
    await launchTaskEditor(TASK);
    h.state.registry.set(ideSessionKey(TASK), idleEntry());
    await launchRepoEditor(REPO);
  };

  it.each([
    [
      'the container listing fails',
      () => {
        h.state.psFails = true;
      },
    ],
    [
      'a registration write fails',
      () => {
        h.state.hsetnxFails = true;
      },
    ],
  ])('still reaps what the scan found and registers nothing: %s', async (_failure, fail) => {
    await arrange();
    fail();

    expect(await reaper.sweep()).toEqual({ scanned: 1, reaped: 1 });

    expect(h.state.registry.size).toBe(0);
    expect(h.state.containers.has(ideRunnerName(TASK))).toBe(false);
    expect(h.state.containers.has(ideRunnerName(REPO_SESSION))).toBe(true);
  });
});
