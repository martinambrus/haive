import { spawn } from 'node:child_process';

/** Run a docker command, collecting stdout. Best-effort: spawn/non-zero errors
 *  resolve to whatever was captured (callers treat docker as fire-and-forget). */
function runDocker(args: string[], timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve) => {
    let stdout = '';
    const child = spawn('docker', args);
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.on('close', () => resolve(stdout));
    child.on('error', () => resolve(stdout));
    setTimeout(() => {
      child.kill('SIGKILL');
      resolve(stdout);
    }, timeoutMs);
  });
}

/** Force-remove the per-task cli-exec sandbox containers (named `haive-cli-…`,
 *  docker-runner.ts) for a task, WITHOUT touching the DDEV runtime (`haive-ddev-…`)
 *  or the app runner. The cli sandboxes carry only `haive.task.id`, the SAME label
 *  the DDEV runner carries (plus `haive.ddev=1`), so a label-only sweep would nuke
 *  the live runtime — the `name=^haive-cli-` filter is what keeps this DDEV-safe.
 *
 *  Used to cancel sibling coders still burning calls against a dead provider when a
 *  DAG step fails fast on a fatal provider error. At that point the only live cli
 *  sandboxes for the task are that step's coders; any best-effort mining/summary
 *  sandbox caught alongside is harmless (those runs are non-essential). Best-effort:
 *  docker errors are swallowed. Returns the number of containers removed. */
export async function killCliSandboxesForTask(taskId: string): Promise<number> {
  const list = await runDocker(
    ['ps', '-q', '--filter', `label=haive.task.id=${taskId}`, '--filter', 'name=^haive-cli-'],
    10_000,
  );
  const ids = list.split(/\s+/).filter((s) => s.length > 0);
  if (ids.length === 0) return 0;
  await runDocker(['rm', '-f', ...ids], 30_000);
  return ids.length;
}
