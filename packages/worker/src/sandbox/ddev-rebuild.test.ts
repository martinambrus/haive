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
import { rebuildDdevRunner, ensureDdevStarted } from './ddev-runner.js';
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
  await expect(rebuild()).rejects.toThrow(/busy/i);
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
  await expect(rebuild()).rejects.toThrow(/ownership|workspace/i);
  expect(mutations()).toEqual([]);
  expect(h.ensure).not.toHaveBeenCalled();
});
it('an absent runner is ensured only', async () => {
  presence = '';
  await rebuild();
  expect(mutations()).toEqual([]);
  expect(h.ensure).toHaveBeenCalledTimes(1);
  expect(h.event).not.toHaveBeenCalled();
});
it('removes an owned immutable runner with its volume, records the user, then ensures', async () => {
  await rebuild();
  expect(mutations()[0]?.[1]).toEqual(['rm', '-f', '-v', 'immutable-id']);
  expect(h.event).toHaveBeenCalledWith(
    expect.objectContaining({
      taskId: task,
      eventType: 'ddev_rebuild',
      payload: expect.objectContaining({ userId: 'owner' }),
    }),
  );
  expect(h.exec.mock.invocationCallOrder.at(-1)).toBeLessThan(h.event.mock.invocationCallOrder[0]!);
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
  expect(h.event).not.toHaveBeenCalled();
  expect(h.ensure).not.toHaveBeenCalled();
});
it('serializes concurrent rebuilds and holds a new ensure until removal settles', async () => {
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
  const ensure = ensureDdevStarted(task, workspace);
  expect(h.ensure).not.toHaveBeenCalled();
  release();
  await Promise.all([first, second]);
  await expect(ensure).rejects.toThrow(); // the fake has no boot implementation
  expect(mutations()).toHaveLength(2);
});

it('fails visibly when the required user event cannot be recorded', async () => {
  h.event.mockRejectedValueOnce(new Error('event store unavailable'));
  await expect(rebuild()).rejects.toThrow('event store unavailable');
  expect(mutations()).toHaveLength(1);
  expect(h.ensure).not.toHaveBeenCalled();
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
