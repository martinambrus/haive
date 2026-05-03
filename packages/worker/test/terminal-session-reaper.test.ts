import { describe, expect, it } from 'vitest';
import type Docker from 'dockerode';
import type { Redis } from 'ioredis';
import { TERMINAL_SESSION_PREFIX } from '@haive/shared';
import {
  TerminalSessionReaper,
  reapAllSessionsForTask,
} from '../src/sandbox/terminal-session-reaper.js';

interface FakeRecord {
  refcount: string;
  lastSeenAt: string;
  containerName: string;
  startedAt?: string;
  shell?: string;
}

function fakeRedis(seed: Map<string, FakeRecord>): {
  redis: Redis;
  scans: number;
  deletes: string[];
} {
  let scans = 0;
  const deletes: string[] = [];
  const redis = {
    scan: async (cursor: string, _match: 'MATCH', _pattern: string) => {
      scans += 1;
      if (cursor !== '0') return ['0', []] as [string, string[]];
      return ['0', Array.from(seed.keys())] as [string, string[]];
    },
    hgetall: async (key: string) => {
      const rec = seed.get(key);
      if (!rec) return {};
      return { ...rec } as Record<string, string>;
    },
    del: async (key: string) => {
      deletes.push(key);
      seed.delete(key);
      return 1;
    },
  } as unknown as Redis;
  return { redis, scans, deletes };
}

function fakeDocker(): { docker: Docker; removed: string[] } {
  const removed: string[] = [];
  const docker = {
    getContainer: (name: string) => ({
      remove: async (_opts?: unknown) => {
        removed.push(name);
        return undefined;
      },
    }),
  } as unknown as Docker;
  return { docker, removed };
}

describe('TerminalSessionReaper.sweep', () => {
  it('keeps sessions with refcount > 0 alive', async () => {
    const seed = new Map<string, FakeRecord>([
      [
        `${TERMINAL_SESSION_PREFIX}u1:t1:p1`,
        {
          refcount: '2',
          lastSeenAt: String(Date.now() - 5_000_000),
          containerName: 'haive-shell-aa-bb-cc',
        },
      ],
    ]);
    const { redis } = fakeRedis(seed);
    const { docker, removed } = fakeDocker();
    const reaper = new TerminalSessionReaper({ redis, docker, graceMs: 1000 });
    const result = await reaper.sweep();
    expect(result.scanned).toBe(1);
    expect(result.reaped).toBe(0);
    expect(removed).toEqual([]);
  });

  it('keeps idle sessions within the grace window alive', async () => {
    const seed = new Map<string, FakeRecord>([
      [
        `${TERMINAL_SESSION_PREFIX}u1:t1:p1`,
        {
          refcount: '0',
          lastSeenAt: String(Date.now() - 1_000),
          containerName: 'haive-shell-recent',
        },
      ],
    ]);
    const { redis } = fakeRedis(seed);
    const { docker, removed } = fakeDocker();
    const reaper = new TerminalSessionReaper({ redis, docker, graceMs: 60_000 });
    const result = await reaper.sweep();
    expect(result.reaped).toBe(0);
    expect(removed).toEqual([]);
  });

  it('reaps idle sessions past the grace window and removes the container', async () => {
    const containerName = 'haive-shell-stale-1';
    const seed = new Map<string, FakeRecord>([
      [
        `${TERMINAL_SESSION_PREFIX}u1:t1:p1`,
        {
          refcount: '0',
          lastSeenAt: String(Date.now() - 5_000_000),
          containerName,
        },
      ],
    ]);
    const { redis, deletes } = fakeRedis(seed);
    const { docker, removed } = fakeDocker();
    const reaper = new TerminalSessionReaper({ redis, docker, graceMs: 1000 });
    const result = await reaper.sweep();
    expect(result.reaped).toBe(1);
    expect(removed).toEqual([containerName]);
    expect(deletes).toEqual([`${TERMINAL_SESSION_PREFIX}u1:t1:p1`]);
  });

  it('drops registry entries with no containerName', async () => {
    const seed = new Map<string, FakeRecord>([
      [
        `${TERMINAL_SESSION_PREFIX}u1:t1:p1`,
        {
          refcount: '0',
          lastSeenAt: String(Date.now() - 5_000_000),
          containerName: '',
        },
      ],
    ]);
    const { redis } = fakeRedis(seed);
    const { docker, removed } = fakeDocker();
    const reaper = new TerminalSessionReaper({ redis, docker, graceMs: 1000 });
    const result = await reaper.sweep();
    expect(result.reaped).toBe(1);
    expect(removed).toEqual([]);
  });
});

describe('reapAllSessionsForTask', () => {
  it('reaps every session matching :{taskId}: regardless of refcount', async () => {
    const taskId = 'task-9';
    const seed = new Map<string, FakeRecord>([
      [
        `${TERMINAL_SESSION_PREFIX}u1:${taskId}:p1`,
        {
          refcount: '5',
          lastSeenAt: String(Date.now()),
          containerName: 'haive-shell-attached',
        },
      ],
      [
        `${TERMINAL_SESSION_PREFIX}u2:${taskId}:p2`,
        {
          refcount: '0',
          lastSeenAt: String(Date.now()),
          containerName: 'haive-shell-idle',
        },
      ],
    ]);
    const { redis, deletes } = fakeRedis(seed);
    const { docker, removed } = fakeDocker();
    const killed = await reapAllSessionsForTask(redis, docker, taskId);
    expect(killed).toBe(2);
    expect(removed.sort()).toEqual(['haive-shell-attached', 'haive-shell-idle']);
    expect(deletes).toHaveLength(2);
  });

  it('returns zero when no sessions exist for the task', async () => {
    const seed = new Map<string, FakeRecord>();
    const { redis } = fakeRedis(seed);
    const { docker, removed } = fakeDocker();
    const killed = await reapAllSessionsForTask(redis, docker, 'task-none');
    expect(killed).toBe(0);
    expect(removed).toEqual([]);
  });
});
