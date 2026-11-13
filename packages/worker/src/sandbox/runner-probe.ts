import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const RUNNER_INSPECT_TIMEOUT_MS = 15_000;

export type RunnerPresence =
  | { state: 'present'; running: boolean }
  | { state: 'absent' }
  | { state: 'unknown'; error: RunnerProbeError };

/** Docker CLI exposes no distinct not-found exit code: inspect errors all exit 1.
 * These exact, single-object stderr contracts are the ONLY wording we accept, with
 * the requested name appended. A changed CLI contract fails closed as unknown.
 * https://github.com/docker/cli/blob/master/cli/command/system/inspect.go
 * https://github.com/docker/cli/blob/master/cli/command/inspect/inspector.go
 */
const DOCKER_INSPECT_NOT_FOUND_PREFIXES = [
  'Error: No such object: ',
  'Error response from daemon: No such container: ',
];

export class RunnerProbeError extends Error {
  readonly retryable = true;

  constructor(name: string, cause: unknown) {
    super(
      `Cannot determine whether runner ${name} exists or is running. Retry when Docker is available.`,
      {
        cause,
      },
    );
    this.name = 'RunnerProbeError';
  }
}

/** One read for existence and liveness. Neither an invalid successful reply nor a
 * daemon, spawn or timeout failure is evidence that a runner may be replaced. */
export async function probeRunner(
  name: string,
  timeout = RUNNER_INSPECT_TIMEOUT_MS,
): Promise<RunnerPresence> {
  try {
    const { stdout } = await exec(
      'docker',
      ['inspect', '-f', '{{.State.Running}}', '--type', 'container', name],
      {
        timeout,
      },
    );
    const value = stdout.trim();
    if (value === 'true' || value === 'false') {
      return { state: 'present', running: value === 'true' };
    }
    return {
      state: 'unknown',
      error: new RunnerProbeError(
        name,
        new Error('Docker inspect returned an invalid running state'),
      ),
    };
  } catch (cause) {
    const error = cause as {
      code?: unknown;
      stderr?: unknown;
      stdout?: unknown;
      killed?: unknown;
      signal?: unknown;
    } | null;
    if (
      error?.code === 1 &&
      !error.killed &&
      !error.signal &&
      typeof error.stderr === 'string' &&
      (error.stdout == null || (typeof error.stdout === 'string' && !error.stdout.trim())) &&
      DOCKER_INSPECT_NOT_FOUND_PREFIXES.some(
        (prefix) => error.stderr === `${prefix}${name}\n` || error.stderr === `${prefix}${name}`,
      )
    ) {
      return { state: 'absent' };
    }
    return { state: 'unknown', error: new RunnerProbeError(name, cause) };
  }
}

/** Destructive and persistent decisions must not proceed on an unknown read. */
export async function requireRunnerPresence(
  name: string,
  timeout = RUNNER_INSPECT_TIMEOUT_MS,
): Promise<Exclude<RunnerPresence, { state: 'unknown' }>> {
  const presence = await probeRunner(name, timeout);
  if (presence.state === 'unknown') throw presence.error;
  return presence;
}
