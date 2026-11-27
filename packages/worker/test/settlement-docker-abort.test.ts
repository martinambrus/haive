import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { defaultDockerRunner } from '../src/sandbox/docker-runner.js';

const h = vi.hoisted(() => ({
  calls: [] as string[][],
  finish: undefined as (() => void) | undefined,
}));
vi.mock('node:child_process', () => ({
  spawn: (_cmd: string, args: string[]) => {
    h.calls.push(args);
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    h.finish = () => {
      child.stdout.emit('data', Buffer.from('stopped-helper\n'));
      child.emit('close', 0);
    };
    if (args[0] === 'rm') queueMicrotask(() => child.emit('close', 0));
    return child;
  },
}));

it('does not issue docker rm when the section ends during the stopped-container listing', async () => {
  const controller = new AbortController();
  const cleanup = defaultDockerRunner.removeStoppedContainersUsingVolume!(
    'volume',
    controller.signal,
  );
  controller.abort(new Error('section ended'));
  h.finish!();
  await expect(cleanup).rejects.toThrow('section ended');
  expect(h.calls.map((args) => args[0])).toEqual(['ps']);
});
