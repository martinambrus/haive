import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { IDE_IDLE_GRACE_MS, ideSessionKey, repoIdeSessionId } from '@haive/shared';

const stop = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../src/sandbox/ide-runner.js', () => ({
  stopIdeRunner: stop,
  listIdeRunnerSessions: async () => [],
}));
import { IdeSessionReaper } from '../src/sandbox/ide-session-reaper.js';

describe('repository editor idle cleanup', () => {
  it('keeps a connected editor and a recently closed editor, then stops an idle one by its repository session', async () => {
    const sessionId = repoIdeSessionId('00000000-0000-4000-8000-0000000000b1');
    const key = ideSessionKey(sessionId);
    const entry = { refcount: '1', lastSeenAt: String(Date.now() - IDE_IDLE_GRACE_MS - 1000) };
    const del = vi.fn(async () => 1);
    const redis = {
      scan: async () => ['0', [key]],
      hgetall: async () => entry,
      del,
    } as unknown as Redis;
    const reaper = new IdeSessionReaper({ redis });
    expect(await reaper.sweep()).toEqual({ scanned: 1, reaped: 0 });
    entry.refcount = '0';
    entry.lastSeenAt = String(Date.now());
    expect(await reaper.sweep()).toEqual({ scanned: 1, reaped: 0 });
    expect(stop).not.toHaveBeenCalled();
    entry.lastSeenAt = String(Date.now() - IDE_IDLE_GRACE_MS - 1000);
    expect(await reaper.sweep()).toEqual({ scanned: 1, reaped: 1 });
    expect(stop).toHaveBeenCalledWith(sessionId);
    expect(del).toHaveBeenCalledWith(key);
  });
});

it('retains an idle session after an unknown runner probe so the next sweep can retry', async () => {
  const task = 'fixture-task';
  const key = ideSessionKey(task);
  const del = vi.fn(async () => 1);
  const redis = {
    scan: async () => ['0', [key]],
    hgetall: async () => ({ refcount: '0', lastSeenAt: '1' }),
    del,
  } as unknown as Redis;
  const reaper = new IdeSessionReaper({ redis });
  stop.mockRejectedValueOnce(new Error('Cannot determine runner presence. Retry.'));

  expect(await reaper.sweep()).toEqual({ scanned: 1, reaped: 0 });
  expect(del).not.toHaveBeenCalled();

  expect(await reaper.sweep()).toEqual({ scanned: 1, reaped: 1 });
  expect(del).toHaveBeenCalledWith(key);
});
