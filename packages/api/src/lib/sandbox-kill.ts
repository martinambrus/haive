import { spawn } from 'node:child_process';
import { CONTAINER_FAMILY, containerPrefix } from '@haive/shared';
import { logger, safeErrorMessage } from '@haive/shared/logger';

export type SandboxKillResult = {
  killed: number;
  killConfirmed: boolean;
  killError?: 'sandbox_listing_failed' | 'sandbox_removal_failed';
};

/** Force-removes the per-task cli-exec sandbox containers (named `haive-cli-…`)
 *  for the given task, WITHOUT touching the DDEV runtime (`haive-ddev-…`) or the
 *  app runner. Used to interrupt the active CLI process — by `cancel-active-cli`
 *  (Stop) and by the step-retry/resume endpoints — before resetting the step.
 *  The cli sandboxes carry only `haive.task.id`, the SAME label the DDEV/app
 *  runners carry, so a label-only sweep would nuke the live runtime; the
 *  `name=^haive-cli-` filter is what keeps this runtime-safe (mirrors the
 *  worker's `killCliSandboxesForTask`). The api container mounts the docker
 *  socket (see docker-compose.yml), so it can shell out to `docker rm -f`
 *  directly. Reports confirmation after removal succeeds or a re-list proves
 *  no live sandbox remains. */
export async function killTaskSandboxes(taskId: string): Promise<SandboxKillResult> {
  const { ids, failure } = await listIds(taskId);
  if (failure !== null) {
    return { killed: 0, killConfirmed: false, killError: 'sandbox_listing_failed' };
  }
  if (ids.length === 0) return { killed: 0, killConfirmed: true };
  const removal = await rmForce(ids);
  if (removal !== null && !(await waitUntilGone(taskId))) {
    return { killed: 0, killConfirmed: false, killError: 'sandbox_removal_failed' };
  }
  return { killed: ids.length, killConfirmed: true };
}

/** The strict twin of `killTaskSandboxes`: it rejects with a fixed reason code when cleanup is unconfirmed. */
export async function killTaskSandboxesOrThrow(taskId: string): Promise<number> {
  const listed = await listIds(taskId);
  if (listed.failure !== null) throw new Error('sandbox_listing_failed');
  if (listed.ids.length === 0) return 0;
  const removal = await rmForce(listed.ids);
  // A sandbox that is already being removed fails this removal too, so what stays listed decides.
  if (removal !== null && !(await waitUntilGone(taskId))) {
    throw new Error('sandbox_removal_failed');
  }
  return listed.ids.length;
}

interface DockerRun {
  stdout: string;
  failure: string | null;
}

const RELIST_INTERVAL_MS = 250;
const RELIST_WINDOW_MS = 3_000;

async function waitUntilGone(taskId: string): Promise<boolean> {
  const until = Date.now() + RELIST_WINDOW_MS;
  for (;;) {
    const after = await listIds(taskId);
    if (after.failure !== null) return false;
    if (after.liveIds.length === 0) return true;
    const left = until - Date.now();
    if (left <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(left, RELIST_INTERVAL_MS)));
  }
}

async function listIds(
  taskId: string,
): Promise<{ ids: string[]; liveIds: string[]; failure: string | null }> {
  const { stdout, failure } = await runDocker(
    [
      'ps',
      '-a',
      '--format',
      '{{.ID}}\t{{.State}}',
      '--filter',
      `label=haive.task.id=${taskId}`,
      '--filter',
      `name=^${containerPrefix(CONTAINER_FAMILY.cli)}`,
    ],
    10_000,
  );
  const rows = stdout.trim()
    ? stdout
        .trim()
        .split('\n')
        .map((line) => line.split('\t'))
    : [];
  const states = new Set([
    'created',
    'running',
    'restarting',
    'paused',
    'exited',
    'removing',
    'dead',
  ]);
  // Unknown or malformed output cannot prove absence. State comes from Docker, never stderr.
  if (rows.some(([id, state, extra]) => !id || !states.has(state ?? '') || extra !== undefined)) {
    return { ids: [], liveIds: [], failure: 'invalid_container_listing' };
  }
  const live = new Set(['created', 'running', 'restarting', 'paused']);
  return {
    ids: rows.map(([id]) => id!),
    liveIds: rows.filter(([, state]) => live.has(state!)).map(([id]) => id!),
    failure,
  };
}

async function rmForce(ids: string[]): Promise<string | null> {
  return (await runDocker(['rm', '-f', ...ids], 30_000)).failure;
}

function dockerFailure(operation: string, error: unknown): string {
  logger.warn({ operation, error: safeErrorMessage(error) }, 'sandbox Docker command failed');
  return 'docker_command_failed';
}

async function runDocker(args: string[], timeoutMs: number): Promise<DockerRun> {
  try {
    return await new Promise<DockerRun>((resolve) => {
      let stdout = '';
      let stderr = '';
      const child = spawn('docker', args);
      const timer = setTimeout(() => {
        resolve({
          stdout: '',
          failure: dockerFailure(args[0]!, new Error('Docker command timed out')),
        });
        child.kill('SIGKILL');
      }, timeoutMs);
      child.stdout.on('data', (b: Buffer) => {
        stdout += b.toString('utf8');
      });
      child.stderr.on('data', (b: Buffer) => {
        stderr += b.toString('utf8');
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        const line = stderr.trim().split('\n').pop()?.trim();
        resolve({
          stdout,
          failure:
            code === 0
              ? null
              : dockerFailure(
                  args[0]!,
                  new Error(`exit ${code ?? signal}${line ? `: ${line}` : ''}`),
                ),
        });
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ stdout: '', failure: dockerFailure(args[0]!, err) });
      });
    });
  } catch (err) {
    return { stdout: '', failure: dockerFailure(args[0]!, err) };
  }
}
