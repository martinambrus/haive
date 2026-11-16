import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<object>()),
  spawn: h.spawn,
}));
vi.mock('../src/sandbox/runtime-caps.js', () => ({
  resourceLimitsEnabled: async () => true,
}));
import { SandboxToolchainProbe } from '../src/sandbox/toolchain-probe.js';
import { defaultDockerRunner } from '../src/sandbox/docker-runner.js';
class Child extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn(() => {
    queueMicrotask(() => this.emit('close', null));
    return true;
  });
}
afterEach(() => vi.useRealTimers());
it('sends isolation flags and awaits named container removal before settling a timed-out probe', async () => {
  vi.useFakeTimers();
  const run = new Child();
  const removal = new Child();
  h.spawn.mockImplementation((_cmd: string, args: string[]) => (args[0] === 'run' ? run : removal));
  const probe = new SandboxToolchainProbe(defaultDockerRunner, { timeoutMs: 10 });
  let settled = false;
  const pending = probe.get(`sha256:${'a'.repeat(64)}`).then((value) => {
    settled = true;
    return value;
  });
  await vi.advanceTimersByTimeAsync(10);
  const args = h.spawn.mock.calls[0]![1] as string[];
  expect(args).toContain('--read-only');
  expect(args.slice(args.indexOf('--pull'), args.indexOf('--pull') + 2)).toEqual([
    '--pull',
    'never',
  ]);
  expect(args.slice(args.indexOf('--cap-drop'), args.indexOf('--cap-drop') + 2)).toEqual([
    '--cap-drop',
    'ALL',
  ]);
  expect(args.slice(args.indexOf('--security-opt'), args.indexOf('--security-opt') + 2)).toEqual([
    '--security-opt',
    'no-new-privileges',
  ]);
  expect(args).toContain('--rm');
  expect(args).toContain('none');
  expect(args).toContain('64m');
  expect(args).toContain('haive.toolchain-probe=1');
  expect(args.some((arg) => arg.startsWith('haive.install='))).toBe(true);
  const name = args[args.indexOf('--name') + 1];
  expect(h.spawn.mock.calls[1]?.[1]).toEqual(['rm', '-f', name]);
  expect(settled).toBe(false);
  removal.emit('close', 0);
  expect(await pending).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds captured host output as well as container memory and cleans up an oversized probe', async () => {
  vi.useFakeTimers();
  h.spawn.mockReset();
  const run = new Child();
  const removal = new Child();
  h.spawn.mockImplementation((_cmd: string, args: string[]) => (args[0] === 'run' ? run : removal));
  const probe = new SandboxToolchainProbe(defaultDockerRunner, { outputLimitBytes: 4 });
  let settled = false;
  const pending = probe.get(`sha256:${'b'.repeat(64)}`).then((value) => {
    settled = true;
    return value;
  });
  await vi.advanceTimersByTimeAsync(0);
  run.stdout.emit('data', Buffer.from('12345'));
  await vi.advanceTimersByTimeAsync(0);
  expect(run.kill).toHaveBeenCalledWith('SIGKILL');
  expect(h.spawn.mock.calls[1]?.[1]?.[0]).toBe('rm');
  expect(settled).toBe(false);
  removal.emit('close', 0);
  expect(await pending).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps ordinary sandbox run flags unchanged when the probe options are omitted', async () => {
  h.spawn.mockReset();
  h.spawn.mockImplementation(() => {
    const child = new Child();
    queueMicrotask(() => child.emit('close', 0));
    return child;
  });
  await defaultDockerRunner.run({ image: 'ordinary:image', cmd: ['true'] });
  const args = h.spawn.mock.calls[0]![1] as string[];
  for (const flag of ['--pull', '--cap-drop', '--security-opt']) expect(args).not.toContain(flag);
});
