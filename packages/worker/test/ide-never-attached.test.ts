import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { IDE_IDLE_GRACE_MS, ideSessionKey } from '@haive/shared';

const h = vi.hoisted(() => {
  const registry = new Map<string, Record<string, string>>();
  const redis = {
    hset: async (key: string, field: string, value: string) => {
      registry.set(key, { ...registry.get(key), [field]: value });
      return 1;
    },
    hgetall: async (key: string) => ({ ...registry.get(key) }),
    del: async (key: string) => (registry.delete(key) ? 1 : 0),
    scan: async (_cursor: string, _match: string, pattern: string) =>
      ['0', [...registry.keys()].filter((key) => key.startsWith(pattern.slice(0, -1)))] as [
        string,
        string[],
      ],
  };
  return {
    enabled: true,
    db: undefined as unknown,
    registry,
    redis,
    runner: vi.fn(),
    settings: vi.fn(),
    stop: vi.fn(),
  };
});
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: { getBoolean: async () => h.enabled },
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/redis.js', () => ({ getRedis: () => h.redis, getBullRedis: vi.fn() }));
vi.mock('../src/sandbox/ide-runner.js', () => ({
  ensureIdeRunnerStarted: h.runner,
  ensureRepoIdeRunnerStarted: vi.fn(),
  listIdeRunnerSessions: async () => [],
  stopIdeRunner: h.stop,
}));
vi.mock('../src/sandbox/ide-settings.js', () => ({ resolveIdeSettingsJson: h.settings }));
import { ensureIdeForTask } from '../src/queues/ide-ensure-queue.js';
import { IdeSessionReaper } from '../src/sandbox/ide-session-reaper.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-0000000000c1';
const KEY = ideSessionKey(TASK);
const START = Date.parse('2026-10-30T12:00:00Z');

function givenTask(status: string): void {
  const fake = createFakeDb({ tasks: schema.tasks });
  fake.insert(schema.tasks, { id: TASK, userId: USER, type: 'workflow', status });
  h.db = fake.db;
}

beforeEach(() => {
  h.enabled = true;
  h.registry.clear();
  h.runner.mockReset().mockResolvedValue({ container: 'editor' });
  h.settings.mockReset().mockResolvedValue('{}');
  h.stop.mockReset().mockResolvedValue(true);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a task editor that no browser ever connects to', () => {
  it('is reaped by the idle reaper once the grace has passed', async () => {
    givenTask('running');
    expect(await ensureIdeForTask(TASK, USER)).toEqual({ ok: true });
    const reaper = new IdeSessionReaper({ redis: h.redis as unknown as Redis });

    // No editor WebSocket ever opens, so nothing but the ensure has written the registry.
    vi.setSystemTime(START + IDE_IDLE_GRACE_MS - 1000);
    expect(await reaper.sweep()).toEqual({ scanned: 1, reaped: 0 });
    expect(h.stop).not.toHaveBeenCalled();

    vi.setSystemTime(START + IDE_IDLE_GRACE_MS + 1000);
    expect(await reaper.sweep()).toEqual({ scanned: 1, reaped: 1 });
    expect(h.stop).toHaveBeenCalledWith(TASK);
    expect(h.registry.has(KEY)).toBe(false);
  });
});

describe('a task editor ensure that starts no editor', () => {
  it('registers nothing when the editor is disabled', async () => {
    h.enabled = false;
    givenTask('running');

    expect(await ensureIdeForTask(TASK, USER)).toEqual({ ok: false, reason: 'disabled' });

    expect(h.runner).not.toHaveBeenCalled();
    expect(h.registry.size).toBe(0);
  });

  it.each(['completed', 'cancelled'])('registers nothing when the task is %s', async (status) => {
    givenTask(status);

    expect(await ensureIdeForTask(TASK, USER)).toEqual({ ok: false, reason: 'task-ended' });

    expect(h.runner).not.toHaveBeenCalled();
    expect(h.registry.size).toBe(0);
  });

  it('registers nothing when the task has no editable repository', async () => {
    givenTask('running');
    h.runner.mockResolvedValue(null);

    expect(await ensureIdeForTask(TASK, USER)).toEqual({ ok: false, reason: 'no-editable-repo' });

    expect(h.registry.size).toBe(0);
  });
});
