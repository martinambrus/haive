import { spawn } from 'node:child_process';
import {
  APP_RUNNER_LABEL,
  CONTAINER_FAMILY,
  IDE_RUNNER_LABEL,
  INSTALL_LABEL,
  containerPrefix,
  logger,
  ownsLabelValue,
} from '@haive/shared';

const log = logger.child({ module: 'cli-container-reaper' });

// Docker's 10 s stop grace, less the 5 s module and terminal stops and the 1 s Redis quit, with 1 s spare.
export const SHUTDOWN_REAP_BUDGET_MS = 3_000;

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
export async function reapAllCliSandboxes(reason: string, budgetMs?: number): Promise<number> {
  if (budgetMs === undefined) return reapOwnedSandboxes(reason);
  const controller = new AbortController();
  const pending = { unlisted: new Set<string>(), unremoved: new Set<string>() };
  let timer: NodeJS.Timeout | undefined;
  const cut = new Promise<number>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      log.warn(
        {
          reason,
          budgetMs,
          unlisted: [...pending.unlisted],
          unremoved: [...pending.unremoved],
        },
        'cli sandbox reap cut at its shutdown budget; the next worker boot reaps the rest',
      );
      resolve(0);
    }, budgetMs);
  });
  try {
    return await Promise.race([reapOwnedSandboxes(reason, controller.signal, pending), cut]);
  } finally {
    clearTimeout(timer);
  }
}

async function reapOwnedSandboxes(
  reason: string,
  signal?: AbortSignal,
  pending?: { unlisted: Set<string>; unremoved: Set<string> },
): Promise<number> {
  const list = (filter: string): Promise<string[]> => {
    pending?.unlisted.add(filter);
    return listSandboxIdsByFilter(filter, signal).finally(() => pending?.unlisted.delete(filter));
  };
  const [labelIds, shellIds, ddevIds, appRunnerIds, ideIds] = await Promise.all([
    list('label=haive.task.id'),
    list(`name=${containerPrefix(CONTAINER_FAMILY.shell)}`),
    list('label=haive.ddev'),
    list(`label=${APP_RUNNER_LABEL}`),
    list(`label=${IDE_RUNNER_LABEL}`),
  ]);
  // The durable per-task runners (DDEV DinD + non-DDEV app-runner + browser IDE)
  // carry haive.task.id but are NOT orphaned CLI sandboxes — they're long-lived
  // task infra. Reaping the runtimes on every worker restart forced a slow cold
  // re-boot (DDEV re-pulls its images), surfacing as the VNC "Connection closed
  // (1006)"; reaping an open IDE would kill the user's live editor session. The
  // IDE's own idle reaper grace-stops it after the tab closes. Preserve them all;
  // only the short-lived CLI sandboxes + terminal shells get reaped.
  const durable = new Set([...ddevIds, ...appRunnerIds, ...ideIds]);
  const ids = Array.from(new Set([...labelIds, ...shellIds])).filter((id) => !durable.has(id));
  if (ids.length === 0 || signal?.aborted) return 0;
  log.warn(
    { count: ids.length, preserved: durable.size, reason },
    'reaping orphan haive CLI sandbox/shell containers (durable runners preserved)',
  );
  for (const id of ids) pending?.unremoved.add(id);
  await rmForce(ids, signal);
  for (const id of ids) pending?.unremoved.delete(id);
  return ids.length;
}

/**
 * Containers matching `filter` that THIS install owns.
 *
 * The ownership test is the whole reason this does not use `docker ps -q`. Every filter above is
 * a label (`haive.task.id`, `haive.ddev`, …) whose key and value shape are identical in every
 * Haive install, so on a machine running two of them this sweep would force-remove the other
 * one's live agent sandboxes on every worker boot. The install label separates them — and it is
 * read out with `--format` rather than added to `--filter` because a docker filter cannot express
 * "this value OR absent", and absent is exactly what every container predating the label is.
 */
function listSandboxIdsByFilter(filter: string, signal?: AbortSignal): Promise<string[]> {
  return new Promise((resolve) => {
    let stdout = '';
    const child = spawn('docker', [
      'ps',
      '--filter',
      filter,
      '--format',
      `{{.ID}}\t{{.Label "${INSTALL_LABEL}"}}`,
    ]);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve([]);
    }, 10_000);
    signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.on('close', () => {
      clearTimeout(timer);
      const ids: string[] = [];
      for (const line of stdout.split('\n')) {
        if (line.trim().length === 0) continue;
        const [id, label] = line.split('\t');
        if (id && ownsLabelValue(label)) ids.push(id.trim());
      }
      resolve(ids);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve([]);
    });
  });
}

function rmForce(ids: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // -v drops each container's ANONYMOUS volumes (named volumes like haive_repos
    // are untouched). Critical for the DinD DDEV runners: each declares an anon
    // /var/lib/docker (1-2GB of nested images); reaping without -v orphans it.
    const child = spawn('docker', ['rm', '-f', '-v', ...ids]);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 30_000);
    signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
    child.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
