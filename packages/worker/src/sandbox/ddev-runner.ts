import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';
import { logger } from '@haive/shared';

// Per-task DDEV environment via nested Docker (DinD). DDEV can't run against the
// shared host daemon here (repos live in the haive_repos NAMED VOLUME, which the
// host daemon can't bind-mount), so each task gets its own privileged DinD
// container: DDEV talks to THAT container's nested dockerd, where the repo is a
// real local path (mounted via the named volume). See packages/worker/docker/
// ddev-runner for the image. Validated end-to-end (ddev start + import-db).

const exec = promisify(execFile);
const log = logger.child({ module: 'ddev-runner' });

const REPO_VOLUME = 'haive_repos';

/** Build context for the runner image (Dockerfile + entrypoint). Resolves
 *  relative to this module (src/sandbox or dist/sandbox -> ../../docker/
 *  ddev-runner); overridable for non-standard layouts. */
function runnerContextDir(): string {
  if (process.env.DDEV_RUNNER_CONTEXT) return process.env.DDEV_RUNNER_CONTEXT;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'docker', 'ddev-runner');
}

let cachedTag: string | null = null;

/** Content-hashed tag so the image rebuilds when the Dockerfile/entrypoint change. */
async function resolveImageTag(): Promise<string> {
  if (cachedTag) return cachedTag;
  const dir = runnerContextDir();
  const [dockerfile, entrypoint, browserCheck] = await Promise.all([
    readFile(path.join(dir, 'Dockerfile'), 'utf8'),
    readFile(path.join(dir, 'entrypoint.sh'), 'utf8'),
    readFile(path.join(dir, 'browser-check.js'), 'utf8'),
  ]);
  const hash = createHash('sha256')
    .update(dockerfile)
    .update('\0')
    .update(entrypoint)
    .update('\0')
    .update(browserCheck)
    .digest('hex')
    .slice(0, 12);
  cachedTag = `haive-ddev-runner:${hash}`;
  return cachedTag;
}

async function imageExists(tag: string): Promise<boolean> {
  try {
    await exec('docker', ['image', 'inspect', tag], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

/** Build the runner image if not already present. Idempotent + process-cached. */
export async function ensureDdevRunnerImage(): Promise<string> {
  const tag = await resolveImageTag();
  if (await imageExists(tag)) return tag;
  const dir = runnerContextDir();
  log.info({ tag, dir }, 'building haive-ddev-runner image');
  await exec('docker', ['build', '-t', tag, dir], {
    timeout: 900_000,
    maxBuffer: 50 * 1024 * 1024,
  });
  log.info({ tag }, 'haive-ddev-runner image built');
  return tag;
}

function runnerName(taskId: string): string {
  return `haive-ddev-${taskId.slice(0, 8)}`;
}

export interface DdevRunnerHandle {
  /** The DinD container name. */
  container: string;
  /** Project dir inside the runner (a real path on the runner's fs). */
  projectDir: string;
}

/** Handle for the (already-running) per-task runner that 01c-ddev-env launched,
 *  so later steps (e.g. 06a-db-migrate) can `ddev exec` into the same env. The
 *  runner lives for the task; if it's gone, ddevExec surfaces a clear failure. */
export function runnerHandleForTask(taskId: string, repoSubpath: string): DdevRunnerHandle {
  return { container: runnerName(taskId), projectDir: `/repos/${repoSubpath}` };
}

/** Launch a per-task DinD runner with the repo volume mounted, and wait for its
 *  nested dockerd. Labeled haive.task.id (so the existing cancel sweep + boot
 *  reaper find it) and haive.ddev (so killTaskDdevRunners can target it with
 *  -v to drop the anon /var/lib/docker volume). */
export async function startDdevRunner(params: {
  taskId: string;
  /** Repo subpath within the haive_repos volume, e.g. `<userId>/<repoId>`. */
  repoSubpath: string;
}): Promise<DdevRunnerHandle> {
  const tag = await ensureDdevRunnerImage();
  const name = runnerName(params.taskId);
  // Drop any stale runner from a prior attempt (with its anon volume).
  await exec('docker', ['rm', '-f', '-v', name], { timeout: 30_000 }).catch(() => {});
  await exec(
    'docker',
    [
      'run',
      '-d',
      '--privileged',
      '--name',
      name,
      '--label',
      `haive.task.id=${params.taskId}`,
      '--label',
      'haive.ddev=1',
      '-v',
      `${REPO_VOLUME}:/repos`,
      tag,
    ],
    { timeout: 60_000 },
  );

  let up = false;
  for (let i = 0; i < 60; i++) {
    try {
      await exec('docker', ['exec', name, 'docker', 'info'], { timeout: 10_000 });
      up = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (!up) {
    await exec('docker', ['rm', '-f', '-v', name], { timeout: 30_000 }).catch(() => {});
    throw new Error('ddev runner nested dockerd did not start');
  }
  log.info({ taskId: params.taskId, container: name }, 'ddev runner started');
  return { container: name, projectDir: `/repos/${params.repoSubpath}` };
}

/** Run a ddev subcommand inside the runner as the non-root `ddev` user, in the
 *  project dir. Returns combined output + an exit code (0 on success). */
export async function ddevExec(
  handle: DdevRunnerHandle,
  ddevArgs: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ exitCode: number; output: string }> {
  const cmd = `cd ${handle.projectDir} && ddev ${ddevArgs}`;
  try {
    const { stdout, stderr } = await exec(
      'docker',
      ['exec', '-u', 'ddev', handle.container, 'bash', '-lc', cmd],
      { timeout: opts.timeoutMs ?? 600_000, maxBuffer: 10 * 1024 * 1024 },
    );
    return { exitCode: 0, output: `${stdout}${stderr}`.slice(0, 8000) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { exitCode: e.code ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}`.slice(0, 8000) };
  }
}

/** Ensure the task's DDEV env is up and `ddev start`-ed, booting it if not.
 *  Idempotent: returns the existing handle when DDEV is already running (so a
 *  prior `import-db` is preserved); otherwise launches the runner + `ddev start`
 *  and THROWS if start fails. Callers treat a throw as a step failure — e.g. a
 *  task that just implemented `.ddev` (01c skipped early), where the browser-
 *  verify step boots the new config and a boot failure routes back to the dev. */
export async function ensureDdevStarted(
  taskId: string,
  repoSubpath: string,
): Promise<DdevRunnerHandle> {
  const existing = runnerHandleForTask(taskId, repoSubpath);
  const describe = await ddevExec(existing, 'describe -j', { timeoutMs: 15_000 });
  if (describe.exitCode === 0 && describe.output.includes('primary_url')) {
    return existing; // already running — don't re-boot (preserves an imported DB)
  }
  const handle = await startDdevRunner({ taskId, repoSubpath });
  const start = await ddevExec(handle, 'start', { timeoutMs: 900_000 });
  if (start.exitCode !== 0) {
    throw new Error(`ddev start failed: ${start.output.slice(-1500)}`);
  }
  return handle;
}

/** Run an arbitrary command inside the runner as the non-root `ddev` user (e.g.
 *  the baked-in headless-Chrome browser check). Returns combined output + exit
 *  code. Unlike ddevExec this does NOT prefix `ddev` or cd into the project. */
export async function runnerExec(
  handle: DdevRunnerHandle,
  command: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ exitCode: number; output: string }> {
  try {
    const { stdout, stderr } = await exec(
      'docker',
      ['exec', '-u', 'ddev', handle.container, 'bash', '-lc', command],
      { timeout: opts.timeoutMs ?? 120_000, maxBuffer: 10 * 1024 * 1024 },
    );
    return { exitCode: 0, output: `${stdout}${stderr}` };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { exitCode: e.code ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** Tear down every DinD runner for a task (container + its anon docker volume).
 *  Safe to call for any task; returns the number removed. */
export async function killTaskDdevRunners(taskId: string): Promise<number> {
  let ids: string[] = [];
  try {
    const { stdout } = await exec(
      'docker',
      ['ps', '-aq', '--filter', 'label=haive.ddev=1', '--filter', `label=haive.task.id=${taskId}`],
      { timeout: 15_000 },
    );
    ids = stdout.split(/\s+/).filter((s) => s.length > 0);
  } catch {
    return 0;
  }
  if (ids.length === 0) return 0;
  await exec('docker', ['rm', '-f', '-v', ...ids], { timeout: 60_000 }).catch(() => {});
  return ids.length;
}
