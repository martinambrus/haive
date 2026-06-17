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

/** POSIX-safe single-quote: wraps a string for use as one shell word, so a
 *  user/LLM command with env prefixes or spaces survives interpolation intact. */
function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Poll the app's port from inside the app-runner until it answers (curl 2xx/3xx),
 *  or the timeout elapses. Used both to launch-and-wait and to cheaply probe
 *  whether an already-running container still serves the app. */
export async function waitForPortInRunner(
  handle: AppRunnerHandle,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    const r = await appRunnerExec(
      handle,
      `curl -fsS -o /dev/null "http://localhost:${port}" && echo HAIVE_UP || true`,
      { timeoutMs: 10_000 },
    );
    if (r.output.includes('HAIVE_UP')) return true;
    if (Date.now() >= deadline) break;
    await new Promise((res) => setTimeout(res, 2000));
  } while (Date.now() < deadline);
  return false;
}

/** (Re)launch the app's dev server inside the app-runner: background it (nohup +
 *  disown) so it outlives this exec, through `bash -lc` so env-prefixed commands
 *  like `PORT=3000 npm run dev` parse correctly, then wait for the port. The one
 *  source of truth for the launch invariant — 01a-app-boot's first boot and
 *  ensureAppServing's post-restart relaunch both call this. */
export async function launchAppInRunner(
  handle: AppRunnerHandle,
  bootCommand: string,
  port: number,
  opts: { timeoutMs?: number } = {},
): Promise<{ healthy: boolean; logTail: string }> {
  await appRunnerExec(
    handle,
    `cd ${handle.projectDir} && nohup bash -lc ${shSingleQuote(bootCommand)} > /tmp/haive-app.log 2>&1 & disown`,
    { timeoutMs: 30_000 },
  );
  const healthy = await waitForPortInRunner(handle, port, opts.timeoutMs ?? 60_000);
  const tail = await appRunnerExec(handle, 'tail -c 2000 /tmp/haive-app.log 2>/dev/null || true', {
    timeoutMs: 15_000,
  });
  return { healthy, logTail: tail.output.slice(-1500) };
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

/** If the app-runner's headed-browser desktop is up (CDP answering on the 9223
 *  forward), return the DNS URL chrome-devtools connects to so the agent drives the
 *  SAME visible browser the user watches; else null. Mirrors runnerBrowserCdpUrl
 *  (ddev-runner) for the non-DDEV app-runner. */
export async function appRunnerBrowserCdpUrl(taskId: string): Promise<string | null> {
  const name = appRunnerName(taskId);
  try {
    await exec('docker', ['exec', name, 'curl', '-fsS', 'http://127.0.0.1:9223/json/version'], {
      timeout: 8_000,
    });
    return `http://${name}:9223`;
  } catch {
    return null;
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
