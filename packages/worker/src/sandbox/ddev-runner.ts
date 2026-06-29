import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  ddevRunnerName,
  logger,
  CONFIG_KEYS,
  configService,
  taskHostPort,
  type TaskAccessEndpoint,
} from '@haive/shared';
import { browserCdpUrlForRunner } from './runner-browser-cdp.js';

// Per-task DDEV environment via nested Docker (DinD). DDEV can't run against the
// shared host daemon here (repos live in the haive_repos NAMED VOLUME, which the
// host daemon can't bind-mount), so each task gets its own privileged DinD
// container: DDEV talks to THAT container's nested dockerd, where the repo is a
// real local path (mounted via the named volume). See packages/worker/docker/
// ddev-runner for the image. Validated end-to-end (ddev start + import-db).

const exec = promisify(execFile);
const log = logger.child({ module: 'ddev-runner' });

const REPO_VOLUME = 'haive_repos';

/** Worker-side root of the haive_repos volume (same mount the runner sees at
 *  /repos). Used to write the per-task xdebug ini straight into the worktree. */
const XDEBUG_REPO_STORAGE_ROOT = process.env.REPO_STORAGE_ROOT ?? '/var/lib/haive/repos';

/** Xdebug 3 DBGp port the IDE's php-debug listener binds and the runner forwards. */
const XDEBUG_PORT = 9003;

/** Node --inspect port forwarded runner->web for debugging Node under DDEV (Lane C1). */
const XDEBUG_NODE_PORT = 9229;

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
  const [dockerfile, entrypoint, browserCheck, probeConnect, desktopSh] = await Promise.all([
    readFile(path.join(dir, 'Dockerfile'), 'utf8'),
    readFile(path.join(dir, 'entrypoint.sh'), 'utf8'),
    readFile(path.join(dir, 'browser-check.js'), 'utf8'),
    readFile(path.join(dir, 'browser-probe-connect.js'), 'utf8'),
    readFile(path.join(dir, 'start-browser-desktop.sh'), 'utf8'),
  ]);
  const hash = createHash('sha256')
    .update(dockerfile)
    .update('\0')
    .update(entrypoint)
    .update('\0')
    .update(browserCheck)
    .update('\0')
    .update(probeConnect)
    .update('\0')
    .update(desktopSh)
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
  await pruneOldRunnerImages(tag);
  return tag;
}

/** Remove superseded haive-ddev-runner:<hash> image tags, keeping the current one.
 *  The tag is a content hash of the build context, so old tags are dead weight
 *  (~2GB each) once the context changes. Best-effort — a tag still referenced by a
 *  stopped container is logged and skipped. */
async function pruneOldRunnerImages(currentTag: string): Promise<void> {
  try {
    const { stdout } = await exec(
      'docker',
      ['images', 'haive-ddev-runner', '--format', '{{.Repository}}:{{.Tag}}'],
      { timeout: 15_000 },
    );
    const stale = stdout
      .split(/\s+/)
      .filter((t) => t.length > 0 && t !== currentTag && t.startsWith('haive-ddev-runner:'));
    for (const t of stale) {
      await exec('docker', ['image', 'rm', '-f', t], { timeout: 30_000 }).catch((err) => {
        log.warn(
          { tag: t, err: err instanceof Error ? err.message : String(err) },
          'prune stale runner image failed',
        );
      });
    }
    if (stale.length > 0) log.info({ removed: stale.length }, 'pruned stale runner images');
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'runner image prune failed',
    );
  }
}

function runnerName(taskId: string): string {
  // Shared with the api (it dials the runner by this DNS name for the VNC bridge).
  return ddevRunnerName(taskId);
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
  // Drop any stale runner from a prior attempt (with its anon volume). A DinD
  // runner's teardown (nested dockerd + the anon /var/lib/docker volume) can be
  // slow; if the rm overruns its timeout the `docker run` below hits a name
  // conflict. So give the rm room AND retry the run once after a forced removal,
  // instead of failing the boot — this conflict was the recurring VNC "Connection
  // closed (1006)" surfacing through the runtime-ensure job.
  // Direct browser access (default on): publish the DDEV router ports to MATCHING
  // loopback host ports (host port == container port == router port) so the app's
  // own canonical URLs/redirects carry the right port instead of bouncing to a
  // portless, unpublished :443. Deterministic per task (stable URL across
  // restarts); on a host-port collision bump to the next candidate. The chosen
  // ports are stamped as labels (read back by ddevAccessUrls) and the runner's
  // router is pointed at them below. Flag OFF => no -p, the pre-feature behavior.
  const directAccess = await configService.getBoolean(CONFIG_KEYS.BROWSER_DIRECT_ACCESS, true);
  const caMount = ddevCaMountArgs();
  const buildRunArgs = (attempt: number): { args: string[]; ports: DdevPublishedPorts | null } => {
    let publish: string[] = [];
    let ports: DdevPublishedPorts | null = null;
    if (directAccess) {
      const https = taskHostPort(params.taskId, 0, attempt);
      const http = taskHostPort(params.taskId, 1, attempt);
      ports = { https, http };
      publish = [
        '-p',
        `127.0.0.1:${https}:${https}`,
        '-p',
        `127.0.0.1:${http}:${http}`,
        '--label',
        `${DDEV_HTTPS_PORT_LABEL}=${https}`,
        '--label',
        `${DDEV_HTTP_PORT_LABEL}=${http}`,
      ];
    }
    return {
      ports,
      args: [
        'run',
        '-d',
        '--privileged',
        '--name',
        name,
        '--label',
        `haive.task.id=${params.taskId}`,
        '--label',
        'haive.ddev=1',
        ...publish,
        ...caMount,
        '-v',
        `${REPO_VOLUME}:/repos`,
        tag,
      ],
    };
  };

  await exec('docker', ['rm', '-f', '-v', name], { timeout: 90_000 }).catch(() => {});
  let chosenPorts: DdevPublishedPorts | null = null;
  let started = false;
  const maxAttempts = directAccess ? 5 : 1;
  for (let attempt = 0; attempt < maxAttempts && !started; attempt++) {
    const { args, ports } = buildRunArgs(attempt);
    try {
      await exec('docker', args, { timeout: 60_000 });
      chosenPorts = ports;
      started = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Name conflict: a stale runner survived the rm timeout — force-remove and
      // retry the SAME ports once.
      if (/already in use/i.test(msg)) {
        await exec('docker', ['rm', '-f', '-v', name], { timeout: 90_000 }).catch(() => {});
        try {
          await exec('docker', args, { timeout: 60_000 });
          chosenPorts = ports;
          started = true;
        } catch (err2) {
          const msg2 = err2 instanceof Error ? err2.message : String(err2);
          if (directAccess && isHostPortCollision(msg2)) continue; // bump ports, retry
          throw err2;
        }
        continue;
      }
      // Host-port collision: the deterministic port is taken — bump and retry.
      if (directAccess && isHostPortCollision(msg)) continue;
      throw err;
    }
  }
  if (!started) {
    throw new Error('ddev runner failed to start (host-port allocation exhausted)');
  }

  // Second NIC on the internal sandbox network (same one sandboxes + the api
  // join), so the api's VNC bridge and sandboxed CLIs reach the runner by DNS
  // name. The default bridge stays primary — the runner needs internet for
  // nested-daemon image pulls and the sandbox network is internal-only.
  const sandboxNetwork = process.env.SANDBOX_NETWORK;
  if (sandboxNetwork) {
    await exec('docker', ['network', 'connect', sandboxNetwork, name], { timeout: 15_000 }).catch(
      (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/already exists in network/.test(msg)) {
          log.warn({ err: msg, name, sandboxNetwork }, 'ddev runner network connect failed');
        }
      },
    );
  }

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

  // Point DDEV's router at the SAME ports we published, so the cold-boot `ddev
  // start` brings the router up on them and primary_url / canonical redirects
  // carry the published port. AND bind the router on all interfaces inside the
  // runner: by default DDEV's nested router publishes on the runner's loopback
  // only (127.0.0.1), but our host `-p 127.0.0.1:P:P` forwards to the runner's
  // bridge IP, so without bind-all the host publish reaches nothing (connection
  // reset). This config runs BEFORE the first `ddev start`, so the router is
  // created with the right binding (no recreate needed). Global config =
  // per-runner here (one project per runner). Best-effort: a failure only
  // degrades the direct-access ddev.site URL, so warn rather than fail the whole
  // boot (VNC + in-container access still work).
  if (directAccess && chosenPorts) {
    await exec(
      'docker',
      [
        'exec',
        '-u',
        'ddev',
        name,
        'bash',
        '-lc',
        `ddev config global --router-https-port=${chosenPorts.https} --router-http-port=${chosenPorts.http} --router-bind-all-interfaces=true`,
      ],
      { timeout: 30_000 },
    ).catch((err) => {
      log.warn(
        { name, err: err instanceof Error ? err.message : String(err) },
        'ddev router-port config failed; direct-access ddev.site URL may not work',
      );
    });
  }
  log.info({ taskId: params.taskId, container: name }, 'ddev runner started');
  return { container: name, projectDir: `/repos/${params.repoSubpath}` };
}

// --- Direct browser access (DDEV) ---------------------------------------------

/** Docker labels stamping a DDEV runner's published https/http host ports (the
 *  actual post-retry values), read back by ddevAccessUrls so the surfaced URLs are
 *  correct even when a host-port collision bumped the deterministic candidate. */
const DDEV_HTTPS_PORT_LABEL = 'haive.ddev.httpsport';
const DDEV_HTTP_PORT_LABEL = 'haive.ddev.httpport';

interface DdevPublishedPorts {
  https: number;
  http: number;
}

/** True when a `docker run` error means the requested host port is already taken. */
export function isHostPortCollision(msg: string): boolean {
  return /port is already allocated|address already in use|bind for .* failed|ports are not available/i.test(
    msg,
  );
}

/** Shared mkcert CA volume (generated once on worker boot) mounted RO into every
 *  runner so all per-task DDEV certs share ONE CA the user trusts once, instead of
 *  a per-runner throwaway. The api also mounts it (read-only) to serve rootCA.pem. */
const DDEV_CA_VOLUME = process.env.DDEV_CA_VOLUME || 'haive_ddev_ca';
const DDEV_CA_MOUNT_PATH = '/home/ddev/.local/share/mkcert';
let ddevCaReady = false;

/** Mount args for the shared CA, but only once worker boot has generated it; else
 *  empty so the runner's entrypoint mints a per-runner throwaway CA (https still
 *  works, just untrusted until the user clicks through). */
function ddevCaMountArgs(): string[] {
  return ddevCaReady ? ['-v', `${DDEV_CA_VOLUME}:${DDEV_CA_MOUNT_PATH}`] : [];
}

/** Generate the shared mkcert CA into its named volume once (idempotent). Runs on
 *  worker boot. The CA files are chowned to uid 1000 so the runner's `ddev` user
 *  can read the signing key. Best-effort: on failure ddevCaReady stays false and
 *  runners fall back to per-runner throwaway CAs. */
export async function ensureDdevCa(): Promise<void> {
  if (ddevCaReady) return;
  const tag = await ensureDdevRunnerImage();
  await exec('docker', ['volume', 'create', DDEV_CA_VOLUME], { timeout: 15_000 }).catch(() => {});
  await exec(
    'docker',
    [
      'run',
      '--rm',
      '-v',
      `${DDEV_CA_VOLUME}:/caroot`,
      '--entrypoint',
      'bash',
      tag,
      '-lc',
      'CAROOT=/caroot mkcert -install >/dev/null 2>&1 || true; chown -R 1000:1000 /caroot; test -f /caroot/rootCA.pem',
    ],
    { timeout: 90_000 },
  );
  ddevCaReady = true;
  log.info({ volume: DDEV_CA_VOLUME }, 'shared DDEV CA ready');
}

/** The user-facing URLs for opening this task's DDEV app in their OWN browser: the
 *  project's *.ddev.site name on its published https/http ports (the only form that
 *  routes for DDEV apps that hard-code their hostname) plus a localhost fallback.
 *  Ports come from the runner's labels (the real post-retry values); the hostname
 *  from the live primary_url. Empty when nothing was published (direct access off
 *  at runner start). */
export async function ddevAccessUrls(
  handle: DdevRunnerHandle,
  taskId: string,
): Promise<TaskAccessEndpoint[]> {
  const ports = await readDdevPublishedPorts(ddevRunnerName(taskId));
  if (!ports) return [];
  const primary = await ddevPrimaryUrl(handle);
  let host: string | null = null;
  try {
    if (primary) host = new URL(primary).hostname;
  } catch {
    host = null;
  }
  if (!host) return [];
  return [
    {
      kind: 'ddev-https',
      label: 'DDEV (HTTPS)',
      url: `https://${host}:${ports.https}`,
      trusted: ddevCaReady,
    },
    { kind: 'ddev-http', label: 'DDEV (HTTP)', url: `http://${host}:${ports.http}` },
    { kind: 'localhost', label: 'Localhost', url: `http://localhost:${ports.http}` },
  ];
}

/** Read a DDEV runner's published host ports from its labels, or null when direct
 *  access was off at start (no labels stamped). */
async function readDdevPublishedPorts(name: string): Promise<DdevPublishedPorts | null> {
  try {
    const { stdout } = await exec(
      'docker',
      [
        'inspect',
        '-f',
        `{{index .Config.Labels "${DDEV_HTTPS_PORT_LABEL}"}},{{index .Config.Labels "${DDEV_HTTP_PORT_LABEL}"}}`,
        name,
      ],
      { timeout: 8_000 },
    );
    const [hs, ht] = stdout.trim().split(',');
    const https = Number(hs);
    const http = Number(ht);
    if (!Number.isFinite(https) || !Number.isFinite(http) || !https || !http) return null;
    return { https, http };
  } catch {
    return null;
  }
}

/** Run a ddev subcommand inside the runner as the non-root `ddev` user, in the
 *  project dir. Returns combined output + an exit code (0 on success). */
export async function ddevExec(
  handle: DdevRunnerHandle,
  ddevArgs: string,
  opts: { timeoutMs?: number; onLine?: (line: string) => void } = {},
): Promise<{ exitCode: number; output: string }> {
  // Live progress requested: stream line-by-line rather than buffering (the
  // buffered path below returns nothing until a multi-minute op completes).
  if (opts.onLine)
    return ddevExecStreaming(handle, ddevArgs, opts.onLine, opts.timeoutMs ?? 600_000);
  const cmd = `cd ${handle.projectDir} && ddev ${ddevArgs}`;
  try {
    const { stdout, stderr } = await exec(
      'docker',
      ['exec', '-u', 'ddev', handle.container, 'bash', '-lc', cmd],
      { timeout: opts.timeoutMs ?? 600_000, maxBuffer: 10 * 1024 * 1024 },
    );
    // Keep the TAIL: ddev's result/error lands at the END, after verbose
    // image-pull progress. Slicing the head drops the actual failure line (e.g.
    // a `ddev start` container-readiness timeout), leaving only pull noise.
    return { exitCode: 0, output: `${stdout}${stderr}`.slice(-8000) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { exitCode: e.code ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}`.slice(-8000) };
  }
}

/** The DDEV project's primary URL, via `ddev describe -j` inside the runner.
 *  Null when the project isn't running or the output can't be parsed. */
export async function ddevPrimaryUrl(handle: DdevRunnerHandle): Promise<string | null> {
  const res = await ddevExec(handle, 'describe -j', { timeoutMs: 30_000 });
  if (res.exitCode !== 0) return null;
  const start = res.output.indexOf('{');
  const end = res.output.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(res.output.slice(start, end + 1)) as {
      raw?: { primary_url?: string };
    };
    return parsed.raw?.primary_url ?? null;
  } catch {
    return null;
  }
}

/** Parse DDEV's registry file (`~/.ddev/project_list.yaml`) for the project name registered
 *  at `approot`, or null. The registry is the source DDEV checks for the "already contains a
 *  project named <name>" conflict, and crucially it retains the name the approot was STARTED
 *  under even after `.ddev/config.yaml` is renamed (`ddev list` instead reports the new
 *  config name, hiding the drift). Flat format, regex-parsed (the worker carries no YAML dep,
 *  matching _ddev-config.ts):
 *      <name>:
 *          approot: <path>
 */
export function parseDdevProjectListForApproot(yamlText: string, approot: string): string | null {
  let currentName: string | null = null;
  for (const line of yamlText.split('\n')) {
    const top = line.match(/^([A-Za-z0-9][^:\s]*):\s*$/);
    if (top) {
      currentName = top[1] ?? null;
      continue;
    }
    const ap = line.match(/^\s+approot:\s*"?([^"\n]+?)"?\s*$/);
    if (ap && currentName && (ap[1] ?? '').trim() === approot) return currentName;
  }
  return null;
}

/** The DDEV project name currently REGISTERED for this runner's approot, read from the
 *  per-runner registry (`~/.ddev/project_list.yaml`), or null when none is registered there.
 *  07c uses it to detect a project rename: when the config `name:` no longer matches this, a
 *  bare `ddev restart` would collide ("already contains a project named <old>") and a
 *  data-safe rename is needed instead. NOTE: read the registry, NOT `ddev list` — list
 *  reports each project's CURRENT config name, so after a rename it already shows the NEW
 *  name and the drift is invisible. */
export async function ddevRegisteredProjectName(handle: DdevRunnerHandle): Promise<string | null> {
  const res = await runnerExec(handle, 'cat "$HOME/.ddev/project_list.yaml" 2>/dev/null || true', {
    timeoutMs: 15_000,
  });
  if (res.exitCode !== 0) return null;
  return parseDdevProjectListForApproot(res.output, handle.projectDir);
}

/** `ddev restart` — re-reads `.ddev/config.yaml` and applies changes (php_version,
 *  webserver, docroot, …) to the already-running project. Idempotent; the db data
 *  volume is preserved when the db version is unchanged. Long timeout because a
 *  new php_version pulls a fresh web image. */
export async function ddevRestart(
  handle: DdevRunnerHandle,
  opts: { onLine?: (line: string) => void } = {},
): Promise<{ exitCode: number; output: string }> {
  return ddevExec(handle, 'restart', { timeoutMs: 900_000, onLine: opts.onLine });
}

/** `ddev snapshot --name=<name>` — db backup taken before a destructive migrate.
 *  Restore with `ddev snapshot restore <name>`. */
export async function ddevSnapshot(
  handle: DdevRunnerHandle,
  name: string,
  opts: { onLine?: (line: string) => void } = {},
): Promise<{ exitCode: number; output: string }> {
  return ddevExec(handle, `snapshot --name=${name}`, { timeoutMs: 600_000, onLine: opts.onLine });
}

/** `ddev snapshot restore <name>` — repopulate the DB from a snapshot. Long
 *  timeout for large dumps. */
export async function ddevSnapshotRestore(
  handle: DdevRunnerHandle,
  name: string,
): Promise<{ exitCode: number; output: string }> {
  return ddevExec(handle, `snapshot restore ${name}`, { timeoutMs: 1_800_000 });
}

/** Data-safe DDEV project rename, for when the implementation changed `.ddev/config.yaml`
 *  `name:` AFTER the project was registered+started under the old name (a bare `ddev restart`
 *  then fails: "already contains a project named <old>"). A rename gives the new name a FRESH
 *  db volume (volumes are per-project), so the DB is snapshotted first and restored after:
 *  snapshot -> `ddev stop --unlist <old>` (non-destructive; drops the registration, keeps the
 *  old volume, which the per-task DinD runner discards at task end) -> `ddev start` (registers
 *  the new name from config) -> `ddev snapshot restore`. Snapshot/restore are no-ops when the
 *  env has no DB (a freshly-generated env with no import). Returns the `ddev start` result —
 *  exitCode 0 means the rename took effect. */
export async function ddevSafeRename(
  handle: DdevRunnerHandle,
  oldName: string,
  snapshotName: string,
  opts: { onLine?: (line: string) => void } = {},
): Promise<{ exitCode: number; output: string }> {
  const snap = await ddevSnapshot(handle, snapshotName);
  const hadSnapshot = snap.exitCode === 0;
  if (!hadSnapshot) {
    log.info(
      { oldName, output: snap.output.slice(-300) },
      'ddev pre-rename snapshot non-zero (empty DB?) — continuing',
    );
  }
  const stop = await ddevExec(handle, `stop --unlist ${oldName}`, { timeoutMs: 120_000 });
  if (stop.exitCode !== 0) {
    log.warn(
      { oldName, output: stop.output.slice(-300) },
      'ddev stop --unlist non-zero (continuing to start under the new name)',
    );
  }
  const start = await ddevExec(handle, 'start', { timeoutMs: 900_000, onLine: opts.onLine });
  if (start.exitCode !== 0) return start;
  if (hadSnapshot) {
    const restore = await ddevSnapshotRestore(handle, snapshotName);
    if (restore.exitCode !== 0) {
      log.warn(
        { snapshotName, output: restore.output.slice(-300) },
        'ddev snapshot restore after rename non-zero',
      );
    }
  }
  return start;
}

// Deterministic durability-snapshot names. They live in `.ddev/.snapshots/` under
// the project (on the haive_repos NAMED VOLUME), so they survive the worker-boot
// reaper's `docker rm` of the runner, a Docker daemon restart, and a host reboot —
// none of which the runner's own nested-Docker DB volume survives. The cold-boot
// path in ensureDdevStarted restores the most recent of these so verify/browser
// testing runs against a populated DB instead of an empty one.
export function ddevImportSnapshotName(taskId: string): string {
  return `haive-import-${taskId}`;
}
export function ddevMigratedSnapshotName(taskId: string): string {
  return `haive-migrated-${taskId}`;
}

/** `ddev utility migrate-database <type>:<version>` — converts the existing DB to a
 *  new dbtype/dbversion IN PLACE (MySQL/MariaDB only; rejects Postgres). The original
 *  dump was consumed at 01c, so this — preceded by ddevSnapshot — is the only safe
 *  path for a mid-task DB version change. */
export async function ddevMigrateDatabase(
  handle: DdevRunnerHandle,
  target: string,
  opts: { onLine?: (line: string) => void } = {},
): Promise<{ exitCode: number; output: string }> {
  return ddevExec(handle, `utility migrate-database ${target}`, {
    timeoutMs: 1_800_000,
    onLine: opts.onLine,
  });
}

export type DdevRecovery = 'reuse' | 'warm-start' | 'cold-boot';

/** Pure decision for how to bring a task's DDEV env up, given what we observed
 *  about the existing runner. Extracted (and exported) so the recovery logic is
 *  unit-testable without shelling out to docker (mirrors 07c's `classifyDrift`).
 *  - `reuse`: the project is already serving — return the existing handle.
 *  - `warm-start`: the project is down BUT the runner container + nested dockerd
 *    are alive, so `ddev start` in place recovers it using the cached images
 *    (no re-pull, no DB loss).
 *  - `cold-boot`: the runner is gone (or warm-start failed) — rebuild it, which
 *    re-pulls base images into a fresh nested store. */
export function decideDdevRecovery(s: {
  describeOk: boolean;
  hasPrimaryUrl: boolean;
  dockerdUp: boolean;
}): DdevRecovery {
  if (s.describeOk && s.hasPrimaryUrl) return 'reuse';
  return s.dockerdUp ? 'warm-start' : 'cold-boot';
}

/** True when the runner container exists and its nested dockerd answers — i.e.
 *  an in-place `ddev start` is even possible. Runs `docker info` as ROOT inside
 *  the runner (NOT via ddevExec/runnerExec, which add `-u ddev`), mirroring the
 *  readiness probe in startDdevRunner. Swallows its own error and returns false
 *  (it runs inside the coalesced boot promise — a throw would fail all waiters
 *  instead of falling through to a cold rebuild). */
async function runnerDockerdUp(name: string): Promise<boolean> {
  try {
    await exec('docker', ['exec', name, 'docker', 'info'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** Ensure the task's DDEV env is up and `ddev start`-ed, booting it if not.
 *  Idempotent: returns the existing handle when DDEV is already running (so a
 *  prior `import-db` is preserved). Recovery has three paths (decideDdevRecovery):
 *  `reuse` (already serving), `warm-start` (runner container + nested dockerd
 *  alive but the project is down — restart in place: no image re-pull, and NO
 *  snapshot restore so the live nested DB is kept), or `cold-boot` (runner gone —
 *  rebuild + restore the durability snapshot into the fresh, empty nested DB).
 *  THROWS if the cold-boot `ddev start` fails. Callers treat a throw as a step
 *  failure — e.g. a task that just implemented `.ddev` (01c skipped early), where
 *  the browser-verify step boots the new config and a boot failure routes back
 *  to the dev. */
const inFlightDdevBoots = new Map<string, Promise<DdevRunnerHandle>>();

export async function ensureDdevStarted(
  taskId: string,
  repoSubpath: string,
  opts: { onProgress?: (line: string) => void } = {},
): Promise<DdevRunnerHandle> {
  // Coalesce concurrent boots of the SAME task into one. An interactive 08a apply
  // and the VNC runtime-ensure job can both call this at once; two startDdevRunner
  // calls would then collide on the fixed container name (`docker run --name`
  // conflict) and fail the loser. The first call's in-flight promise serves both.
  const inFlight = inFlightDdevBoots.get(taskId);
  if (inFlight) return inFlight;
  const boot = ensureDdevStartedInner(taskId, repoSubpath, opts);
  inFlightDdevBoots.set(taskId, boot);
  try {
    return await boot;
  } finally {
    inFlightDdevBoots.delete(taskId);
  }
}

async function ensureDdevStartedInner(
  taskId: string,
  repoSubpath: string,
  opts: { onProgress?: (line: string) => void },
): Promise<DdevRunnerHandle> {
  const existing = runnerHandleForTask(taskId, repoSubpath);
  const describe = await ddevExec(existing, 'describe -j', { timeoutMs: 15_000 });
  const describeOk = describe.exitCode === 0;
  const hasPrimaryUrl = describe.output.includes('primary_url');
  // Only probe the nested dockerd when describe didn't already prove the project
  // is up (the cheap path short-circuits the extra docker exec).
  const dockerdUp = describeOk && hasPrimaryUrl ? true : await runnerDockerdUp(existing.container);

  switch (decideDdevRecovery({ describeOk, hasPrimaryUrl, dockerdUp })) {
    case 'reuse':
      return existing; // already serving — don't re-boot (preserves an imported DB)
    case 'warm-start': {
      // Container + nested dockerd are alive; only the DDEV project is down (e.g.
      // a worker hot-reload SIGKILLed an in-flight `ddev` op mid-restart). Restart
      // the project IN PLACE — the base images are still cached in the surviving
      // anon /var/lib/docker, so this pulls nothing (only a genuinely-changed
      // php/db image would). One ~300s attempt: with images cached there is no
      // multi-GB pull to wait on, so a wedged warm start fails fast into the cold
      // rebuild below rather than blocking for the cold path's 900s.
      const warm = await ddevExec(existing, 'start', {
        onLine: opts.onProgress,
        timeoutMs: 300_000,
      });
      if (warm.exitCode === 0) {
        // Deliberately NO restoreLatestSnapshot: the container survived, so its
        // nested DB volume survived and holds the live (possibly newer) DB. A
        // repo-volume snapshot is OLDER — restoring it here would clobber the
        // live DB. Skip it even when a snapshot exists.
        return existing;
      }
      log.warn(
        { taskId, output: warm.output.slice(-800) },
        'ddev warm-start failed; rebuilding the runner (cold boot)',
      );
      break; // fall through to cold-boot — its rm -v clears any wedged state
    }
    case 'cold-boot':
      break;
  }

  // Cold boot: the runner is gone (or warm-start failed), so rebuild it. This
  // re-pulls base images into a fresh nested /var/lib/docker.
  const handle = await startDdevRunner({ taskId, repoSubpath });
  let start = await ddevExec(handle, 'start', { onLine: opts.onProgress, timeoutMs: 900_000 });
  if (start.exitCode !== 0) {
    // A cold first boot builds the project's custom web image, so container
    // readiness can land right at DDEV's default 120s timeout and fail
    // transiently. The images are built now, so one retry usually clears it.
    log.warn({ taskId, output: start.output.slice(-800) }, 'ddev start failed; retrying once');
    start = await ddevExec(handle, 'start', { onLine: opts.onProgress, timeoutMs: 900_000 });
  }
  if (start.exitCode !== 0) {
    throw new Error(`ddev start failed: ${start.output.slice(-1500)}`);
  }
  // The prior runner (and its nested DB) is gone — destroyed by the worker-boot
  // reaper, a daemon/host restart, or task time elapsed — so the freshly-started
  // DB is empty. A durability snapshot may survive on the repo volume; restore it
  // so downstream verify/browser testing runs against a populated DB. No-op (and
  // not an error) when none exists.
  await restoreLatestSnapshot(handle, taskId);
  return handle;
}

/** Restore the most recent Haive durability snapshot after a cold boot: a
 *  post-migration snapshot wins over the raw import. Both absent (first boot, or a
 *  project with no imported DB) is the normal no-op case. Tolerant by design —
 *  keyed only on exit codes, never on snapshot-list output formatting. */
async function restoreLatestSnapshot(handle: DdevRunnerHandle, taskId: string): Promise<void> {
  for (const name of [ddevMigratedSnapshotName(taskId), ddevImportSnapshotName(taskId)]) {
    const res = await ddevSnapshotRestore(handle, name);
    if (res.exitCode === 0) {
      log.info({ taskId, snapshot: name }, 'restored DDEV DB snapshot after cold boot');
      return;
    }
  }
  log.info({ taskId }, 'no DDEV DB snapshot to restore (first boot or no imported DB)');
}

/** Run a ddev subcommand with live per-line streaming for the progress UI. The
 *  buffered ddevExec returns nothing until a multi-minute op (cold boot, restart,
 *  import-db, migrate-database) finishes; this spawns the same command and calls
 *  onLine per output line so callers can surface the current stage. Returns the
 *  identical { exitCode, output } shape (output = tail). */
function ddevExecStreaming(
  handle: DdevRunnerHandle,
  ddevArgs: string,
  onLine?: (line: string) => void,
  timeoutMs = 900_000,
): Promise<{ exitCode: number; output: string }> {
  const cmd = `cd ${handle.projectDir} && ddev ${ddevArgs}`;
  return new Promise((resolve) => {
    const child = spawn('docker', ['exec', '-u', 'ddev', handle.container, 'bash', '-lc', cmd]);
    let buf = '';
    let lineBuf = '';
    const onData = (chunk: Buffer): void => {
      const s = chunk.toString('utf8');
      buf += s;
      if (buf.length > 200_000) buf = buf.slice(-200_000);
      lineBuf += s;
      let nl: number;
      while ((nl = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        if (onLine && line.trim()) onLine(line);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already exited */
      }
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (onLine && lineBuf.trim()) onLine(lineBuf);
      resolve({ exitCode: code ?? 1, output: buf.slice(-8000) });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ exitCode: 1, output: buf.slice(-8000) });
    });
  });
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

/** Start (idempotently) the headed-browser desktop inside the runner: Xvfb +
 *  VNC + the CDP forward + headed Chromium (see start-browser-desktop.sh). The
 *  web noVNC panel attaches via the api bridge; agents drive the same browser
 *  over CDP at <runner>:9223. Throws when the desktop fails to come up. */
export async function startBrowserDesktop(handle: DdevRunnerHandle): Promise<void> {
  const res = await runnerExec(handle, 'start-browser-desktop.sh', { timeoutMs: 60_000 });
  if (res.exitCode !== 0) {
    throw new Error(`browser desktop failed to start: ${res.output.slice(-1000)}`);
  }
}

/** If the runner's headed-browser desktop is up, return the http://<ip>:9223 URL
 *  sandboxed CLIs use to connect chrome-devtools to that SAME visible browser; else
 *  null (caller self-launches an isolated one). The runner's network IP, not its DNS
 *  name — Chrome's DevTools HTTP handler 500s on a non-localhost/non-IP Host header.
 *  See browserCdpUrlForRunner. Only called when chrome-devtools is enabled. */
export async function runnerBrowserCdpUrl(taskId: string): Promise<string | null> {
  return browserCdpUrlForRunner(ddevRunnerName(taskId));
}

// --- On-demand step-debugging (Xdebug) ---------------------------------------

/** Parse the default-route gateway from a Linux `/proc/net/route` dump. The
 *  gateway is a little-endian hex quad on the row whose Destination is 00000000.
 *  Used instead of `ip route` so it works regardless of whether iproute2 is in the
 *  DDEV web image. Returns a dotted-quad string or null. */
export function parseProcNetRouteGateway(text: string): string | null {
  for (const line of text.split('\n')) {
    const cols = line.trim().split(/\s+/);
    // cols: Iface Destination Gateway Flags ... — default route Destination=00000000.
    if (cols.length >= 3 && cols[1] === '00000000' && /^[0-9A-Fa-f]{8}$/.test(cols[2] ?? '')) {
      const hex = cols[2]!;
      const octets = [hex.slice(6, 8), hex.slice(4, 6), hex.slice(2, 4), hex.slice(0, 2)].map((h) =>
        parseInt(h, 16),
      );
      return octets.join('.');
    }
  }
  return null;
}

/** The IP the nested PHP (L3) container uses to reach the runner (L2): its default
 *  route gateway, read from /proc/net/route INSIDE the DDEV web container via `ddev
 *  exec`. This — NOT host.docker.internal — is the correct xdebug.client_host in this
 *  DinD topology (host.docker.internal resolves to the outer Docker-Desktop host,
 *  above the runner, where nothing in the haive stack listens). Null when it can't
 *  be resolved (caller skips the xdebug wiring rather than misconfigure it). */
async function resolveRunnerGateway(handle: DdevRunnerHandle): Promise<string | null> {
  const res = await ddevExec(handle, 'exec cat /proc/net/route', { timeoutMs: 20_000 });
  if (res.exitCode !== 0) return null;
  return parseProcNetRouteGateway(res.output);
}

/** Routing-only xdebug ini written into the worktree's .ddev/php/ (loaded last —
 *  the zz- prefix sorts after DDEV's 20-xdebug.ini so these win). It sets ONLY the
 *  connect-back target + trigger mode; the xdebug MODE (on/off) stays controlled by
 *  `ddev xdebug on/off`.
 *
 *  The setting NAMES changed between Xdebug 2 (PHP <= 7.1 in DDEV) and Xdebug 3
 *  (PHP >= 7.2), and each major silently ignores the other's keys — so emitting the
 *  wrong set is a no-op and DBGp goes nowhere. We key on the ACTUAL probed major:
 *  - Xdebug 3: client_host + discover_client_host=0 (force the explicit host, else
 *    DDEV dials the request origin — the nested router) + start_with_request=trigger.
 *  - Xdebug 2: remote_host + remote_connect_back=0 (the pre-3 equivalent of
 *    discover off) + remote_autostart=0 (trigger-only; overrides DDEV's =1 so only
 *    XDEBUG_SESSION-triggered requests break, not every page load). */
export function renderXdebugIni(gateway: string, major: number): string {
  const header = [
    '; Managed by Haive on-demand step-debugging. Routes Xdebug DBGp to the',
    '; code-server "Listen for Xdebug" listener via a socat forward on the runner.',
  ];
  const body =
    major >= 3
      ? [
          `xdebug.client_host=${gateway}`,
          `xdebug.client_port=${XDEBUG_PORT}`,
          'xdebug.discover_client_host=0',
          'xdebug.start_with_request=trigger',
        ]
      : [
          'xdebug.remote_enable=1',
          `xdebug.remote_host=${gateway}`,
          `xdebug.remote_port=${XDEBUG_PORT}`,
          'xdebug.remote_connect_back=0',
          'xdebug.remote_autostart=0',
        ];
  // Deliberately NOT overriding xdebug.max_nesting_level: DDEV's default (1000) is a
  // safety net that surfaces runaway/infinite recursion as a fast, clean "Maximum
  // function nesting level reached" abort instead of a slow OOM — which is exactly
  // what you want while debugging (it's how a real infinite-recursion app bug was
  // first spotted). Haive's ini sets ONLY the DBGp routing; it doesn't second-guess
  // DDEV's other xdebug defaults. (A legit app that genuinely recurses >1000 is rare
  // and is a standard, documented xdebug situation the developer can tune themselves.)
  return [...header, ...body, ''].join('\n');
}

/** Probe the running web container's Xdebug MAJOR version so renderXdebugIni emits
 *  the matching setting names. Keys on the real extension version (the invariant),
 *  not a PHP-version guess. Requires xdebug loaded — the caller enables it first.
 *  `php -v` prints e.g. "with Xdebug v2.5.5". Defaults to 3 (current DDEV default)
 *  when the line is absent/unparseable. */
async function resolveXdebugMajor(handle: DdevRunnerHandle): Promise<number> {
  const res = await ddevExec(handle, 'exec php -v', { timeoutMs: 30_000 });
  const m = res.output.match(/Xdebug v(\d+)\./i);
  return m && m[1] ? Number(m[1]) : 3;
}

/** Start a persistent TCP forwarder on the runner: runner:<listenPort> -> <target>.
 *  Uses a DETACHED `docker exec -d` + `exec socat` — a backgrounded `socat … &`
 *  inside a normal `docker exec` does NOT survive (docker reaps the exec's child when
 *  the foreground command returns). Idempotent via a PORT probe, NOT `pgrep -f`: the
 *  guard's own command line contains the socat invocation, so `pgrep -f "socat…"`
 *  matches itself and would never start. fork+reuseaddr; a NAME target is re-resolved
 *  per connection (survives a recreate) and need not exist yet (the listener binds
 *  immediately, resolves on first connect). Best-effort — logs and continues. */
async function startRunnerForward(
  runner: string,
  listenPort: number,
  target: string,
): Promise<void> {
  const guarded =
    `(</dev/tcp/127.0.0.1/${listenPort}) 2>/dev/null && exit 0 || ` +
    `exec socat "TCP-LISTEN:${listenPort},fork,reuseaddr" "TCP:${target}"`;
  await exec('docker', ['exec', '-d', '-u', 'ddev', runner, 'bash', '-c', guarded], {
    timeout: 15_000,
  }).catch((err) => {
    log.warn(
      { runner, listenPort, target, err: err instanceof Error ? err.message : String(err) },
      'runner TCP forward start failed',
    );
  });
}

const XDEBUG_INI_RELPATH = ['.ddev', 'php', 'zz-haive-xdebug.ini'];

/** Wire on-demand Xdebug step-debugging for a running DDEV project so the IDE's
 *  php-debug listener receives DBGp. Idempotent + restart-minimal:
 *   1. resolve the runner gateway the PHP container routes through;
 *   1b. enable xdebug + probe its MAJOR version (2.x vs 3.x use different setting
 *       names) so the ini is rendered with keys the installed extension honors;
 *   2. write .ddev/php/zz-haive-xdebug.ini (host=gateway, trigger-only) — only when
 *      its content changed (gateway drift across a cold-boot, or first enable);
 *   3. forward runner:9003 -> <ide>:9003 with a socat fork listener (pgrep-guarded,
 *      mirrors start-browser-desktop.sh); the IDE need not be up yet (fork resolves
 *      the target per connection);
 *   4. `ddev restart` ONLY when the ini changed (to copy it into the web container's
 *      php conf.d), then `ddev xdebug on` (loads the extension + debug mode).
 *  Best-effort: a gateway-resolution failure logs and returns without touching the
 *  project, so a debug-setup hiccup never breaks the app's DDEV bring-up. */
export async function ensureDdevXdebug(
  handle: DdevRunnerHandle,
  opts: {
    repoSubpath: string;
    ideContainer: string;
    onProgress?: (line: string) => void;
  },
): Promise<void> {
  const gateway = await resolveRunnerGateway(handle);
  if (!gateway) {
    log.warn(
      { container: handle.container },
      'xdebug: could not resolve runner gateway — skipping step-debug wiring (app unaffected)',
    );
    return;
  }

  // Enable xdebug up front so the version probe sees a loaded extension (`php -v`
  // omits the version line when xdebug is off); harmless when already on. The MAJOR
  // version decides which setting names the ini must use — Xdebug 2.x and 3.x keys
  // are mutually ignored, so the wrong set is a silent no-op.
  const preOn = await ddevExec(handle, 'xdebug on', { timeoutMs: 120_000 });
  if (preOn.exitCode !== 0) {
    log.warn(
      { container: handle.container, output: preOn.output.slice(-300) },
      'xdebug: initial `ddev xdebug on` non-zero (continuing; version probe may default to 3)',
    );
  }
  const major = await resolveXdebugMajor(handle);

  const iniPath = path.join(XDEBUG_REPO_STORAGE_ROOT, opts.repoSubpath, ...XDEBUG_INI_RELPATH);
  const desired = renderXdebugIni(gateway, major);
  const prev = await readFile(iniPath, 'utf8').catch(() => null);
  const changed = prev !== desired;
  if (changed) {
    await mkdir(path.dirname(iniPath), { recursive: true });
    await writeFile(iniPath, desired, 'utf8');
    // New file is worker(root)-owned inside the 1000-owned worktree; chown so the
    // ddev user (uid 1000) reads it when DDEV copies .ddev/php/*.ini into conf.d.
    await exec('chown', ['-R', '1000:1000', path.dirname(iniPath)], { timeout: 15_000 }).catch(
      () => {},
    );
  }

  // socat forward on the runner: runner:9003 -> <ide>:9003. The runner resolves the
  // IDE by name on the sandbox network (re-resolved per connection, so it survives an
  // IDE recreate); the IDE need not be up yet — fork binds 9003 now and resolves the
  // target when PHP first connects.
  await startRunnerForward(handle.container, XDEBUG_PORT, `${opts.ideContainer}:${XDEBUG_PORT}`);

  // A freshly-written .ddev/php ini is only copied into the web container's php
  // conf.d at a (re)start, so restart when it changed. Unchanged (warm-recover)
  // skips the restart — just (re)assert xdebug on, which is cheap and idempotent.
  if (changed) {
    opts.onProgress?.('Applying Xdebug configuration (ddev restart)…');
    const restart = await ddevExec(handle, 'restart', {
      timeoutMs: 900_000,
      onLine: opts.onProgress,
    });
    if (restart.exitCode !== 0) {
      log.warn(
        { container: handle.container, output: restart.output.slice(-500) },
        'xdebug: ddev restart after ini write non-zero (continuing to xdebug on)',
      );
    }
  }
  // Re-assert on: a `ddev restart` above resets xdebug to the project default
  // (typically off), so enable it again. Idempotent + cheap when already on.
  const on = await ddevExec(handle, 'xdebug on', { timeoutMs: 120_000 });
  if (on.exitCode !== 0) {
    log.warn(
      { container: handle.container, output: on.output.slice(-300) },
      'xdebug: `ddev xdebug on` non-zero',
    );
    return;
  }
  log.info(
    { container: handle.container, gateway, major, ide: opts.ideContainer },
    'xdebug wired for task',
  );

  // Lane C1: also forward runner:9229 -> <DDEV web container>:9229 so the Editor tab
  // can attach to a Node --inspect running INSIDE the DDEV web container (e.g. a
  // project that runs Node under DDEV with NODE_OPTIONS=--inspect; harmless when
  // nothing listens). The web container is nested in the runner's dockerd, so the
  // runner reaches it by its own IP (post-restart value). Re-forwards only when the
  // IP changed (idempotent across warm-recover); best-effort.
  await ensureDdevNodeForward(handle);
}

/** Forward runner:9229 -> the DDEV web container's :9229 (Lane C1). The web IP can
 *  change across a restart, so always refresh: drop any existing 9229 forwarder, then
 *  start a fresh detached one to the CURRENT IP. The runner is on the same nested
 *  bridge as the web container, so it reaches the IP directly. Best-effort. */
async function ensureDdevNodeForward(handle: DdevRunnerHandle): Promise<void> {
  const res = await ddevExec(handle, 'exec hostname -i', { timeoutMs: 15_000 });
  const webIp = res.output.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/)?.[1];
  if (!webIp) return;
  // pkill runs as its own exec (process is `pkill`, which excludes its own pid) so it
  // never matches itself. After it, port 9229 is free, so startRunnerForward's port
  // guard proceeds to start the fresh forwarder to the current IP.
  await exec(
    'docker',
    [
      'exec',
      '-u',
      'ddev',
      handle.container,
      'pkill',
      '-f',
      `socat.*TCP-LISTEN:${XDEBUG_NODE_PORT}`,
    ],
    { timeout: 10_000 },
  ).catch(() => {});
  await startRunnerForward(handle.container, XDEBUG_NODE_PORT, `${webIp}:${XDEBUG_NODE_PORT}`);
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
