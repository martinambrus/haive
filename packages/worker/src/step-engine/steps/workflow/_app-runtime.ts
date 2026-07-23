import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import {
  logger,
  ideRunnerName,
  CONFIG_KEYS,
  configService,
  type TaskAccessEndpoint,
} from '@haive/shared';
import { schema, type Database } from '@haive/database';
import { resolveDdevWorkspace, loadAppBootOutput } from './_task-meta.js';
import { getTaskEnvTemplate } from '../env-replicate/_shared.js';
import { pathExists } from '../onboarding/_helpers.js';
import { ddevUrlFromConfigText, parseDdevConfig } from '../_ddev-config.js';
import {
  ensureDdevStarted,
  ensureDdevXdebug,
  ensureDdevDbForward,
  ddevDbAccess,
  ddevPrimaryUrl,
  type DdevRunnerHandle,
} from '../../../sandbox/ddev-runner.js';
import {
  ensureAppRunnerStarted,
  launchAppInRunner,
  waitForPortInRunner,
  type AppRunnerHandle,
} from '../../../sandbox/app-runner.js';
import { RuntimeSlotAbortedError } from '../../../sandbox/runtime-admission.js';
import { TaskCancelledError } from '../../step-definition.js';

// The single "is the app actually serving, and at what URL" primitive. Browser
// testing (08a), the live VNC view, and any later runtime consumer all need the
// app reachable — but a worker-process reload, a Docker daemon restart, a host
// reboot, or the runner reaper can leave it down by the time they run. Detecting
// the runtime mode and re-establishing it is solved here once, instead of three
// half-broken ways. Crash-recovery friendly: classification reads persisted rows
// (env-template, 01a-app-boot output, the worktree's .ddev/config.yaml), so it
// works after a total restart with no in-memory state.

/** The subset of StepContext this module needs. Narrowed so non-step callers
 *  (e.g. the VNC ensure path) can drive it without a full StepContext. The logger
 *  is structural (just the log methods) so a fresh `logger.child()` and a
 *  StepContext's logger both satisfy it — pino's custom-level generics make
 *  `ReturnType<typeof logger.child>` reject a freshly-created child otherwise. */
export interface AppRuntimeCtx {
  db: Database;
  taskId: string;
  repoPath: string;
  logger: Pick<typeof logger, 'info' | 'warn' | 'error' | 'debug'>;
  emitProgress?(message: string): Promise<void>;
  /** Throws TaskCancelledError when the task was stopped/cancelled. A StepContext supplies
   *  it directly; a non-step caller (runtime-ensure job) omits it. Threaded so a bring-up
   *  that blocked in the admission gate does not resume and clobber a Stopped step's state
   *  once a slot frees. */
  throwIfCancelled?(): void;
  /** Aborts when the task is stopped/cancelled, so the admission gate can drop the wait
   *  immediately instead of holding a scarce slot until its 8-minute timeout. */
  signal?: AbortSignal;
}

export type RuntimeMode = 'ddev' | 'app-runner' | 'host' | 'none';

/** A guaranteed-serving runtime plus the handle callers exec into (probe, browser
 *  desktop). `host` carries no handle (the legacy on-worker boot); `none` means no
 *  runtime is recorded for the task. */
export type ServingRuntime =
  | { mode: 'ddev'; url: string; handle: DdevRunnerHandle }
  | { mode: 'app-runner'; url: string; handle: AppRunnerHandle; port: number | null }
  | { mode: 'host'; url: string }
  | { mode: 'none'; url: null };

interface RuntimeSpec {
  mode: RuntimeMode;
  repoSubpath: string | null;
  envImageTag: string | null;
  bootCommand: string | null;
  port: number | null;
  /** URL known WITHOUT booting: config-derived (DDEV) or persisted (app-runner/host). */
  knownUrl: string | null;
  workspace: string | null;
}

// ESC-built (not a literal control char) so it doesn't trip no-control-regex.
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

function ddevConfigPath(workspace: string): string {
  return path.join(workspace, '.ddev', 'config.yaml');
}

/** Classify the task's runtime from persisted state, without starting anything.
 *  DDEV wins whenever the active worktree carries a `.ddev/config.yaml` (mirrors
 *  08a/Gate-2). Otherwise the 01a-app-boot row decides containerized app-runner
 *  vs legacy host. `knownUrl` is the best-effort URL resolvable without a boot. */
export async function classifyRuntime(ctx: AppRuntimeCtx): Promise<RuntimeSpec> {
  const base: RuntimeSpec = {
    mode: 'none',
    repoSubpath: null,
    envImageTag: null,
    bootCommand: null,
    port: null,
    knownUrl: null,
    workspace: null,
  };

  const ws = await resolveDdevWorkspace(ctx.db, ctx.taskId, ctx.repoPath);
  if (ws && (await pathExists(ddevConfigPath(ws.workspace)))) {
    const text = await readFile(ddevConfigPath(ws.workspace), 'utf8').catch(() => null);
    return {
      ...base,
      mode: 'ddev',
      repoSubpath: ws.repoSubpath,
      workspace: ws.workspace,
      knownUrl: text ? ddevUrlFromConfigText(text) : null,
    };
  }

  const boot = await loadAppBootOutput(ctx.db, ctx.taskId);
  if (!boot || !boot.booted || boot.skipped) return base;

  if (boot.containerized && boot.runtimeContainer) {
    const envTemplate = await getTaskEnvTemplate(ctx.db, ctx.taskId);
    return {
      ...base,
      mode: 'app-runner',
      repoSubpath: ws?.repoSubpath ?? null,
      envImageTag: envTemplate?.imageTag ?? null,
      bootCommand: boot.bootCommand ?? null,
      port: boot.port ?? null,
      knownUrl: boot.appUrl ?? (boot.port ? `http://localhost:${boot.port}` : null),
      workspace: ws?.workspace ?? null,
    };
  }

  return {
    ...base,
    mode: 'host',
    bootCommand: boot.bootCommand ?? null,
    knownUrl: boot.appUrl ?? null,
  };
}

/** Ensure the task's app is up and serving, returning the authoritative URL plus
 *  the runtime handle. Idempotent; safe to call from any step's apply/prepare or a
 *  worker job. DDEV: boots the runner (ensureDdevStarted throws on failure) and
 *  resolves the live primary_url. app-runner: brings the container back AND
 *  relaunches the dev server when a cold restart killed it (the container alone
 *  does not restart the process). host: best-effort URL only (no relaunch). */
export async function ensureAppServing(ctx: AppRuntimeCtx): Promise<ServingRuntime> {
  try {
    return await ensureAppServingInner(ctx);
  } catch (err) {
    // A slot wait aborted because the task was stopped — normalise to TaskCancelledError so
    // the step runner's cancel path handles it (leave the step Stopped, don't re-fail or
    // route it into the fix-loop).
    if (err instanceof RuntimeSlotAbortedError) throw new TaskCancelledError();
    throw err;
  }
}

async function ensureAppServingInner(ctx: AppRuntimeCtx): Promise<ServingRuntime> {
  // Bail before doing any bring-up work if the task was already stopped.
  ctx.throwIfCancelled?.();
  const spec = await classifyRuntime(ctx);

  if (spec.mode === 'ddev' && spec.repoSubpath) {
    const handle = await ensureDdevWithProgress(ctx, spec.repoSubpath);
    // A bring-up that blocked in the admission gate may return long after the user hit
    // Stop; check BEFORE the caller writes waiting_cli so it can't resurrect a Stopped
    // step (the throw unwinds through the step runner's cancel handling instead).
    ctx.throwIfCancelled?.();
    const url = (await ddevPrimaryUrl(handle)) ?? spec.knownUrl ?? 'http://localhost';
    return { mode: 'ddev', url, handle };
  }

  if (spec.mode === 'app-runner' && spec.repoSubpath && spec.envImageTag) {
    await ctx.emitProgress?.('Ensuring the app-runner is up…');
    const handle = await ensureAppRunnerStarted(
      ctx.taskId,
      spec.repoSubpath,
      spec.envImageTag,
      spec.port ?? undefined,
    );
    // A cold container recreate (worker reload, daemon restart, host reboot)
    // brings the container back as `sleep infinity` but NOT the dev server — so
    // probe the port and relaunch the recorded boot command when it's dead.
    if (spec.port && spec.bootCommand) {
      const alreadyUp = await waitForPortInRunner(handle, spec.port, 3000);
      if (!alreadyUp) {
        await ctx.emitProgress?.('Relaunching the app inside the runner…');
        const { healthy, logTail } = await launchAppInRunner(handle, spec.bootCommand, spec.port);
        if (!healthy)
          ctx.logger.warn({ taskId: ctx.taskId, logTail }, 'app did not respond after relaunch');
      }
    }
    ctx.throwIfCancelled?.(); // see the ddev branch: don't resurrect a Stopped step
    const url = spec.knownUrl ?? (spec.port ? `http://localhost:${spec.port}` : 'http://localhost');
    return { mode: 'app-runner', url, handle, port: spec.port };
  }

  if (spec.mode === 'host') {
    return { mode: 'host', url: spec.knownUrl ?? 'http://localhost' };
  }

  return { mode: 'none', url: null };
}

/** Run a long-running DDEV operation while streaming live progress to the step's
 *  status line: `<label> <elapsed>s — <latest ddev output line>`. The elapsed
 *  counter ticks every 2.5s even through DDEV's silent "waiting for containers"
 *  phase, so a multi-minute boot / restart / import / migrate never looks frozen.
 *  `run` receives an `onLine` sink to feed the op's streamed output through; ops
 *  with sparse output still get the ticking elapsed counter. Returns whatever
 *  `run` returns. Shared by ensureDdevWithProgress and the reconcile/import/migrate
 *  steps so every long DDEV op surfaces the same live status. */
export async function withDdevProgress<T>(
  ctx: Pick<AppRuntimeCtx, 'emitProgress'>,
  label: string,
  run: (onLine: (line: string) => void) => Promise<T>,
  opts: { initialLine?: string } = {},
): Promise<T> {
  const startedAt = Date.now();
  let lastLine = opts.initialLine ?? '';
  const heartbeat = ctx.emitProgress
    ? setInterval(() => {
        const secs = Math.round((Date.now() - startedAt) / 1000);
        const tail = lastLine ? ` — ${lastLine}` : '';
        void ctx.emitProgress?.(`${label} ${secs}s${tail}`.slice(0, 200));
      }, 2500)
    : null;
  try {
    return await run((line) => {
      const clean = stripAnsi(line).trim();
      if (clean) lastLine = clean.slice(0, 140);
    });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

/** Boot/ensure the task's DDEV runner while streaming live progress to the step's
 *  status line: the latest `ddev start` output line plus an elapsed counter that
 *  ticks even through DDEV's silent "waiting for containers" dots phase, so a
 *  ~2-minute cold boot never looks frozen. Shared by 01c-ddev-env, 07c-ddev-
 *  reconcile, and ensureAppServing. Throws whatever ensureDdevStarted throws. */
export async function ensureDdevWithProgress(
  ctx: Pick<AppRuntimeCtx, 'taskId' | 'emitProgress' | 'db' | 'signal'>,
  repoSubpath: string,
): Promise<DdevRunnerHandle> {
  const handle = await withDdevProgress(
    ctx,
    'Ensuring the DDEV environment is up…',
    (onLine) =>
      ensureDdevStarted(ctx.taskId, repoSubpath, { onProgress: onLine, signal: ctx.signal }),
    { initialLine: 'starting containers…' },
  );
  // On-demand step-debugging: when the task opted into debug mode, (re)wire Xdebug
  // so the Editor tab's php-debug listener receives DBGp. Idempotent + restart-
  // minimal; runs on EVERY DDEV bring-up (first boot, warm-recover, cold-boot) so a
  // gateway change across a cold-boot is re-applied. Never fails the bring-up.
  await maybeWireDdevXdebug(ctx, handle, repoSubpath);
  // Direct database access: when the task opted in, (re)expose its DDEV database on the
  // runner's reserved loopback host port (a socat hop to the nested db container) so a
  // local DB client can connect. Idempotent; runs on EVERY bring-up (re-resolves the db
  // IP after a restart). Never fails the bring-up.
  await maybeExposeDdevDbPort(ctx, handle, repoSubpath);
  return handle;
}

const rtLog = logger.child({ module: 'app-runtime' });

/** Wire Xdebug for a debug-mode task's DDEV env (no-op otherwise). Reads the task's
 *  debug_mode flag and, when set, points Xdebug at the runner gateway + forwards
 *  9003 to the task's IDE container. Best-effort: swallows errors so a debug-setup
 *  failure never breaks the DDEV bring-up the caller depends on. */
async function maybeWireDdevXdebug(
  ctx: Pick<AppRuntimeCtx, 'taskId' | 'emitProgress' | 'db'>,
  handle: DdevRunnerHandle,
  repoSubpath: string,
): Promise<void> {
  const task = await ctx.db.query.tasks.findFirst({
    where: eq(schema.tasks.id, ctx.taskId),
    columns: { debugMode: true },
  });
  if (!task?.debugMode) return;
  try {
    await ensureDdevXdebug(handle, {
      repoSubpath,
      ideContainer: ideRunnerName(ctx.taskId),
      onProgress: (line) => void ctx.emitProgress?.(line),
    });
  } catch (err) {
    rtLog.warn(
      { taskId: ctx.taskId, err: err instanceof Error ? err.message : String(err) },
      'xdebug wiring failed (app unaffected)',
    );
  }
}

/** Worker-side root of the haive_repos volume (the worktree's .ddev/config.yaml lives at
 *  <root>/<repoSubpath>/.ddev/config.yaml). Mirrors ddev-runner's XDEBUG_REPO_STORAGE_ROOT. */
const REPO_STORAGE_ROOT = process.env.REPO_STORAGE_ROOT ?? '/var/lib/haive/repos';

/** The task's DDEV database engine from the worktree config: `mariadb` | `mysql` |
 *  `postgres`. DDEV runs a mariadb db container by default when the config omits the
 *  `database:` block (Haive-generated configs do), so a null/absent type means mariadb —
 *  NOT "no database". Actual reachability is self-gated downstream (getent hosts db). */
async function resolveTaskDbEngine(repoSubpath: string): Promise<string> {
  const cfgPath = path.join(REPO_STORAGE_ROOT, repoSubpath, '.ddev', 'config.yaml');
  const text = await readFile(cfgPath, 'utf8').catch(() => null);
  return (text ? parseDdevConfig(text).dbType : null) ?? 'mariadb';
}

/** Expose a db-opt-in task's DDEV database on the runner's reserved loopback host port
 *  (no-op otherwise). Reads the task's expose_db_port flag + the global kill-switch and,
 *  when both on, resolves the engine and (re)starts the socat hop. Best-effort: swallows
 *  errors so a db-exposure failure never breaks the DDEV bring-up the caller depends on. */
async function maybeExposeDdevDbPort(
  ctx: Pick<AppRuntimeCtx, 'taskId' | 'db'>,
  handle: DdevRunnerHandle,
  repoSubpath: string,
): Promise<void> {
  // Whole body is best-effort: the task lookup is inside the try too, so a transient
  // schema mismatch (column not yet migrated) or a mock db without the column never
  // breaks the DDEV bring-up the caller depends on.
  try {
    const task = await ctx.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, ctx.taskId),
      columns: { exposeDbPort: true },
    });
    if (!task?.exposeDbPort) return;
    if (!(await configService.getBoolean(CONFIG_KEYS.DB_DIRECT_ACCESS, true))) return;
    const engine = await resolveTaskDbEngine(repoSubpath);
    await ensureDdevDbForward(handle, ctx.taskId, engine);
  } catch (err) {
    rtLog.warn(
      { taskId: ctx.taskId, err: err instanceof Error ? err.message : String(err) },
      'db-port exposure failed (app unaffected)',
    );
  }
}

/** The db-access endpoints (kind `database`) for a task that opted into db exposure with
 *  the global switch on; empty otherwise. The runtime-ensure surface appends these to
 *  accessUrls so the /db-access route and the browser /access-urls route read the same job
 *  result. Engine from the worktree config (mariadb default); repoSubpath from the handle. */
export async function resolveDdevDbAccess(
  db: Database,
  taskId: string,
  handle: DdevRunnerHandle,
): Promise<TaskAccessEndpoint[]> {
  // Best-effort surface: any failure (schema mismatch, missing column) yields no db
  // endpoint rather than breaking the runtime-ensure that also drives the VNC panel.
  try {
    const task = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, taskId),
      columns: { exposeDbPort: true },
    });
    if (!task?.exposeDbPort) return [];
    if (!(await configService.getBoolean(CONFIG_KEYS.DB_DIRECT_ACCESS, true))) return [];
    const repoSubpath = handle.projectDir.replace(/^\/repos\//, '');
    const engine = await resolveTaskDbEngine(repoSubpath);
    return await ddevDbAccess(taskId, engine);
  } catch {
    return [];
  }
}
