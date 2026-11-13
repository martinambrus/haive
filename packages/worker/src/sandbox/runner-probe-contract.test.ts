import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: h.exec }) };
});

import { probeRunner, requireRunnerPresence, RunnerProbeError } from './runner-probe.js';
const NAME = 'rlp-fixture';
const missing = (extra = {}) =>
  Object.assign(new Error('inspect failed'), {
    code: 1,
    stderr: `Error response from daemon: No such container: ${NAME}\n`,
    ...extra,
  });

beforeEach(() => {
  h.exec.mockReset();
});

describe('runner presence contract', () => {
  it.each([
    ['true', true],
    ['false', false],
  ] as const)('reads %s as a present runner', async (stdout, running) => {
    h.exec.mockResolvedValue({ stdout: `${stdout}\n`, stderr: '' });
    expect(await probeRunner(NAME)).toEqual({ state: 'present', running });
    expect(h.exec).toHaveBeenCalledWith(
      'docker',
      ['inspect', '-f', '{{.State.Running}}', '--type', 'container', NAME],
      { timeout: 15_000 },
    );
  });

  it.each(['Error response from daemon: No such container: ', 'Error: No such object: '])(
    'accepts exit 1 with the exact not-found contract %s',
    async (prefix) => {
      h.exec.mockRejectedValue(missing({ stderr: `${prefix}${NAME}\n` }));
      expect(await probeRunner(NAME)).toEqual({ state: 'absent' });
    },
  );

  it.each([
    ['another exit code', missing({ code: 125 })],
    ['spawn error', missing({ code: 'ENOENT' })],
    ['timeout', missing({ killed: true, signal: 'SIGTERM' })],
    [
      'another object',
      missing({ stderr: 'Error response from daemon: No such container: another\n' }),
    ],
    [
      'extra diagnostic',
      missing({
        stderr: `Error response from daemon: No such container: ${NAME}\nDaemon connection lost\n`,
      }),
    ],
    ['successful data alongside failure', missing({ stdout: 'true\n' })],
    ['unknown future wording', missing({ stderr: `Container ${NAME} missing\n` })],
    ['unstructured message', new Error(`No such container: ${NAME}`)],
  ])('fails retryably rather than calling %s absence', async (_label, cause) => {
    h.exec.mockRejectedValue(cause);
    const presence = await probeRunner(NAME);
    expect(presence).toMatchObject({ state: 'unknown', error: { retryable: true, cause } });
    await expect(requireRunnerPresence(NAME)).rejects.toBeInstanceOf(RunnerProbeError);
  });

  it('rejects an invalid successful reply and honors the caller timeout', async () => {
    h.exec.mockResolvedValue({ stdout: '<no value>\n', stderr: '' });
    await expect(requireRunnerPresence(NAME, 10_000)).rejects.toThrow(/Cannot determine.*Retry/);
    expect(h.exec.mock.calls[0]![2]).toEqual({ timeout: 10_000 });
  });
});
