import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';
import { ddevRunnerName, logger } from '@haive/shared';

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
  const runArgs = [
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
  ];
  await exec('docker', ['rm', '-f', '-v', name], { timeout: 90_000 }).catch(() => {});
  try {
    await exec('docker', runArgs, { timeout: 60_000 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/already in use/i.test(msg)) throw err;
    await exec('docker', ['rm', '-f', '-v', name], { timeout: 90_000 }).catch(() => {});
    await exec('docker', runArgs, { timeout: 60_000 });
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
): Promise<{ exitCode: number; output: string }> {
  return ddevExec(handle, 'restart', { timeoutMs: 900_000 });
}

/** `ddev snapshot --name=<name>` — db backup taken before a destructive migrate.
 *  Restore with `ddev snapshot restore <name>`. */
export async function ddevSnapshot(
  handle: DdevRunnerHandle,
  name: string,
): Promise<{ exitCode: number; output: string }> {
  return ddevExec(handle, `snapshot --name=${name}`, { timeoutMs: 600_000 });
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
  const start = await ddevExec(handle, 'start', { timeoutMs: 900_000 });
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
): Promise<{ exitCode: number; output: string }> {
  return ddevExec(handle, `utility migrate-database ${target}`, { timeoutMs: 1_800_000 });
}

/** Ensure the task's DDEV env is up and `ddev start`-ed, booting it if not.
 *  Idempotent: returns the existing handle when DDEV is already running (so a
 *  prior `import-db` is preserved); otherwise launches the runner + `ddev start`
 *  and THROWS if start fails. Callers treat a throw as a step failure — e.g. a
 *  task that just implemented `.ddev` (01c skipped early), where the browser-
 *  verify step boots the new config and a boot failure routes back to the dev. */
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
  if (describe.exitCode === 0 && describe.output.includes('primary_url')) {
    return existing; // already running — don't re-boot (preserves an imported DB)
  }
  const handle = await startDdevRunner({ taskId, repoSubpath });
  let start = await ddevStartStreaming(handle, opts.onProgress);
  if (start.exitCode !== 0) {
    // A cold first boot builds the project's custom web image, so container
    // readiness can land right at DDEV's default 120s timeout and fail
    // transiently. The images are built now, so one retry usually clears it.
    log.warn({ taskId, output: start.output.slice(-800) }, 'ddev start failed; retrying once');
    start = await ddevStartStreaming(handle, opts.onProgress);
  }
  if (start.exitCode !== 0) {
    throw new Error(`ddev start failed: ${start.output.slice(-1500)}`);
  }
  // Cold boot: the prior runner (and its nested DB) is gone — destroyed by the
  // worker-boot reaper, a daemon/host restart, or task time elapsed — so the
  // freshly-started DB is empty. A durability snapshot may survive on the repo
  // volume; restore it so downstream verify/browser testing runs against a
  // populated DB. No-op (and not an error) when none exists.
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

/** `ddev start` with live line streaming for progress UI. The buffered ddevExec
 *  returns nothing until the ~2-minute cold boot finishes; this spawns the same
 *  command and calls onLine per output line so callers can surface the current
 *  stage. Returns the identical { exitCode, output } shape (output = tail). */
function ddevStartStreaming(
  handle: DdevRunnerHandle,
  onLine?: (line: string) => void,
): Promise<{ exitCode: number; output: string }> {
  const cmd = `cd ${handle.projectDir} && ddev start`;
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
    }, 900_000);
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

/** If the runner's headed-browser desktop is up (CDP answering on the socat
 *  forward), return the DNS URL sandboxed CLIs use to connect chrome-devtools to
 *  that SAME visible browser; else null (caller self-launches an isolated one).
 *  One cheap docker-exec curl — only called when chrome-devtools is enabled. */
export async function runnerBrowserCdpUrl(taskId: string): Promise<string | null> {
  const name = ddevRunnerName(taskId);
  try {
    await exec('docker', ['exec', name, 'curl', '-fsS', 'http://127.0.0.1:9223/json/version'], {
      timeout: 8_000,
    });
    return `http://${name}:9223`;
  } catch {
    return null;
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
