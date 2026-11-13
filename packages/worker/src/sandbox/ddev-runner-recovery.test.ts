import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ exec: vi.fn(), acquire: vi.fn(), release: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: h.exec }) };
});
vi.mock('@haive/shared/fs-safe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/fs-safe')>()),
  lstatNoFollow: vi.fn(async () => null),
}));
vi.mock('../repo/worktree-permissions.js', () => ({
  ensureSandboxWritableTree: vi.fn(async () => {}),
}));
vi.mock('../db.js', () => ({
  getDb: () => ({
    query: {
      tasks: { findFirst: async () => null },
      taskDatabaseStates: { findFirst: async () => null },
    },
  }),
}));
vi.mock('./runtime-admission.js', () => ({ acquireRuntimeSlot: h.acquire }));
vi.mock('./runtime-caps.js', () => ({
  resolveRunnerCaps: async () => null,
  buildResourceLimitArgs: vi.fn(),
}));
vi.mock('./_browser-access.js', () => ({ resolveTaskDirectAccess: async () => false }));
vi.mock('./docker-runner.js', () => ({ buildMountArgs: () => [] }));

import { configService, RUNNER_SUBPATH_LABEL } from '@haive/shared';
import { ensureDdevStarted, runnerHandleForTask } from './ddev-runner.js';
import { RunnerProbeError } from './runner-probe.js';
import { taskRunnerBusy } from './runner-activity.js';

const task = 'recovery-fixture';
const subpath = 'user/repo';
const handle = runnerHandleForTask(task, subpath);
const coldReached = new Error('cold creation reached');
const reply = (stdout = '') => ({ stdout, stderr: '' });
const project = (status = 'running') =>
  JSON.stringify({ raw: { status, primary_url: 'https://fixture.ddev.site' } });
const mutations = () => h.exec.mock.calls.filter(([, args]) => ['rm', 'run'].includes(args[0]));

type Probe = 'presence' | 'workspace' | 'dockerd' | 'describe' | 'warm start';
let failAt: Probe | undefined;
let failure: unknown;
let presence: string;
let label: string;
let dockerd: string;
let status: string;

beforeEach(() => {
  vi.restoreAllMocks();
  h.exec.mockReset();
  h.acquire.mockReset().mockResolvedValue(h.release);
  h.release.mockReset();
  vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
  failAt = undefined;
  failure = undefined;
  presence = 'running';
  label = subpath;
  dockerd = 'up';
  status = 'running';
  h.exec.mockImplementation(async (_bin: string, args: string[]) => {
    let probe: Probe | undefined;
    let stdout = '';
    if (args[0] === 'ps') {
      probe = 'presence';
      stdout = presence;
    } else if (args[0] === 'inspect') {
      if (args.at(-2)?.includes(RUNNER_SUBPATH_LABEL)) {
        probe = 'workspace';
        stdout = label;
      } else stdout = '<no value>,<no value>';
    } else if (args[0] === 'exec') {
      const command = args.at(-1) ?? '';
      if (presence === '' || presence === 'exited' || (command === 'info' && dockerd === 'down'))
        throw Object.assign(new Error('exec unavailable'), { code: 1 });
      if (command === 'info' || command.includes('docker info')) {
        probe = 'dockerd';
        stdout = dockerd;
      } else if (command.includes('ddev describe -j')) {
        probe = 'describe';
        stdout = project(status);
      } else if (command.endsWith('ddev start')) probe = 'warm start';
    } else if (args[0] === 'run') throw coldReached;
    else if (args[0] === 'rm') presence = '';
    if (probe && probe === failAt) {
      if (failure instanceof Error) throw failure;
      return reply(String(failure));
    }
    return reply(stdout);
  });
});

describe('DDEV recovery keeps runners when a probe gave no answer', () => {
  const failures = [
    ['timeout', { killed: true, signal: 'SIGTERM' }],
    ['signal', { code: null, signal: 'SIGKILL' }],
    ['spawn error', { code: 'ENOENT' }],
    ['daemon/exec non-zero', { code: 1 }],
  ] as const;

  describe.each<Probe>(['presence', 'workspace', 'dockerd', 'describe', 'warm start'])(
    '%s',
    (probe) => {
      it.each(failures)('holds on %s and permits a later ensure', async (_kind, fields) => {
        failAt = probe;
        failure = Object.assign(new Error('arbitrary failure wording'), fields);
        if (probe === 'dockerd' || probe === 'warm start') status = 'stopped';

        // Concurrent callers share the failure, then release the boot entry for Retry.
        const results = await Promise.allSettled([
          ensureDdevStarted(task, subpath),
          ensureDdevStarted(task, subpath),
        ]);
        expect(mutations()).toEqual([]);
        for (const result of results) {
          expect(result.status).toBe('rejected');
          if (result.status === 'rejected') {
            expect(result.reason).toBeInstanceOf(RunnerProbeError);
            expect(result.reason.retryable).toBe(true);
          }
        }
        expect(h.acquire).not.toHaveBeenCalled();
        expect(taskRunnerBusy(task)).toBe(false);

        failAt = undefined;
        status = 'running';
        await expect(ensureDdevStarted(task, subpath)).resolves.toEqual(handle);
        expect(mutations()).toEqual([]);
        expect(taskRunnerBusy(task)).toBe(false);
      });
    },
  );

  it.each<Probe>(['presence', 'dockerd', 'describe'])(
    'holds on an invalid successful %s reply',
    async (probe) => {
      failAt = probe;
      failure = 'invalid reply';
      status = 'stopped';
      await expect(ensureDdevStarted(task, subpath)).rejects.toBeInstanceOf(RunnerProbeError);
      expect(mutations()).toEqual([]);
    },
  );

  it('keeps the runner when both describe and the dockerd exec fail', async () => {
    h.exec.mockImplementation(async (_bin: string, args: string[]) => {
      if (args[0] === 'ps') return reply('running');
      if (args[0] === 'inspect') return reply(subpath);
      if (args[0] === 'exec') throw Object.assign(new Error('exec failed'), { code: 1 });
      if (args[0] === 'run') throw coldReached;
      return reply();
    });
    await expect(ensureDdevStarted(task, subpath)).rejects.toBeInstanceOf(RunnerProbeError);
    expect(mutations()).toEqual([]);
  });

  it.each(['absent', 'dockerd down', 'stopped runner', 'different workspace'])(
    'still cold-boots a definite %s and releases admission on failure',
    async (state) => {
      if (state === 'absent') {
        presence = '';
        // The old implementation first tries describe/info even when the runner is gone.
        failAt = 'dockerd';
        failure = Object.assign(new Error('no runner'), { code: 1 });
        status = 'stopped';
      }
      if (state === 'dockerd down') {
        dockerd = 'down';
        status = 'stopped';
      }
      if (state === 'stopped runner') presence = 'exited';
      if (state === 'different workspace') label = 'user/another-repo';

      await expect(ensureDdevStarted(task, subpath)).rejects.toBe(coldReached);
      expect(mutations().map(([, args]) => args[0])).toContain('rm');
      expect(mutations().map(([, args]) => args[0])).toContain('run');
      expect(h.release).toHaveBeenCalledTimes(1);
      expect(taskRunnerBusy(task)).toBe(false);

      presence = 'running';
      label = subpath;
      dockerd = 'up';
      status = 'running';
      failAt = undefined;
      await expect(ensureDdevStarted(task, subpath)).resolves.toEqual(handle);
    },
  );

  it('reuses a serving project and warm-starts a stopped project in place', async () => {
    await expect(ensureDdevStarted(task, subpath)).resolves.toEqual(handle);
    status = 'stopped';
    await expect(ensureDdevStarted(task, subpath)).resolves.toEqual(handle);
    expect(h.exec.mock.calls.some(([, args]) => args.at(-1)?.endsWith('ddev start'))).toBe(true);
    expect(mutations()).toEqual([]);
  });
});
