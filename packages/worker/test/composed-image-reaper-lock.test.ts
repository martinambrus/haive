import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { COMPOSED_IMAGE_REPO } from '../src/sandbox/image-composer.js';
import { reapStaleComposedImages } from '../src/sandbox/composed-image-reaper.js';
import { withImageTagLock } from '../src/queues/cli-exec/images.js';
import { defaultDockerRunner } from '../src/sandbox/docker-runner.js';
import { fakeDockerRunner } from './fake-docker-runner.js';
const h = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<object>()),
  spawn: h.spawn,
}));
const ref = `${COMPOSED_IMAGE_REPO}:old`;
const now = Date.UTC(2026, 10, 17);
let used: string;
beforeEach(() => {
  vi.useFakeTimers();
  used = '';
  h.spawn.mockImplementation((_cmd: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    const stdout =
      args[0] === 'images'
        ? ref
        : args[0] === 'ps'
          ? used
          : `sha256:old|2020-01-01T00:00:00Z|${ref}`;
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', 0);
    });
    return child;
  });
});
afterEach(() => vi.useRealTimers());
it('reaping waits for the tag build/removal turn', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const building = withImageTagLock(ref, () => gate);
  const remove = vi.fn(async () => ({ ok: true, stderr: '' }));
  const runner = fakeDockerRunner({
    inspect: async () => ({ exists: true, imageId: 'sha256:old' }),
    remove,
  });
  const reaping = reapStaleComposedImages(1, now, runner);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(remove).not.toHaveBeenCalled();
  } finally {
    release();
  }
  await building;
  expect(await reaping).toBe(1);
  expect(remove).toHaveBeenCalledWith(ref, { force: false });
});
it('rechecks image identity under the tag lock so an earlier stale snapshot cannot remove a replacement', async () => {
  const remove = vi.fn(async () => ({ ok: true, stderr: '' }));
  const runner = fakeDockerRunner({
    inspect: async () => ({ exists: true, imageId: 'sha256:replacement' }),
    remove,
  });
  expect(await reapStaleComposedImages(1, now, runner)).toBe(0);
  expect(remove).not.toHaveBeenCalled();
});
it('lists stopped containers as well as running ones and never force removes a container-used image', async () => {
  used = ref;
  const runner = fakeDockerRunner();
  expect(await reapStaleComposedImages(1, now, runner)).toBe(0);
  expect(h.spawn.mock.calls.find(([, args]) => args[0] === 'ps')?.[1]).toContain('--all');
});
it('removal refusal keeps the image and reports zero removed', async () => {
  const remove = vi.fn(async () => ({ ok: false, stderr: 'container in use' }));
  const runner = fakeDockerRunner({
    inspect: async () => ({ exists: true, imageId: 'sha256:old' }),
    remove,
  });
  expect(await reapStaleComposedImages(1, now, runner)).toBe(0);
  expect(remove).toHaveBeenCalledWith(ref, { force: false });
});

it('Docker removal omits force only when the reaper requests container protection', async () => {
  await defaultDockerRunner.remove(ref, { force: false });
  expect(h.spawn.mock.calls[0]?.[1]).toEqual(['image', 'rm', ref]);
  await defaultDockerRunner.remove(ref);
  expect(h.spawn.mock.calls[1]?.[1]).toEqual(['image', 'rm', '--force', ref]);
});
