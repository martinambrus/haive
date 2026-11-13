import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: h.spawn,
}));
import { defaultDockerRunner } from '../src/sandbox/docker-runner.js';

const ID = 'sha256:' + 'a'.repeat(64);
const TAG = 'tib-sandbox:test';

function image(config: Record<string, unknown>, exists = true) {
  h.spawn.mockImplementation((_bin: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    queueMicrotask(() => {
      const format = args[args.indexOf('--format') + 1]!;
      // Docker templates fail on an absent map key; serializing the parent config succeeds.
      const labelOnly = format.includes('json .Config.Labels');
      const failed = !exists || (labelOnly && !Object.hasOwn(config, 'Labels'));
      if (!failed)
        child.stdout.emit(
          'data',
          Buffer.from(`${ID}|${JSON.stringify(labelOnly ? config.Labels : config)}\n`),
        );
      child.emit('close', failed ? 1 : 0);
    });
    return child;
  });
}
afterEach(() => vi.clearAllMocks());

it('reads an existing label-less image as no labels', async () => {
  image({ Env: [] });
  await expect(defaultDockerRunner.inspect(TAG)).resolves.toEqual({
    exists: true,
    imageId: ID,
    labels: {},
  });
});

it('keeps string labels and ignores non-string label values', async () => {
  image({ Labels: { 'haive.install': 'tib_second', 'haive.core-identity': 'a|b', invalid: 1 } });
  await expect(defaultDockerRunner.inspect(TAG)).resolves.toEqual({
    exists: true,
    imageId: ID,
    labels: { 'haive.install': 'tib_second', 'haive.core-identity': 'a|b' },
  });
});

it('reads a null label map as no labels', async () => {
  image({ Labels: null });
  await expect(defaultDockerRunner.inspect(TAG)).resolves.toEqual({
    exists: true,
    imageId: ID,
    labels: {},
  });
});

it('preserves the missing-image result when inspect fails', async () => {
  image({}, false);
  await expect(defaultDockerRunner.inspect(TAG)).resolves.toEqual({ exists: false, imageId: null });
});
