import { spawn } from 'node:child_process';
import { CONTAINER_FAMILY, containerPrefix } from '@haive/shared';

/** Force-removes the per-task cli-exec sandbox containers (named `haive-cli-…`)
 *  for the given task, WITHOUT touching the DDEV runtime (`haive-ddev-…`) or the
 *  app runner. Used to interrupt the active CLI process — by `cancel-active-cli`
 *  (Stop) and by the step-retry/resume endpoints — before resetting the step.
 *  The cli sandboxes carry only `haive.task.id`, the SAME label the DDEV/app
 *  runners carry, so a label-only sweep would nuke the live runtime; the
 *  `name=^haive-cli-` filter is what keeps this runtime-safe (mirrors the
 *  worker's `killCliSandboxesForTask`). The api container mounts the docker
 *  socket (see docker-compose.yml), so it can shell out to `docker rm -f`
 *  directly. Returns the count of containers killed. */
export async function killTaskSandboxes(taskId: string): Promise<number> {
  const { ids } = await listIds(taskId);
  if (ids.length === 0) return 0;
  await rmForce(ids);
  return ids.length;
}

/** The strict twin of `killTaskSandboxes`: it rejects, naming the step that failed and why. */
export async function killTaskSandboxesOrThrow(taskId: string): Promise<number> {
  const listed = await listIds(taskId);
  if (listed.failure !== null) throw new Error(`sandbox listing failed: ${listed.failure}`);
  if (listed.ids.length === 0) return 0;
  const removal = await rmForce(listed.ids);
  // A sandbox that is already being removed fails this removal too, so what stays listed decides.
  if (removal !== null && !(await waitUntilGone(taskId, listed.ids))) {
    throw new Error(`sandbox removal failed: ${removal}`);
  }
  return listed.ids.length;
}

interface DockerRun {
  stdout: string;
  failure: string | null;
}

const RELIST_INTERVAL_MS = 250;
const RELIST_WINDOW_MS = 3_000;

async function waitUntilGone(taskId: string, ids: string[]): Promise<boolean> {
  const until = Date.now() + RELIST_WINDOW_MS;
  for (;;) {
    const after = await listIds(taskId);
    if (after.failure !== null) return false;
    if (!after.ids.some((id) => ids.includes(id))) return true;
    const left = until - Date.now();
    if (left <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(left, RELIST_INTERVAL_MS)));
  }
}

async function listIds(taskId: string): Promise<{ ids: string[]; failure: string | null }> {
  const { stdout, failure } = await runDocker(
    [
      'ps',
      '-q',
      '--filter',
      `label=haive.task.id=${taskId}`,
      '--filter',
      `name=^${containerPrefix(CONTAINER_FAMILY.cli)}`,
    ],
    10_000,
  );
  return { ids: stdout.split(/\s+/).filter((s) => s.length > 0), failure };
}

async function rmForce(ids: string[]): Promise<string | null> {
  return (await runDocker(['rm', '-f', ...ids], 30_000)).failure;
}

async function runDocker(args: string[], timeoutMs: number): Promise<DockerRun> {
  try {
    return await new Promise<DockerRun>((resolve) => {
      let stdout = '';
      let stderr = '';
      const child = spawn('docker', args);
      child.stdout.on('data', (b: Buffer) => {
        stdout += b.toString('utf8');
      });
      child.stderr.on('data', (b: Buffer) => {
        stderr += b.toString('utf8');
      });
      child.on('close', (code, signal) => {
        const line = stderr.trim().split('\n').pop()?.trim();
        resolve({
          stdout,
          failure: code === 0 ? null : `exit ${code ?? signal}${line ? `: ${line}` : ''}`,
        });
      });
      child.on('error', (err) => resolve({ stdout: '', failure: err.message }));
      setTimeout(() => {
        resolve({ stdout: '', failure: 'timed out' });
        child.kill('SIGKILL');
      }, timeoutMs);
    });
  } catch (err) {
    return { stdout: '', failure: err instanceof Error ? err.message : String(err) };
  }
}
