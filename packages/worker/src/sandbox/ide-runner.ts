import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  CODE_SERVER_IMAGE,
  IDE_INTERNAL_PORT,
  IDE_RUNNER_LABEL,
  appRunnerName,
  ddevRunnerName,
  ideExtensionsVolumeName,
  ideRunnerName,
  ideUserDataVolumeName,
  logger,
} from '@haive/shared';
import { resolveDdevWorkspace } from '../step-engine/steps/workflow/_task-meta.js';
import { defaultDockerRunner, type DockerVolumeMount } from './docker-runner.js';

// Per-task browser IDE: a code-server container serving the task's worktree as its
// ONLY workspace folder. It mirrors the app-runner's lifecycle (long-lived
// container, NIC on the sandbox network so the api proxies it by DNS name) but is
// lazily launched when the user opens the Editor tab and reaped after a grace once
// the tab closes. The repo volume is mounted by SUBPATH = the worktree, so the
// root checkout and sibling worktrees are physically absent inside the editor —
// the rooting guarantee. code-server runs `--auth none`, reachable only on the
// internal network; the api proxy is the auth boundary.

const exec = promisify(execFile);
const log = logger.child({ module: 'ide-runner' });

const REPO_VOLUME = 'haive_repos';
const HOST_REPO_ROOT = process.env.HOST_REPO_ROOT ?? '/host-fs';
// code-server (codercom image) runs as uid:gid 1000:1000 — the same `node` user
// the repo volume is already chowned to for the CLI sandbox.
const IDE_UID = '1000:1000';
// Reuse the CLI sandbox image as the throwaway chown/seed helper (it has bash +
// coreutils), exactly as task-auth-volume does.
const HELPER_IMAGE = process.env.SANDBOX_IMAGE ?? 'haive-cli-sandbox:latest';
const HELPER_TIMEOUT_MS = 60_000;

export interface IdeRunnerHandle {
  /** The IDE container name. */
  container: string;
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

/** Resolve the volume-relative subpath the IDE must open as its (only) workspace
 *  folder: the task's git worktree when one exists, else the repo root. Returns
 *  null when the task has no editable volume-backed repo — read-only local-path
 *  repos (bound from /host-fs) are out of scope for the writable editor in v1, and
 *  the caller surfaces that to the web. Reuses resolveDdevWorkspace, the same
 *  resolver the DDEV/app runtimes use to target the worktree. */
export async function resolveIdeWorkspaceSubpath(
  db: Database,
  taskId: string,
): Promise<string | null> {
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { repositoryId: true },
  });
  if (!task?.repositoryId) return null;
  const repo = await db.query.repositories.findFirst({
    where: eq(schema.repositories.id, task.repositoryId),
    columns: { storagePath: true, localPath: true },
  });
  const repoPath = repo?.storagePath ?? repo?.localPath ?? null;
  if (!repoPath) return null;
  // Local-path repos resolve under the host bind root and are mounted read-only
  // end to end — no writable editor for them in v1.
  if (repoPath.startsWith(HOST_REPO_ROOT + '/')) return null;
  const ws = await resolveDdevWorkspace(db, taskId, repoPath);
  return ws?.repoSubpath ?? null;
}

/** Create (if missing) and chown the IDE's two writable volumes, and seed the
 *  user-data volume's global settings.json. The extensions volume is per-USER
 *  (install once, reused across every task); the user-data volume is per-TASK
 *  (settings + workbench state + hot-exit backups) and persists across the
 *  idle-grace container reap so reopening never loses unsaved work. Docker creates
 *  volume mountpoints root-owned, so a throwaway helper chowns them to the
 *  code-server uid before the editor can write. Idempotent. */
export async function ensureIdeVolumes(
  taskId: string,
  userId: string,
  settingsJson: string,
): Promise<{ extVolume: string; udataVolume: string }> {
  const extVolume = ideExtensionsVolumeName(userId);
  const udataVolume = ideUserDataVolumeName(taskId);

  for (const v of [extVolume, udataVolume]) {
    if (!(await defaultDockerRunner.volumeExists(v))) {
      const created = await defaultDockerRunner.volumeCreate(v);
      if (!created.ok) {
        throw new Error(`Failed to create IDE volume ${v}: ${created.stderr || 'unknown error'}`);
      }
    }
  }

  // One helper run: chown both mounts and write the seeded settings into the
  // user-data volume. settings.json is overwritten on every launch — the DB is the
  // source of truth for a user's global IDE settings (the settings page edits it).
  const mounts: DockerVolumeMount[] = [
    { source: extVolume, target: '/ext', readOnly: false },
    { source: udataVolume, target: '/udata', readOnly: false },
  ];
  const seedScript =
    'mkdir -p /udata/User && printf %s "$IDE_SETTINGS" > /udata/User/settings.json && ' +
    `chown -R ${IDE_UID} /ext /udata`;
  const result = await defaultDockerRunner.run({
    image: HELPER_IMAGE,
    cmd: ['bash', '-c', seedScript],
    mounts,
    entrypoint: '',
    user: 'root',
    env: { IDE_SETTINGS: settingsJson },
    timeoutMs: HELPER_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `IDE volume prep failed for task ${taskId} (exit ${result.exitCode ?? 'unknown'}): ${result.stderr.slice(-500)}`,
    );
  }

  return { extVolume, udataVolume };
}

/** Launch a per-task code-server container: the worktree subpath mounted WRITABLE
 *  at /workspace (its only folder), the per-user extensions volume at /ext, and the
 *  per-task user-data volume at /udata. Binds 0.0.0.0:8080 with auth disabled
 *  (the api proxy authenticates); joins the sandbox network so the api reaches it
 *  by DNS name. Drops any stale container first. */
export async function startIdeRunner(params: {
  taskId: string;
  workspaceSubpath: string;
  extVolume: string;
  udataVolume: string;
}): Promise<IdeRunnerHandle> {
  const name = ideRunnerName(params.taskId);
  await exec('docker', ['rm', '-f', '-v', name], { timeout: 30_000 }).catch(() => {});

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
      `${IDE_RUNNER_LABEL}=1`,
      '--mount',
      `type=volume,source=${REPO_VOLUME},destination=/workspace,volume-subpath=${params.workspaceSubpath}`,
      '-v',
      `${params.extVolume}:/ext`,
      '-v',
      `${params.udataVolume}:/udata`,
      CODE_SERVER_IMAGE,
      '--auth',
      'none',
      '--bind-addr',
      `0.0.0.0:${IDE_INTERNAL_PORT}`,
      '--extensions-dir',
      '/ext',
      '--user-data-dir',
      '/udata',
      '--disable-telemetry',
      '--disable-update-check',
      '/workspace',
    ],
    { timeout: 120_000 },
  );

  const sandboxNetwork = process.env.SANDBOX_NETWORK;
  if (sandboxNetwork) {
    await exec('docker', ['network', 'connect', sandboxNetwork, name], { timeout: 15_000 }).catch(
      (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/already exists in network/.test(msg)) {
          log.warn({ err: msg, name, sandboxNetwork }, 'ide runner network connect failed');
        }
      },
    );
  }

  log.info({ taskId: params.taskId, container: name }, 'ide runner started');
  return { container: name };
}

/** Best-effort wait until code-server answers its /healthz endpoint, so the api's
 *  first proxied request lands on a live server. Swallows probe failures (the image
 *  may lack curl/wget) — readiness is advisory; the web retries the iframe anyway. */
async function waitForIdeReady(name: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const probe = `curl -fsS http://localhost:${IDE_INTERNAL_PORT}/healthz 2>/dev/null || wget -qO- http://localhost:${IDE_INTERNAL_PORT}/healthz 2>/dev/null || true`;
  do {
    const out = await exec('docker', ['exec', name, 'sh', '-c', probe], { timeout: 8_000 })
      .then((o) => o.stdout)
      .catch(() => '');
    // /healthz returns {"status":"alive"|"expired"}; either means the HTTP server
    // is up (it reads "expired" until a client connects). Match the field, not the
    // value — keying on "alive" would never fire before the first editor connects.
    if (out.includes('"status"')) return true;
    if (Date.now() >= deadline) break;
    await new Promise((res) => setTimeout(res, 1000));
  } while (Date.now() < deadline);
  return false;
}

/** Ensure the task's IDE container is up, launching it (and its volumes) if not.
 *  Idempotent and coalesced: concurrent opens of the same task share one boot.
 *  Returns null when the task has no editable repo (caller surfaces "unavailable").
 *  A stopped/stale container is removed and recreated; the per-task user-data volume
 *  survives a recreate so unsaved work is restored. */
const inFlightIdeBoots = new Map<string, Promise<IdeRunnerHandle | null>>();

export async function ensureIdeRunnerStarted(
  db: Database,
  taskId: string,
  userId: string,
  settingsJson: string,
): Promise<IdeRunnerHandle | null> {
  const inFlight = inFlightIdeBoots.get(taskId);
  if (inFlight) return inFlight;
  const boot = ensureIdeRunnerStartedInner(db, taskId, userId, settingsJson);
  inFlightIdeBoots.set(taskId, boot);
  try {
    return await boot;
  } finally {
    inFlightIdeBoots.delete(taskId);
  }
}

async function ensureIdeRunnerStartedInner(
  db: Database,
  taskId: string,
  userId: string,
  settingsJson: string,
): Promise<IdeRunnerHandle | null> {
  const workspaceSubpath = await resolveIdeWorkspaceSubpath(db, taskId);
  if (!workspaceSubpath) return null;

  const name = ideRunnerName(taskId);
  if (await isRunning(name)) {
    return { container: name };
  }
  if (await containerExists(name)) {
    await exec('docker', ['rm', '-f', '-v', name], { timeout: 30_000 }).catch(() => {});
  }

  const { extVolume, udataVolume } = await ensureIdeVolumes(taskId, userId, settingsJson);
  const handle = await startIdeRunner({ taskId, workspaceSubpath, extVolume, udataVolume });
  await waitForIdeReady(name, 15_000);
  await setupIdeDebugging(db, taskId, name);
  return handle;
}

// code-server bundles its own Node (not on PATH); used to run the in-container TCP
// forwarders since the image has no socat.
const IDE_BUNDLED_NODE = '/usr/lib/code-server/lib/node';
// 9003 (Xdebug) is forwarded runner->ide (see ddev-runner); only these two are
// forwarded ide->runner so the launch configs can use localhost.
const IDE_CDP_PORT = 9223; // browser CDP (Lane B)
const IDE_NODE_INSPECT_PORT = 9229; // node --inspect (Lane C)

/** When the task opted into debug mode, prepare the Editor tab for step-debugging:
 *  install the PHP/Xdebug debugger from Open VSX (the built-in js-debug already
 *  covers the JS/Node lanes), and stand up the IDE-side TCP forwards so the seeded
 *  launch configs can use stable `localhost` addresses. No-op when debug is off. */
async function setupIdeDebugging(db: Database, taskId: string, name: string): Promise<void> {
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { debugMode: true },
  });
  if (!task?.debugMode) return;
  await installXdebugExtension(taskId, name);
  await setupIdeDebugForwards(taskId, name);
}

/** Install xdebug.php-debug into the per-user /ext volume (Open VSX is code-server's
 *  default registry). Idempotent (--force); /ext persists per user so this is a fast
 *  no-op after the first debug task. Best-effort. */
async function installXdebugExtension(taskId: string, name: string): Promise<void> {
  try {
    await exec(
      'docker',
      [
        'exec',
        name,
        'code-server',
        '--install-extension',
        'xdebug.php-debug',
        '--extensions-dir',
        '/ext',
        '--force',
      ],
      { timeout: 120_000 },
    );
    log.info({ taskId, container: name }, 'installed xdebug.php-debug for debug-mode task');
  } catch (err) {
    log.warn(
      { taskId, err: err instanceof Error ? err.message : String(err) },
      'php-debug extension install failed (PHP step-debug unavailable until installed)',
    );
  }
}

/** Forward the IDE container's localhost CDP (9223) + node-inspect (9229) ports to
 *  the task's runtime runner, so js-debug "Attach to Chrome"/"Attach to Node" can
 *  target a stable `localhost` instead of the runner's dynamic IP (and avoid Chrome's
 *  Host-header rejection of a DNS-name target). The target is whichever per-task
 *  runner exists — the DDEV DinD runner or the app-runner — both of which host the
 *  CDP browser at :9223 and (under debug) expose node at :9229. Resolved by docker
 *  DNS name PER CONNECTION, so it survives a runner recreate. When no runner exists
 *  yet (Editor opened before the runtime is up) the forwards are skipped; reopening
 *  the Editor after the runtime is up re-establishes them. Best-effort. */
async function setupIdeDebugForwards(taskId: string, name: string): Promise<void> {
  const ddevRunner = ddevRunnerName(taskId);
  const appRunner = appRunnerName(taskId);
  const target = (await containerExists(ddevRunner))
    ? ddevRunner
    : (await containerExists(appRunner))
      ? appRunner
      : null;
  if (!target) {
    log.info({ taskId }, 'ide debug forwards skipped — no runtime runner up yet (reopen later)');
    return;
  }
  await startIdeForward(name, IDE_CDP_PORT, target, IDE_CDP_PORT);
  await startIdeForward(name, IDE_NODE_INSPECT_PORT, target, IDE_NODE_INSPECT_PORT);
}

/** Start a detached TCP forwarder inside the IDE container: 127.0.0.1:<localPort>
 *  -> <targetHost>:<targetPort>, using code-server's bundled Node (the image has no
 *  socat). The target host is re-resolved per connection (createServer -> connect),
 *  so a runner recreate (same DNS name, new IP) keeps working. Idempotent: a second
 *  instance exits cleanly when the listen port is already bound. Best-effort. */
async function startIdeForward(
  ideName: string,
  localPort: number,
  targetHost: string,
  targetPort: number,
): Promise<void> {
  const code =
    `const net=require('net');` +
    `const s=net.createServer(c=>{const u=net.connect(${targetPort},'${targetHost}');` +
    `c.on('error',()=>u.destroy());u.on('error',()=>c.destroy());c.pipe(u);u.pipe(c);});` +
    `s.on('error',()=>process.exit(0));s.listen(${localPort},'127.0.0.1');`;
  await exec('docker', ['exec', '-d', ideName, IDE_BUNDLED_NODE, '-e', code], {
    timeout: 15_000,
  }).catch((err) => {
    log.warn(
      { ideName, localPort, targetHost, err: err instanceof Error ? err.message : String(err) },
      'ide debug forward start failed',
    );
  });
}

/** Gracefully stop the task's IDE container (SIGTERM via `docker stop`, giving
 *  code-server time to flush hot-exit backups) and remove it. The per-user
 *  extensions and per-task user-data volumes are intentionally left intact, so a
 *  later reopen restores extensions, settings, and unsaved buffers. Used by the
 *  idle-grace reaper. Returns true when a container was stopped. */
export async function stopIdeRunner(taskId: string): Promise<boolean> {
  const name = ideRunnerName(taskId);
  if (!(await containerExists(name))) return false;
  await exec('docker', ['stop', '--time', '10', name], { timeout: 30_000 }).catch(() => {});
  await exec('docker', ['rm', '-f', '-v', name], { timeout: 30_000 }).catch(() => {});
  log.info({ taskId, container: name }, 'ide runner stopped (idle grace)');
  return true;
}

/** Tear down every IDE container for a task AND remove its per-task user-data
 *  volume — called at task end. The per-USER extensions volume is preserved
 *  (shared across the user's other tasks). Returns the number of containers
 *  removed. */
export async function killTaskIdeContainers(taskId: string): Promise<number> {
  let ids: string[] = [];
  try {
    const { stdout } = await exec(
      'docker',
      [
        'ps',
        '-aq',
        '--filter',
        `label=${IDE_RUNNER_LABEL}=1`,
        '--filter',
        `label=haive.task.id=${taskId}`,
      ],
      { timeout: 15_000 },
    );
    ids = stdout.split(/\s+/).filter((s) => s.length > 0);
  } catch {
    ids = [];
  }
  if (ids.length > 0) {
    await exec('docker', ['rm', '-f', '-v', ...ids], { timeout: 60_000 }).catch(() => {});
  }
  // Drop the per-task user-data volume (the per-user extensions volume stays).
  await defaultDockerRunner.volumeRemove(ideUserDataVolumeName(taskId)).catch(() => undefined);
  return ids.length;
}
