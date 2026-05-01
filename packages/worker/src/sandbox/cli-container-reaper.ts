import { spawn } from 'node:child_process';
import { logger } from '@haive/shared';

const log = logger.child({ module: 'cli-container-reaper' });

/** Kills all running sandbox CLI containers (filtered by haive.task.id label).
 *  Used on worker boot and shutdown to clean up containers orphaned by an
 *  earlier worker pid that died mid-job (e.g. tsx watch restart, SIGKILL).
 *  Single-worker assumption — DO NOT call from a multi-worker deployment
 *  without scoping the label to a per-worker id, as it'd kill peers' jobs. */
export async function reapAllCliSandboxes(reason: string): Promise<number> {
  const ids = await listSandboxIds();
  if (ids.length === 0) return 0;
  log.warn({ count: ids.length, reason, ids }, 'reaping orphan cli sandbox containers');
  await rmForce(ids);
  return ids.length;
}

function listSandboxIds(): Promise<string[]> {
  return new Promise((resolve) => {
    let stdout = '';
    const child = spawn('docker', ['ps', '-q', '--filter', 'label=haive.task.id']);
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
