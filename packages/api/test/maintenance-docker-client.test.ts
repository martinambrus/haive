import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ spawn: vi.fn(), db: undefined as unknown }));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: h.spawn,
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (_c: unknown, next: () => unknown) => next(),
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));

import { runDockerClient } from '../src/routes/maintenance.js';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn((_signal: string) => true);
}

let child: FakeChild;

beforeEach(() => {
  vi.useFakeTimers();
  child = new FakeChild();
  h.spawn.mockReset();
  h.spawn.mockReturnValue(child);
});
afterEach(() => vi.useRealTimers());

describe('runDockerClient deadline timer', () => {
  it('leaves no timer and no kill when the child exits', async () => {
    const run = runDockerClient(['run', '-d', 'img']);
    child.stdout.emit('data', Buffer.from('abc123\n'));
    child.emit('close', 0);
    await expect(run).resolves.toEqual({ ok: true, containerId: 'abc123', stderr: '' });
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(301_000);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('leaves no timer and no kill when the child cannot spawn', async () => {
    const run = runDockerClient(['run', '-d', 'img']);
    child.emit('error', new Error('spawn docker ENOENT'));
    await expect(run).resolves.toMatchObject({ ok: false });
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(301_000);
    expect(child.kill).not.toHaveBeenCalled();
  });
});
