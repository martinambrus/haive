import { spawn } from 'node:child_process';

/** Force-removes all sandbox CLI containers for the given task. Used by the
 *  step-retry endpoint when a step is in `running`/`waiting_cli` to interrupt
 *  the active CLI process before resetting the step. The api container
 *  mounts the docker socket (see docker-compose.yml), so it can shell out
 *  to `docker rm -f` directly. Returns the count of containers killed. */
export async function killTaskSandboxes(taskId: string): Promise<number> {
  const ids = await listIds(taskId);
  if (ids.length === 0) return 0;
  await rmForce(ids);
  return ids.length;
}

function listIds(taskId: string): Promise<string[]> {
  return new Promise((resolve) => {
    let stdout = '';
    const child = spawn('docker', ['ps', '-q', '--filter', `label=haive.task.id=${taskId}`]);
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
