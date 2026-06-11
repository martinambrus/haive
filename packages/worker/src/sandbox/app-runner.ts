import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { APP_RUNNER_LABEL, appRunnerName, logger } from '@haive/shared';

// Per-task app-runner: a plain (non-DinD) container built from the repo's
// env-replicate image. It runs a single-process non-DDEV app AND hosts the
// headed-browser desktop, so browser testing + the Gate 2 live view work the
// same way they do for DDEV. Because it is one container per task with no host
// port publishing, concurrent tasks on the same repo never collide — the
// container is the isolation boundary (mirrors the DDEV DinD runner). The
// browser, running inside the same container, reaches the app at localhost.

const exec = promisify(execFile);
const log = logger.child({ module: 'app-runner' });

const REPO_VOLUME = 'haive_repos';

export interface AppRunnerHandle {
  /** The app-runner container name. */
  container: string;
  /** Project dir inside the runner (the worktree under the mounted repo volume). */
  projectDir: string;
}

/** Handle for the (already-running) per-task app-runner. */
export function appRunnerHandleForTask(taskId: string, repoSubpath: string): AppRunnerHandle {
  return { container: appRunnerName(taskId), projectDir: `/repos/${repoSubpath}` };
}

/** Directory holding the browser-desktop assets (launcher + probe scripts). They
 *  live alongside the DDEV runner image build context and are shared by both
 *  runtimes: the DDEV image bakes them at build time, the app-runner injects
 *  them at startup via `docker cp` (the env-image build context is the repo, so
 *  they can't be COPYed into the env image). Overridable for non-standard
 *  layouts via the same env var the DDEV runner uses. */
function browserAssetsDir(): string {
  if (process.env.DDEV_RUNNER_CONTEXT) return process.env.DDEV_RUNNER_CONTEXT;
  const here = path.dirname(fileURLToPath(import.meta.url)); // src/sandbox or dist/sandbox
  return path.resolve(here, '..', '..', 'docker', 'ddev-runner');
}

async function containerExists(name: string): Promise<boolean> {
  try {
    await exec('docker', ['inspect', name], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

async function isRunning(name: string): Promise<boolean> {
  try {
    const { stdout } = await exec('docker', ['inspect', '-f', '{{.State.Running}}', name], {
      timeout: 15_000,
    });
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/** Copy the headed-browser desktop launcher + probe scripts into the running
 *  container. The env image already carries the binaries (chromium, xvfb,
 *  x11vnc, socat) + puppeteer-core under /opt/browser; this just delivers the
 *  scripts the env-image build couldn't COPY. Best-effort — a failure leaves the
 *  app running but without the browser desktop. */
async function injectBrowserAssets(container: string): Promise<void> {
  const dir = browserAssetsDir();
  await exec('docker', ['exec', container, 'mkdir', '-p', '/opt/browser'], { timeout: 15_000 });
  for (const f of ['browser-check.js', 'browser-probe-connect.js']) {
    await exec('docker', ['cp', path.join(dir, f), `${container}:/opt/browser/${f}`], {
      timeout: 30_000,
    });
  }
  await exec(
    'docker',
    [
      'cp',
      path.join(dir, 'start-browser-desktop.sh'),
      `${container}:/usr/local/bin/start-browser-desktop.sh`,
    ],
    { timeout: 30_000 },
  );
  await exec(
    'docker',
    ['exec', container, 'chmod', '+x', '/usr/local/bin/start-browser-desktop.sh'],
    {
      timeout: 15_000,
    },
  );
}

/** Launch a per-task app-runner from the repo's env image: a long-lived
 *  container (`sleep infinity`) with the repo volume mounted and a NIC on the
 *  internal sandbox network (so the api's VNC bridge + sandboxed CLIs reach it by
 *  DNS name). Labeled haive.task.id (for the cancel sweep) and haive.apprunner
 *  (so killTaskAppRunners targets it). Drops any stale runner first. */
export async function startAppRunner(params: {
  taskId: string;
  /** Repo subpath within the haive_repos volume, e.g. `<userId>/<repoId>/.haive/...`. */
  repoSubpath: string;
  /** The env-replicate image tag to run. */
  imageTag: string;
}): Promise<AppRunnerHandle> {
  const name = appRunnerName(params.taskId);
  await exec('docker', ['rm', '-f', name], { timeout: 30_000 }).catch(() => {});
  await exec(
    'docker',
    [
      'run',
      '-d',
      '--name',
      name,
      '--label',
      `haive.task.id=${params.taskId}`,
      '--label',
      `${APP_RUNNER_LABEL}=1`,
      '-v',
      `${REPO_VOLUME}:/repos`,
      params.imageTag,
      'sleep',
      'infinity',
    ],
    { timeout: 60_000 },
  );

  const sandboxNetwork = process.env.SANDBOX_NETWORK;
  if (sandboxNetwork) {
    await exec('docker', ['network', 'connect', sandboxNetwork, name], { timeout: 15_000 }).catch(
      (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/already exists in network/.test(msg)) {
          log.warn({ err: msg, name, sandboxNetwork }, 'app runner network connect failed');
        }
      },
    );
  }

  await injectBrowserAssets(name).catch((err) => {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), name },
      'browser asset injection failed (app runs, but no live browser desktop)',
    );
  });

  log.info({ taskId: params.taskId, container: name }, 'app runner started');
  return { container: name, projectDir: `/repos/${params.repoSubpath}` };
}

/** Ensure the task's app-runner is up, launching it if not. Idempotent: returns
 *  the existing handle when the container is already running; a stopped/stale
 *  container is removed and recreated. */
export async function ensureAppRunnerStarted(
  taskId: string,
  repoSubpath: string,
  imageTag: string,
): Promise<AppRunnerHandle> {
  const name = appRunnerName(taskId);
  if (await isRunning(name)) {
    return { container: name, projectDir: `/repos/${repoSubpath}` };
  }
  if (await containerExists(name)) {
    await exec('docker', ['rm', '-f', name], { timeout: 30_000 }).catch(() => {});
  }
  return startAppRunner({ taskId, repoSubpath, imageTag });
}

/** Run a command inside the app-runner (as the image's default user, in the
 *  project dir unless the caller cd's elsewhere). Returns combined output + exit
 *  code; never throws (mirrors ddev-runner's runnerExec). */
export async function appRunnerExec(
  handle: AppRunnerHandle,
  command: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ exitCode: number; output: string }> {
  try {
    const { stdout, stderr } = await exec(
      'docker',
      ['exec', handle.container, 'bash', '-lc', command],
      { timeout: opts.timeoutMs ?? 120_000, maxBuffer: 10 * 1024 * 1024 },
    );
    return { exitCode: 0, output: `${stdout}${stderr}` };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { exitCode: e.code ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** Start (idempotently) the headed-browser desktop inside the app-runner. The
 *  launcher is pgrep-guarded so re-runs are no-ops. Throws when it fails to come
 *  up. The web noVNC panel attaches via the api bridge to <container>:5900. */
export async function startBrowserDesktop(handle: AppRunnerHandle): Promise<void> {
  const res = await appRunnerExec(handle, 'start-browser-desktop.sh', { timeoutMs: 60_000 });
  if (res.exitCode !== 0) {
    throw new Error(`browser desktop failed to start: ${res.output.slice(-1000)}`);
  }
}

/** Tear down every app-runner for a task. Safe to call for any task; returns the
 *  number removed. */
export async function killTaskAppRunners(taskId: string): Promise<number> {
  let ids: string[] = [];
  try {
    const { stdout } = await exec(
      'docker',
      [
        'ps',
        '-aq',
        '--filter',
        `label=${APP_RUNNER_LABEL}=1`,
        '--filter',
        `label=haive.task.id=${taskId}`,
      ],
      { timeout: 15_000 },
    );
    ids = stdout.split(/\s+/).filter((s) => s.length > 0);
  } catch {
    return 0;
  }
  if (ids.length === 0) return 0;
  await exec('docker', ['rm', '-f', ...ids], { timeout: 60_000 }).catch(() => {});
  return ids.length;
}
