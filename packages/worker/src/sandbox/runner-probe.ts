import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const RUNNER_PROBE_TIMEOUT_MS = 15_000;

export type RunnerPresence =
  | { state: 'present'; running: boolean }
  | { state: 'absent' }
  | { state: 'unknown'; error: RunnerProbeError };

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
  timeout = RUNNER_PROBE_TIMEOUT_MS,
): Promise<RunnerPresence> {
  // Runner names use the install id's [a-z0-9_] plus hyphens and UUIDs. Validate
  // before embedding a name in the regex filter; a bad caller is a programming error.
  if (!/^[a-z0-9]/.test(name) || /[^a-z0-9_-]/.test(name)) {
    throw new Error(`Invalid runner name: ${name}`);
  }
  try {
    // MEASURED by the session with Docker 29.9.2 (host CLI) and 29.9.3 (worker
    // image CLI): this exact-name ps filter reports "running" for haive-postgres,
    // and empty stdout, exit 0, for a missing name or the partial haive-postgr.
    // Mirror ddevRunnerLife's anchored listing: absence needs no stderr wording.
    const { stdout } = await exec(
      'docker',
      ['ps', '-a', '--no-trunc', '--filter', `name=^/${name}$`, '--format', '{{.State}}'],
      { timeout },
    );
    const value = stdout.trim();
    switch (value) {
      case '':
        return { state: 'absent' };
      case 'running':
      case 'paused':
      case 'restarting':
        return { state: 'present', running: true };
      case 'created':
      case 'exited':
      case 'dead':
      case 'removing':
        return { state: 'present', running: false };
      default:
        return {
          state: 'unknown',
          error: new RunnerProbeError(
            name,
            new Error('Docker ps returned an invalid runner state listing'),
          ),
        };
    }
  } catch (cause) {
    return { state: 'unknown', error: new RunnerProbeError(name, cause) };
  }
}

/** Destructive and persistent decisions must not proceed on an unknown read. */
export async function requireRunnerPresence(
  name: string,
  timeout = RUNNER_PROBE_TIMEOUT_MS,
): Promise<Exclude<RunnerPresence, { state: 'unknown' }>> {
  const presence = await probeRunner(name, timeout);
  if (presence.state === 'unknown') throw presence.error;
  return presence;
}
