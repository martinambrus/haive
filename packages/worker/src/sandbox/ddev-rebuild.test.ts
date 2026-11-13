import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  exec: vi.fn(),
  live: vi.fn(),
  execLive: vi.fn(),
  step: vi.fn(),
  event: vi.fn(),
  ensure: vi.fn(),
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: h.exec }) };
});
vi.mock('@haive/shared/fs-safe', async (original) => ({
  ...(await original<typeof import('@haive/shared/fs-safe')>()),
  lstatNoFollow: vi.fn(async () => null),
}));
vi.mock('../repo/worktree-permissions.js', () => ({
  ensureSandboxWritableTree: vi.fn(async () => {}),
}));
vi.mock('./_browser-access.js', () => ({ resolveTaskDirectAccess: async () => false }));
vi.mock('../db.js', () => ({
  getDb: () => ({
    query: { taskSteps: { findFirst: h.step } },
    insert: () => ({ values: h.event }),
  }),
}));
vi.mock('./runtime-admission.js', () => ({ markBrowserDesktopDown: vi.fn() }));
vi.mock('../orchestrator/pause.js', () => ({ hasLiveCliInvocation: h.live }));
vi.mock('./runner-activity.js', async (original) => ({
  ...(await original<typeof import('./runner-activity.js')>()),
  runnerExecLive: h.execLive,
}));
import { INSTALL_LABEL, RUNNER_SUBPATH_LABEL, installId } from '@haive/shared';
import { rebuildDdevRunner, ensureDdevStarted, runnerHandleForTask } from './ddev-runner.js';
import { RunnerProbeError } from './runner-probe.js';
import { whileRunnerBusy } from './runner-activity.js';
import { ddevRunnerName } from '@haive/shared';
const task = 'rebuild-fixture';
const workspace = 'user/repo';
let presence: string;
let install: string;
let subpath: string;
const mutations = () => h.exec.mock.calls.filter(([, args]) => args[0] === 'rm');
beforeEach(() => {
  vi.clearAllMocks();
  presence = 'running';
  install = installId();
  subpath = workspace;
  h.live.mockResolvedValue(false);
  h.execLive.mockResolvedValue(false);
  h.step.mockResolvedValue(undefined);
  h.event.mockResolvedValue(undefined);
  h.ensure.mockResolvedValue(undefined);
  h.exec.mockImplementation(async (_bin: string, args: string[]) => {
    if (args[0] === 'ps') return { stdout: presence, stderr: '' };
    if (args[0] === 'inspect' && (args.includes('--format') || args.includes('-f')))
      return {
        stdout: args.at(-2)?.includes(RUNNER_SUBPATH_LABEL) ? workspace : '<no value>,<no value>',
        stderr: '',
      };
    if (args[0] === 'exec')
      return {
        stdout: JSON.stringify({
          raw: { status: 'running', primary_url: 'https://fixture.ddev.site' },
        }),
        stderr: '',
      };
    if (args[0] === 'inspect')
      return {
        stdout: JSON.stringify([
          {
            Id: 'immutable-id',
            Config: { Labels: { [INSTALL_LABEL]: install, [RUNNER_SUBPATH_LABEL]: subpath } },
          },
        ]),
        stderr: '',
      };
    if (args[0] === 'rm') return { stdout: '', stderr: '' };
    throw new Error('Unexpected Docker operation: ' + args.join(' '));
  });
});
const rebuild = () => rebuildDdevRunner(task, workspace, 'owner', h.ensure);
it('uses the dotted name for the rebuild request event', async () => {
  await rebuild();
  expect(h.event).toHaveBeenCalledWith(
    expect.objectContaining({ eventType: 'ddev.rebuild.requested' }),
  );
});
it('refuses an in-process exec without removing its runner', async () => {
  await whileRunnerBusy(ddevRunnerName(task), async () => {
    await expect(rebuild()).rejects.toThrow(/busy/i);
  });
  expect(mutations()).toEqual([]);
  expect(h.ensure).not.toHaveBeenCalled();
});
it.each(['cli', 'step', 'orphaned exec'])('refuses a busy %s', async (kind) => {
  if (kind === 'cli') h.live.mockResolvedValue(true);
  if (kind === 'step') h.step.mockResolvedValue({ id: 'running' });
  if (kind === 'orphaned exec') h.execLive.mockResolvedValue(true);
  await expect(rebuild()).rejects.toMatchObject({ refusal: { reason: 'busy', retryable: true } });
  expect(mutations()).toEqual([]);
  expect(h.ensure).not.toHaveBeenCalled();
});
it('an unknown presence raises RunnerProbeError and removes nothing', async () => {
  presence = 'invalid';
  await expect(rebuild()).rejects.toBeInstanceOf(RunnerProbeError);
  expect(mutations()).toEqual([]);
  expect(h.ensure).not.toHaveBeenCalled();
});
it.each(['install', 'workspace'])('refuses a foreign %s', async (kind) => {
  if (kind === 'install') install = 'foreign';
  else subpath = 'user/other-repo';
  await expect(rebuild()).rejects.toMatchObject({
    refusal: {
      reason: kind === 'install' ? 'foreign-runner' : 'workspace-mismatch',
      retryable: false,
    },
  });
  expect(mutations()).toEqual([]);
  expect(h.ensure).not.toHaveBeenCalled();
});
it('an absent runner is ensured only', async () => {
  presence = '';
  await expect(rebuild()).resolves.toEqual({ removed: false });
  expect(mutations()).toEqual([]);
  expect(h.ensure).toHaveBeenCalledTimes(1);
  expect(h.event).not.toHaveBeenCalled();
});
it('records the requesting user before removing an owned runner and ensuring recovery', async () => {
  await expect(rebuild()).resolves.toEqual({ removed: true });
  expect(mutations()[0]?.[1]).toEqual(['rm', '-f', '-v', 'immutable-id']);
  expect(h.event).toHaveBeenCalledWith(
    expect.objectContaining({
      taskId: task,
      eventType: 'ddev.rebuild.requested',
      payload: expect.objectContaining({ userId: 'owner', action: 'requested' }),
    }),
  );
  expect(h.event.mock.invocationCallOrder[0]).toBeLessThan(h.exec.mock.invocationCallOrder.at(-1)!);
  expect(h.event.mock.invocationCallOrder[0]).toBeLessThan(h.ensure.mock.invocationCallOrder[0]!);
});
it('does not report success or ensure when the removal fails', async () => {
  h.exec.mockImplementation(async (_bin, args) => {
    if (args[0] === 'ps') return { stdout: 'running' };
    if (args[0] === 'inspect')
      return {
        stdout: JSON.stringify([
          {
            Id: 'id',
            Config: { Labels: { [INSTALL_LABEL]: installId(), [RUNNER_SUBPATH_LABEL]: workspace } },
          },
        ]),
      };
    throw new Error('remove failed');
  });
  await expect(rebuild()).rejects.toThrow('remove failed');
  expect(h.event).toHaveBeenCalledWith(
    expect.objectContaining({
      payload: expect.objectContaining({ userId: 'owner', action: 'requested' }),
    }),
  );
  expect(h.ensure).not.toHaveBeenCalled();
});
it('serializes concurrent rebuilds and holds a new ensure until removal settles', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  let removing!: () => void;
  const started = new Promise<void>((r) => {
    removing = r;
  });
  const base = h.exec.getMockImplementation()!;
  h.exec.mockImplementation(async (...args) => {
    if (args[1][0] === 'rm') {
      removing();
      await held;
    }
    return base(...args);
  });
  const first = rebuild();
  await started;
  const second = rebuild();
  const beforeEnsure = h.exec.mock.calls.length;
  const onReady = vi.fn(async () => {});
  const ensure = ensureDdevStarted(task, workspace, { onReady });
  const settled = Promise.allSettled([first, second, ensure]);
  try {
    // Drain runnable work with removal still held. The real ensure must not even
    // probe Docker, and the second rebuild must not enter its removal either.
    await vi.advanceTimersByTimeAsync(0);
    expect(h.exec).toHaveBeenCalledTimes(beforeEnsure);
    expect(onReady).not.toHaveBeenCalled();
    expect(mutations()).toHaveLength(1);
  } finally {
    release();
    await settled;
    vi.useRealTimers();
  }
  await expect(first).resolves.toEqual({ removed: true });
  await expect(second).resolves.toEqual({ removed: true });
  await expect(ensure).resolves.toEqual(runnerHandleForTask(task, workspace));
  expect(onReady).toHaveBeenCalledOnce();
  expect(mutations()).toHaveLength(2);
});

it('fails visibly when the required user event cannot be recorded', async () => {
  h.event.mockRejectedValueOnce(new Error('event store unavailable'));
  await expect(rebuild()).rejects.toThrow('event store unavailable');
  expect(mutations()).toHaveLength(0);
  expect(h.ensure).not.toHaveBeenCalled();
});
it('awaits the request audit write before attempting removal', async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  h.event.mockImplementationOnce(() => {
    entered();
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const rebuilding = rebuild();
  await started;
  const removedBeforeAudit = mutations().length;
  release();
  await rebuilding;
  expect(removedBeforeAudit).toBe(0);
  expect(mutations()).toHaveLength(1);
});
it('keeps the runner if an exec arrives during the request audit write', async () => {
  let release!: () => void;
  let arriving: Promise<void> | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.event.mockImplementationOnce(async () => {
    arriving = whileRunnerBusy(ddevRunnerName(task), () => held);
  });
  const outcome = rebuild().catch((error: unknown) => error);
  const result = await outcome;
  release();
  await arriving;
  expect(result).toBeInstanceOf(Error);
  expect(result).toMatchObject({ message: expect.stringMatching(/busy/) });
  expect(mutations()).toEqual([]);
  expect(h.ensure).not.toHaveBeenCalled();
});
it('keeps the request event when enqueue fails and redrives an absent runner', async () => {
  h.ensure.mockRejectedValueOnce(new Error('enqueue failed'));
  await expect(rebuild()).rejects.toThrow('enqueue failed');
  expect(mutations()).toHaveLength(1);
  expect(h.event).toHaveBeenCalledWith(
    expect.objectContaining({
      payload: expect.objectContaining({ userId: 'owner', action: 'requested' }),
    }),
  );
  presence = '';
  await rebuild();
  expect(mutations()).toHaveLength(1);
  expect(h.event).toHaveBeenCalledOnce();
  expect(h.ensure).toHaveBeenCalledTimes(2);
});
it('keeps the runner if an exec arrives while ownership is inspected', async () => {
  const base = h.exec.getMockImplementation()!;
  let release!: () => void;
  let arriving: Promise<void> | undefined;
  const held = new Promise<void>((r) => {
    release = r;
  });
  h.exec.mockImplementation(async (...args) => {
    if (args[1][0] === 'inspect') arriving = whileRunnerBusy(ddevRunnerName(task), () => held);
    return base(...args);
  });
  await expect(rebuild()).rejects.toThrow(/busy/i);
  release();
  await arriving;
  expect(mutations()).toEqual([]);
  expect(h.ensure).not.toHaveBeenCalled();
});

it.each(['refused', 'failed'])(
  'a step ensure queued mid-rebuild succeeds after it is %s',
  async (kind) => {
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const base = h.exec.getMockImplementation()!;
    let inspected = false;
    h.exec.mockImplementation(async (...args) => {
      if (args[1][0] === 'inspect' && !inspected) {
        inspected = true;
        entered();
        await held;
        if (kind === 'failed') throw new Error('inspection failed');
        h.step.mockResolvedValueOnce({ id: 'newly-running-step' });
      }
      return base(...args);
    });
    const rebuilding = rebuild();
    const outcome = expect(rebuilding).rejects.toThrow(
      kind === 'failed' ? /Cannot determine/ : /busy/,
    );
    await started;
    const onReady = vi.fn(async () => {});
    const step = ensureDdevStarted(task, workspace, {
      signal: new AbortController().signal,
      onReady,
    });
    const observed = step.catch((error: unknown) => error);
    release();
    await outcome;
    expect(await observed).toEqual(runnerHandleForTask(task, workspace));
    expect(onReady).toHaveBeenCalledOnce();
    expect(mutations()).toEqual([]);
  },
);
