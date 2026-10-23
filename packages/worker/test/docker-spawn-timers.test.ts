import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Run {
  stdout?: string;
  error?: boolean;
}

const h = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: h.spawn,
}));

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn((_signal: string) => true);
}

const { killSandboxContainersByTaskLabel } = await import('../src/queues/task-queue.js');
const { reapStaleComposedImages } = await import('../src/sandbox/composed-image-reaper.js');
const { killCliSandboxesForTask } = await import('../src/sandbox/sandbox-kill.js');
const { listTaskAuthVolumes } = await import('../src/sandbox/auth-volume-reaper.js');

const TASK = '0b0f7a52-3c5e-4e0a-9d6e-5a3f0c1d2e41';
let script: ((args: string[]) => Run) | null = null;
let children: Array<{ args: string[]; child: FakeChild }> = [];

beforeEach(() => {
  vi.useFakeTimers();
  script = null;
  children = [];
  h.spawn.mockReset();
  h.spawn.mockImplementation((cmd: string, args: string[]) => {
    if (!script || cmd !== 'docker') throw new Error(`unscripted spawn: ${cmd}`);
    const run = script(args);
    const child = new FakeChild();
    children.push({ args, child });
    queueMicrotask(() => {
      if (run.error) {
        child.emit('error', new Error('spawn docker ENOENT'));
        return;
      }
      if (run.stdout) child.stdout.emit('data', Buffer.from(run.stdout));
      child.emit('close', 0, null);
    });
    return child;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const verbs = (verb: string) => children.filter((c) => c.args[0] === verb);

async function expectNoTimerLeft(): Promise<void> {
  expect(h.spawn).toHaveBeenCalled();
  expect(children.length).toBeGreaterThan(0);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(31_000);
  for (const c of children) expect(c.child.kill).not.toHaveBeenCalled();
}

describe('task-queue killSandboxContainersByTaskLabel', () => {
  it('W3a clears the listing timer when the listing exits', async () => {
    script = () => ({ stdout: '' });
    await expect(killSandboxContainersByTaskLabel(TASK)).resolves.toBe(0);
    await expectNoTimerLeft();
  });

  it('W3b clears the listing timer when the listing cannot spawn', async () => {
    script = () => ({ error: true });
    await expect(killSandboxContainersByTaskLabel(TASK)).resolves.toBe(0);
    await expectNoTimerLeft();
  });

  it('W4a clears the removal timer when the removal exits', async () => {
    script = (args) => ({ stdout: args[0] === 'ps' ? 'abc\n' : '' });
    await expect(killSandboxContainersByTaskLabel(TASK)).resolves.toBe(1);
    expect(verbs('rm')).toHaveLength(1);
    await expectNoTimerLeft();
  });

  it('W4b clears the removal timer when the removal cannot spawn', async () => {
    script = (args) => (args[0] === 'ps' ? { stdout: 'abc\n' } : { error: true });
    await expect(killSandboxContainersByTaskLabel(TASK)).resolves.toBe(1);
    expect(verbs('rm')).toHaveLength(1);
    await expectNoTimerLeft();
  });
});

describe('composed-image-reaper dockerLines', () => {
  const REF = 'haive-sandbox:old';
  const answer = (args: string[]): Run => {
    if (args[0] === 'images') return { stdout: `${REF}\n` };
    return { stdout: '' };
  };

  it('W5a clears every timer when the commands exit', async () => {
    script = answer;
    await expect(reapStaleComposedImages()).resolves.toBe(0);
    expect(verbs('image')).toHaveLength(1);
    expect(verbs('ps')).toHaveLength(1);
    await expectNoTimerLeft();
  });

  it('W5b clears the listing timer when the listing cannot spawn', async () => {
    script = () => ({ error: true });
    await expect(reapStaleComposedImages()).resolves.toBe(0);
    await expectNoTimerLeft();
  });

  it('W5c clears the follow-up timers when the follow-ups cannot spawn', async () => {
    script = (args) => (args[0] === 'images' ? answer(args) : { error: true });
    await expect(reapStaleComposedImages()).resolves.toBe(0);
    expect(verbs('image')).toHaveLength(1);
    expect(verbs('ps')).toHaveLength(1);
    await expectNoTimerLeft();
  });
});

describe('sandbox-kill runDocker', () => {
  it('W6a clears the listing timer when the listing exits', async () => {
    script = () => ({ stdout: '' });
    await expect(killCliSandboxesForTask(TASK)).resolves.toBe(0);
    await expectNoTimerLeft();
  });

  it('W6b clears the listing timer when the listing cannot spawn', async () => {
    script = () => ({ error: true });
    await expect(killCliSandboxesForTask(TASK)).resolves.toBe(0);
    await expectNoTimerLeft();
  });

  it('W6c clears the removal timer when the removal exits', async () => {
    script = (args) => ({ stdout: args[0] === 'ps' ? 'abc\n' : '' });
    await expect(killCliSandboxesForTask(TASK)).resolves.toBe(1);
    expect(verbs('rm')).toHaveLength(1);
    await expectNoTimerLeft();
  });

  it('W6d clears the removal timer when the removal cannot spawn', async () => {
    script = (args) => (args[0] === 'ps' ? { stdout: 'abc\n' } : { error: true });
    await expect(killCliSandboxesForTask(TASK)).resolves.toBe(1);
    expect(verbs('rm')).toHaveLength(1);
    await expectNoTimerLeft();
  });
});

describe('auth-volume-reaper runDocker', () => {
  it('W7a clears the timer when the listing exits', async () => {
    script = () => ({ stdout: 'vol1\nvol2\n' });
    await expect(listTaskAuthVolumes()).resolves.toEqual(['vol1', 'vol2']);
    await expectNoTimerLeft();
  });

  it('W7b clears the timer when the listing cannot spawn', async () => {
    script = () => ({ error: true });
    await expect(listTaskAuthVolumes()).resolves.toEqual([]);
    await expectNoTimerLeft();
  });
});
