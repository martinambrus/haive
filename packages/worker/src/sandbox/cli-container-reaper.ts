import { spawn } from 'node:child_process';
import { logger } from '@haive/shared';

const log = logger.child({ module: 'cli-container-reaper' });

/** Kills all running haive-managed sandbox containers — both CLI exec
 *  sandboxes (label `haive.task.id`) and per-task terminal shells
 *  (label `haive.role=terminal-shell`, name prefix `haive-shell-`).
 *  Used on worker boot and shutdown to clean up containers orphaned by an
 *  earlier worker pid that died mid-job (e.g. tsx watch restart, SIGKILL).
 *  Single-worker assumption — DO NOT call from a multi-worker deployment
 *  without scoping the label to a per-worker id, as it'd kill peers' jobs.
 *
 *  Two passes (label + name prefix) are unioned so a shell container that
 *  somehow lost its labels still gets reaped via the deterministic name. */
export async function reapAllCliSandboxes(reason: string): Promise<number> {
  const [labelIds, shellIds] = await Promise.all([
    listSandboxIdsByFilter('label=haive.task.id'),
    listSandboxIdsByFilter('name=haive-shell-'),
  ]);
  const ids = Array.from(new Set([...labelIds, ...shellIds]));
  if (ids.length === 0) return 0;
  log.warn(
    { count: ids.length, byLabel: labelIds.length, byShellName: shellIds.length, reason },
    'reaping orphan haive sandbox/shell containers',
  );
  await rmForce(ids);
  return ids.length;
}

function listSandboxIdsByFilter(filter: string): Promise<string[]> {
  return new Promise((resolve) => {
    let stdout = '';
    const child = spawn('docker', ['ps', '-q', '--filter', filter]);
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
