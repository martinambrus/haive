import { spawn } from 'node:child_process';
import { APP_RUNNER_LABEL, logger } from '@haive/shared';

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
  const [labelIds, shellIds, ddevIds, appRunnerIds] = await Promise.all([
    listSandboxIdsByFilter('label=haive.task.id'),
    listSandboxIdsByFilter('name=haive-shell-'),
    listSandboxIdsByFilter('label=haive.ddev'),
    listSandboxIdsByFilter(`label=${APP_RUNNER_LABEL}`),
  ]);
  // The durable per-task runners (DDEV DinD + non-DDEV app-runner) carry
  // haive.task.id but are NOT orphaned CLI sandboxes — they're long-lived task
  // infra that ensureAppServing recovers on demand. Reaping them on every worker
  // restart forced a slow cold re-boot (DDEV re-pulls its images into a fresh
  // /var/lib/docker), surfacing as the VNC "Connection closed (1006)". Preserve
  // them; only the short-lived CLI sandboxes + terminal shells get reaped.
  const durable = new Set([...ddevIds, ...appRunnerIds]);
  const ids = Array.from(new Set([...labelIds, ...shellIds])).filter((id) => !durable.has(id));
  if (ids.length === 0) return 0;
  log.warn(
    { count: ids.length, preserved: durable.size, reason },
    'reaping orphan haive CLI sandbox/shell containers (durable runners preserved)',
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
    // -v drops each container's ANONYMOUS volumes (named volumes like haive_repos
    // are untouched). Critical for the DinD DDEV runners: each declares an anon
    // /var/lib/docker (1-2GB of nested images); reaping without -v orphans it.
    const child = spawn('docker', ['rm', '-f', '-v', ...ids]);
    child.on('close', () => resolve());
    child.on('error', () => resolve());
    setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 30_000);
  });
}
