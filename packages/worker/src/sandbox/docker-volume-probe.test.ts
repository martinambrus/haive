import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultDockerRunner } from './docker-runner.js';

const h = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: h.spawn,
}));
beforeEach(() => {
  h.spawn.mockReset();
});
afterEach(() => vi.useRealTimers());

function respond(exit: number | null, stdout = '', error?: string, hang = false) {
  h.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => {
        child.emit('close', null);
        return true;
      }),
    });
    if (!hang)
      queueMicrotask(() => {
        child.stdout.write(stdout);
        if (error) child.emit('error', Object.assign(new Error(error), { code: 'ENOENT' }));
        child.emit('close', exit);
      });
    return child;
  });
}

it.each([
  ['present', 'copy\n', true],
  ['absent', '', false],
  ['partial name only', 'copy-sibling\n', false],
] as const)(
  'strict volume probe proves %s through a successful listing',
  async (_kind, out, expected) => {
    respond(0, out);
    expect(await defaultDockerRunner.volumeExists('copy', { throwOnFailure: true })).toBe(expected);
    expect(h.spawn.mock.calls[0]?.[1]).toEqual([
      'volume',
      'ls',
      '--filter',
      'name=copy',
      '--format',
      '{{.Name}}',
    ]);
  },
);

it.each([
  ['daemon failure', 1, undefined],
  ['Docker failure', 125, undefined],
  ['spawn failure', null, 'arbitrary text'],
] as const)(
  'strict volume probe throws on %s, regardless of message text',
  async (_kind, exit, error) => {
    respond(exit, '', error);
    await expect(
      defaultDockerRunner.volumeExists('copy', { throwOnFailure: true }),
    ).rejects.toThrow();
  },
);

it('strict volume probe throws on a timeout', async () => {
  vi.useFakeTimers();
  respond(null, '', undefined, true);
  const result = defaultDockerRunner.volumeExists('copy', { throwOnFailure: true }).then(
    () => false,
    () => true,
  );
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await result).toBe(true);
});

it('best-effort volume callers keep false on inspect failure', async () => {
  respond(1);
  expect(await defaultDockerRunner.volumeExists('copy')).toBe(false);
});
