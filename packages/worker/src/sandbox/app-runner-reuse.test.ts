import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNNER_SUBPATH_LABEL, appRunnerName } from '@haive/shared';

// A stateful fake docker: a runner is running while it is in `containers`, an `rm` is logged only
// when it removes one, and a `run` is logged and then stops the test where a cold boot begins.
const h = vi.hoisted(() => {
  const state = {
    containers: new Map<string, Record<string, string>>(),
    calls: [] as string[],
    unreadableLabel: null as string | null,
    probeFailure: null as Error | null,
    failExistenceOnly: false,
    probeReads: 0,
  };
  const out = (stdout: string) => ({ stdout, stderr: '' });
  const docker = async (_command: string, args: string[]) => {
    const [verb, ...rest] = args;
    if (verb === 'ps') {
      const name = rest[rest.indexOf('--filter') + 1]!.slice('name=^/'.length, -1);
      if (state.probeFailure && (!state.failExistenceOnly || ++state.probeReads > 1))
        throw state.probeFailure;
      return out(
        state.containers.has(name) ? (state.failExistenceOnly ? 'exited\n' : 'running\n') : '',
      );
    }
    if (verb === 'inspect') {
      const name = rest[rest.length - 1]!;
      const labels = state.containers.get(name);
      if (!labels) throw new Error('missing');
      if (rest[0] !== '-f') return out('[{}]');
      const format = rest[1]!;
      const label = /^\{\{index \.Config\.Labels "(.+)"\}\}$/.exec(format)?.[1];
      if (label === undefined) throw new Error(`fake docker: unhandled inspect format ${format}`);
      if (label === state.unreadableLabel) throw new Error('docker inspect timed out');
      return out(`${labels[label] ?? ''}\n`);
    }
    if (verb === 'rm') {
      for (const name of rest.filter((arg) => !arg.startsWith('-'))) {
        if (state.containers.delete(name)) state.calls.push(`rm ${name}`);
      }
      return out('');
    }
    if (verb === 'run') {
      state.calls.push(`run ${rest[rest.indexOf('--name') + 1]}`);
      throw new Error('cold boot reached');
    }
    throw new Error(`fake docker: unhandled ${verb}`);
  };
  return { state, docker };
});
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: h.docker }) };
});
vi.mock('../db.js', () => ({
  getDb: () => ({ query: { tasks: { findFirst: async () => null } } }),
}));
vi.mock('./runtime-caps.js', () => ({
  RUNTIME_WEIGHT_LABEL: 'haive.runtime.weight',
  buildResourceLimitArgs: () => [],
  resolveRunnerCaps: async () => null,
  resolveRuntimeWeightMb: async () => 2048,
}));
vi.mock('./runtime-admission.js', async () => ({
  ...(await vi.importActual<typeof import('./runtime-admission.js')>('./runtime-admission.js')),
  acquireRuntimeSlot: async () => () => {},
}));

import { ensureAppRunnerStarted } from './app-runner.js';

const TASK = '00000000-0000-4000-8000-0000000000c1';
const SUBPATH = '00000000-0000-4000-8000-0000000000a1/00000000-0000-4000-8000-0000000000b1';
const NAME = appRunnerName(TASK);
const ensure = () => ensureAppRunnerStarted(TASK, SUBPATH, 'image:tag');

beforeEach(() => {
  h.state.containers.clear();
  h.state.calls.length = 0;
  h.state.unreadableLabel = null;
  h.state.probeFailure = null;
  h.state.failExistenceOnly = false;
  h.state.probeReads = 0;
});

describe('ensureAppRunnerStarted with a runner already running', () => {
  it('reuses the runner that mounts this workspace', async () => {
    h.state.containers.set(NAME, { [RUNNER_SUBPATH_LABEL]: SUBPATH });

    await expect(ensure()).resolves.toEqual({ container: NAME, projectDir: `/repos/${SUBPATH}` });

    expect(h.state.calls).toEqual([]);
  });

  it('keeps a runner whose workspace label cannot be read: what cannot be read is not another workspace', async () => {
    h.state.containers.set(NAME, { [RUNNER_SUBPATH_LABEL]: SUBPATH });
    h.state.unreadableLabel = RUNNER_SUBPATH_LABEL;

    await expect(ensure()).resolves.toEqual({ container: NAME, projectDir: `/repos/${SUBPATH}` });

    expect(h.state.calls).toEqual([]);
  });

  it.each([
    ['another workspace', 'another-user/another-repository'],
    ['an empty label, a runner from before it existed', ''],
  ])('removes a runner holding %s, then cold boots', async (_holding, label) => {
    h.state.containers.set(NAME, { [RUNNER_SUBPATH_LABEL]: label });

    await expect(ensure()).rejects.toThrow('cold boot reached');

    expect(h.state.calls).toEqual([`rm ${NAME}`, `run ${NAME}`]);
  });
});

// Both probes used to turn an infrastructure failure into permission to remove a live runner.
describe('app runner inspect failures', () => {
  it.each([
    [
      'daemon failure',
      Object.assign(new Error('daemon unavailable'), {
        code: 1,
        stderr: 'Cannot connect to the Docker daemon',
      }),
      false,
    ],
    ['spawn failure', Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }), false],
    [
      'timeout',
      Object.assign(new Error('inspect timed out'), { killed: true, signal: 'SIGTERM' }),
      false,
    ],
    ['existence failure after a stopped read', new Error('inspect unavailable'), true],
  ])('preserves the runner on %s and allows Retry', async (_label, error, existenceOnly) => {
    h.state.containers.set(NAME, { [RUNNER_SUBPATH_LABEL]: SUBPATH });
    h.state.probeFailure = error;
    h.state.failExistenceOnly = existenceOnly;

    const errorRead = await ensure().catch((err: unknown) => err);
    expect(h.state.calls).toEqual([]);
    expect(errorRead).toBeInstanceOf(Error);
    expect((errorRead as Error).message).toMatch(/Cannot determine.*Retry/);
    expect(h.state.containers.has(NAME)).toBe(true);

    h.state.probeFailure = null;
    h.state.failExistenceOnly = false;
    h.state.probeReads = 0;
    await expect(ensure()).resolves.toEqual({ container: NAME, projectDir: `/repos/${SUBPATH}` });
  });

  it('creates a genuinely absent runner', async () => {
    await expect(ensure()).rejects.toThrow('cold boot reached');
    expect(h.state.calls).toEqual([`run ${NAME}`]);
  });
});
