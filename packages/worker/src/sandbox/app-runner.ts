import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import { APP_RUNNER_LABEL, appRunnerName, logger, type TaskAccessEndpoint } from '@haive/shared';
import { schema } from '@haive/database';
import { getDb } from '../db.js';
import { browserCdpUrlForRunner } from './runner-browser-cdp.js';
import { resolveTaskDirectAccess } from './_browser-access.js';

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
  /** The port the app listens on inside the runner. When set and direct browser
   *  access is enabled, it is published to an ephemeral 127.0.0.1 host port so the
   *  user can open the app in their own browser (the fast VNC alternative). */
  appPort?: number;
  /** On-demand step-debugging: when true, set NODE_OPTIONS so the app's Node process
   *  starts a debugger on 0.0.0.0:9229, reachable from the Editor tab (Lane C2). */
  debugMode?: boolean;
}): Promise<AppRunnerHandle> {
  const name = appRunnerName(params.taskId);
  await exec('docker', ['rm', '-f', '-v', name], { timeout: 30_000 }).catch(() => {});

  // Direct browser access (per-task, global kill-switch): publish the app port to an
  // ephemeral loopback host port so the user can hit http://localhost:<H> directly.
  // Bound to 127.0.0.1 only (no LAN exposure); Docker assigns the host port, read back
  // later by appRunnerAccessUrls. resolveTaskDirectAccess => the 01b-browser-access
  // (workflow) / 98-choose-view (run_app) opt-in AND the global flag; default/off path
  // is byte-for-byte the old no-publish behavior (the rollback).
  const publishArgs: string[] = [];
  if (params.appPort) {
    const directAccess = await resolveTaskDirectAccess(params.taskId);
    if (directAccess) publishArgs.push('-p', `127.0.0.1::${params.appPort}`);
  }

  // Lane C2: a debug-mode task gets NODE_OPTIONS so the app's Node process opens an
  // inspector on 0.0.0.0:9229 (reachable on the sandbox network; the Editor tab's
  // localhost:9229 forward bridges to it). Container-wide, so it works for direct
  // `node` boots; npm/yarn wrappers grab 9229 first and may need a manual tweak.
  const debugEnvArgs = params.debugMode ? ['-e', 'NODE_OPTIONS=--inspect=0.0.0.0:9229'] : [];

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
      ...publishArgs,
      ...debugEnvArgs,
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
const inFlightAppRunnerBoots = new Map<string, Promise<AppRunnerHandle>>();

export async function ensureAppRunnerStarted(
  taskId: string,
  repoSubpath: string,
  imageTag: string,
  appPort?: number,
): Promise<AppRunnerHandle> {
  // Coalesce concurrent boots of the same task (08a apply + VNC runtime-ensure)
  // into one — two startAppRunner calls would collide on the container name.
  const inFlight = inFlightAppRunnerBoots.get(taskId);
  if (inFlight) return inFlight;
  const boot = ensureAppRunnerStartedInner(taskId, repoSubpath, imageTag, appPort);
  inFlightAppRunnerBoots.set(taskId, boot);
  try {
    return await boot;
  } finally {
    inFlightAppRunnerBoots.delete(taskId);
  }
}

async function ensureAppRunnerStartedInner(
  taskId: string,
  repoSubpath: string,
  imageTag: string,
  appPort?: number,
): Promise<AppRunnerHandle> {
  const name = appRunnerName(taskId);
  if (await isRunning(name)) {
    return { container: name, projectDir: `/repos/${repoSubpath}` };
  }
  if (await containerExists(name)) {
    await exec('docker', ['rm', '-f', '-v', name], { timeout: 30_000 }).catch(() => {});
  }
  // Read the task's debug flag here (single point) so the container is created with
  // the Node inspector when debug mode is on, without threading the flag through
  // every ensureAppRunnerStarted caller. Best-effort: a lookup failure just means
  // no inspector (app still runs).
  const debugMode = await isTaskDebugMode(taskId);
  return startAppRunner({ taskId, repoSubpath, imageTag, appPort, debugMode });
}

/** Whether the task opted into step-debugging (tasks.debug_mode). Swallows lookup
 *  errors (returns false) so app-runner startup never fails over the debug flag. */
async function isTaskDebugMode(taskId: string): Promise<boolean> {
  try {
    const task = await getDb().query.tasks.findFirst({
      where: eq(schema.tasks.id, taskId),
      columns: { debugMode: true },
    });
    return task?.debugMode === true;
  } catch {
    return false;
  }
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

/** If the app-runner's headed-browser desktop is up, return the http://<ip>:9223 URL
 *  chrome-devtools connects to so the agent drives the SAME visible browser the user
 *  watches; else null. IP not DNS name (see browserCdpUrlForRunner). Mirrors
 *  runnerBrowserCdpUrl (ddev-runner) for the non-DDEV app-runner. */
export async function appRunnerBrowserCdpUrl(taskId: string): Promise<string | null> {
  return browserCdpUrlForRunner(appRunnerName(taskId));
}

/** The user-facing URL(s) for opening this task's app in their OWN browser: the
 *  loopback host port Docker published for the app port, as http://localhost:<H>.
 *  Reads the live mapping from Docker (the source of truth for the actual host
 *  port). Empty when nothing is published — direct access disabled at runner
 *  start, or the app port is unknown. */
export async function appRunnerAccessUrls(
  taskId: string,
  appPort: number | null,
): Promise<TaskAccessEndpoint[]> {
  if (!appPort) return [];
  try {
    const { stdout } = await exec('docker', ['port', appRunnerName(taskId), `${appPort}/tcp`], {
      timeout: 10_000,
    });
    const hostPort = parsePublishedPort(stdout);
    if (!hostPort) return [];
    return [{ kind: 'localhost', label: 'Localhost', url: `http://localhost:${hostPort}` }];
  } catch {
    return [];
  }
}

/** Parse `docker port` output (e.g. `127.0.0.1:49215`, possibly multi-line for
 *  v4/v6) down to the host port number, or null. */
export function parsePublishedPort(dockerPortStdout: string): number | null {
  const line = dockerPortStdout
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  const m = line.match(/:(\d+)\s*$/);
  return m ? Number(m[1]) : null;
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
  await exec('docker', ['rm', '-f', '-v', ...ids], { timeout: 60_000 }).catch(() => {});
  return ids.length;
}
