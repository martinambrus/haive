import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_RUNNER_LABEL, IDE_RUNNER_LABEL, INSTALL_LABEL } from '@haive/shared';

interface Run {
  stdout?: string;
  error?: boolean;
  exitCode?: number;
  hang?: boolean;
}

const h = vi.hoisted(() => ({ spawn: vi.fn(), findTask: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: h.spawn,
}));
vi.mock('../src/db.js', () => ({
  getDb: () => ({ query: { tasks: { findFirst: h.findTask } } }),
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
  vi.stubEnv('HAIVE_INSTALL_ID', 'haive');
  h.findTask.mockReset().mockResolvedValue(undefined);
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
      if (!run.hang) child.emit('close', run.exitCode ?? 0, null);
    });
    return child;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
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

  it('discards listing output when docker exits unsuccessfully', async () => {
    script = () => ({ stdout: 'abc\thaive\t\t\t\n', exitCode: 1 });

    await expect(killSandboxContainersByTaskLabel(TASK)).resolves.toBe(0);

    expect(verbs('rm')).toHaveLength(0);
    await expectNoTimerLeft();
  });

  it('discards partial ownership metadata when the listing times out', async () => {
    script = (args) => (args[0] === 'ps' ? { stdout: 'abc\thaive\t\t\t', hang: true } : {});
    const killing = killSandboxContainersByTaskLabel(TASK);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(killing).resolves.toBe(0);

    expect(verbs('rm')).toHaveLength(0);
    expect(children[0]!.child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe.each(['haive', 'rio'])('cancel container ownership for install %s', (install) => {
  const kinds = ['sandbox', 'haive.ddev', APP_RUNNER_LABEL, IDE_RUNNER_LABEL];
  const fixture = (id: string, kind: string, label?: string) => ({
    id,
    labels: {
      'haive.task.id': TASK,
      ...(kind === 'sandbox' ? {} : { [kind]: '1' }),
      ...(label === undefined ? {} : { [INSTALL_LABEL]: label }),
    } as Record<string, string>,
  });
  const list = (containers: ReturnType<typeof fixture>[]) => {
    script = (args) => {
      if (args[0] !== 'ps') return {};
      expect(args).toContain(`label=haive.task.id=${TASK}`);
      const format = args.includes('--format') ? args[args.indexOf('--format') + 1]! : '{{.ID}}';
      return {
        stdout: containers
          .map(({ id, labels }) =>
            format
              .replaceAll('{{.ID}}', id)
              .replace(/\{\{\.Label "([^"]+)"\}\}/g, (_, key: string) => labels[key] ?? ''),
          )
          .join('\n'),
      };
    };
  };
  beforeEach(() => vi.stubEnv('HAIVE_INSTALL_ID', install));

  it('removes this install’s containers and keeps foreign containers with the same task id', async () => {
    list(
      kinds.flatMap((kind, i) => [
        fixture(`own-${i}`, kind, install),
        fixture(`foreign-${i}`, kind, 'elsewhere'),
      ]),
    );

    await expect(killSandboxContainersByTaskLabel(TASK)).resolves.toBe(kinds.length);

    expect(verbs('rm').map(({ args }) => args)).toEqual([
      ['rm', '-f', ...kinds.map((_, i) => `own-${i}`)],
    ]);
    expect(h.findTask).not.toHaveBeenCalled();
    await expectNoTimerLeft();
  });

  it.each([false, true])(
    'uses task proof for legacy runners and the sandbox legacy rule (known task: %s)',
    async (known) => {
      h.findTask.mockResolvedValue(known ? { id: TASK } : undefined);
      list(kinds.map((kind, i) => fixture(`legacy-${i}`, kind)));
      const ids = kinds.flatMap((_, i) =>
        (i === 0 ? install === 'haive' : known) ? [`legacy-${i}`] : [],
      );

      await expect(killSandboxContainersByTaskLabel(TASK)).resolves.toBe(ids.length);

      expect(verbs('rm').map(({ args }) => args)).toEqual(ids.length ? [['rm', '-f', ...ids]] : []);
      await expectNoTimerLeft();
    },
  );

  it('keeps legacy runners when the ownership lookup fails', async () => {
    h.findTask.mockRejectedValue(new Error('database unavailable'));
    list(kinds.slice(1).map((kind, i) => fixture(`legacy-${i}`, kind)));

    await expect(killSandboxContainersByTaskLabel(TASK)).resolves.toBe(0);

    expect(verbs('rm')).toHaveLength(0);
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
