import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: h.exec }) };
});

import { probeRunner, requireRunnerPresence, RunnerProbeError } from './runner-probe.js';
const NAME = 'rlp-fixture';

beforeEach(() => {
  h.exec.mockReset();
});

describe('runner presence contract', () => {
  it.each([
    ['running', true],
    ['paused', true],
    ['restarting', true],
    ['created', false],
    ['exited', false],
    ['dead', false],
    ['removing', false],
  ] as const)('reads %s as a present runner', async (stdout, running) => {
    h.exec.mockResolvedValue({ stdout: `${stdout}\n` });
    expect(await probeRunner(NAME)).toEqual({ state: 'present', running });
    expect(h.exec).toHaveBeenCalledExactlyOnceWith(
      'docker',
      ['ps', '-a', '--no-trunc', '--filter', `name=^/${NAME}$`, '--format', '{{.State}}'],
      { timeout: 15_000 },
    );
  });

  it.each(['', ' \n\t'])('reads a successful empty listing as absent', async (stdout) => {
    h.exec.mockResolvedValue({ stdout });
    expect(await probeRunner(NAME)).toEqual({ state: 'absent' });
  });

  it.each([
    ['non-zero exit', { code: 1 }],
    ['another exit code', { code: 125 }],
    ['spawn error', { code: 'ENOENT' }],
    ['timeout', { killed: true, signal: 'SIGTERM' }],
    ['signal', { signal: 'SIGKILL' }],
    ['successful data alongside failure', { code: 1, stdout: 'running\n' }],
  ])('keeps %s unknown without reading stderr', async (_label, fields) => {
    const cause = Object.assign(new Error('listing failed'), fields);
    Object.defineProperty(cause, 'stderr', {
      get: () => {
        throw new Error('stderr must never be read');
      },
    });
    h.exec.mockRejectedValue(cause);
    const presence = await probeRunner(NAME);
    expect(presence).toMatchObject({ state: 'unknown', error: { retryable: true } });
    if (presence.state === 'unknown') expect(presence.error.cause).toBe(cause);
    await expect(requireRunnerPresence(NAME)).rejects.toBeInstanceOf(RunnerProbeError);
  });

  it.each([
    '<no value>\n',
    'true\n',
    'unknown-state\n',
    'running\nexited\n',
    'running\n\nrunning\n',
  ])('rejects an invalid successful listing %j and honors the caller timeout', async (stdout) => {
    h.exec.mockResolvedValue({ stdout });
    await expect(requireRunnerPresence(NAME, 10_000)).rejects.toBeInstanceOf(RunnerProbeError);
    expect(h.exec.mock.calls[0]![2]).toEqual({ timeout: 10_000 });
  });

  it.each([
    '',
    'runner.*',
    'runner[12]',
    'runner$',
    'runner/name',
    'runner\n',
    '-runner',
    'Runner',
  ])('rejects an invalid name %j before executing Docker', async (name) => {
    await expect(probeRunner(name)).rejects.toThrow(/Invalid runner name/);
    expect(h.exec).not.toHaveBeenCalled();
  });

  it('accepts the underscore in a configured install id', async () => {
    h.exec.mockResolvedValue({ stdout: '' });
    expect(await probeRunner('team_a-ide-repo-1234')).toEqual({ state: 'absent' });
    expect(h.exec.mock.calls[0]![1]).toContain('name=^/team_a-ide-repo-1234$');
  });
});
