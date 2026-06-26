import { spawn } from 'node:child_process';

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
  const ids = await listIds(taskId);
  if (ids.length === 0) return 0;
  await rmForce(ids);
  return ids.length;
}

function listIds(taskId: string): Promise<string[]> {
  return new Promise((resolve) => {
    let stdout = '';
    const child = spawn('docker', [
      'ps',
      '-q',
      '--filter',
      `label=haive.task.id=${taskId}`,
      '--filter',
      'name=^haive-cli-',
    ]);
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.on('close', () => {
      resolve(stdout.split(/\s+/).filter((s) => s.length > 0));
    });
    child.on('error', () => resolve([]));
    setTimeout(() => {
      child.kill('SIGKILL');
      resolve([]);
    }, 10_000);
  });
}

function rmForce(ids: string[]): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['rm', '-f', ...ids]);
    child.on('close', () => resolve());
    child.on('error', () => resolve());
    setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 30_000);
  });
}
