import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '@haive/shared';
import type { Database } from '@haive/database';
import { resolveDdevWorkspace, loadAppBootOutput } from './_task-meta.js';
import { getTaskEnvTemplate } from '../env-replicate/_shared.js';
import { pathExists } from '../onboarding/_helpers.js';
import { ddevUrlFromConfigText } from '../_ddev-config.js';
import {
  ensureDdevStarted,
  ddevPrimaryUrl,
  type DdevRunnerHandle,
} from '../../../sandbox/ddev-runner.js';
import {
  ensureAppRunnerStarted,
  launchAppInRunner,
  waitForPortInRunner,
  type AppRunnerHandle,
} from '../../../sandbox/app-runner.js';

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
}

export type RuntimeMode = 'ddev' | 'app-runner' | 'host' | 'none';

/** A guaranteed-serving runtime plus the handle callers exec into (probe, browser
 *  desktop). `host` carries no handle (the legacy on-worker boot); `none` means no
 *  runtime is recorded for the task. */
export type ServingRuntime =
  | { mode: 'ddev'; url: string; handle: DdevRunnerHandle }
  | { mode: 'app-runner'; url: string; handle: AppRunnerHandle }
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
  const spec = await classifyRuntime(ctx);

  if (spec.mode === 'ddev' && spec.repoSubpath) {
    const handle = await ensureDdevWithProgress(ctx, spec.repoSubpath);
    const url = (await ddevPrimaryUrl(handle)) ?? spec.knownUrl ?? 'http://localhost';
    return { mode: 'ddev', url, handle };
  }

  if (spec.mode === 'app-runner' && spec.repoSubpath && spec.envImageTag) {
    await ctx.emitProgress?.('Ensuring the app-runner is up…');
    const handle = await ensureAppRunnerStarted(ctx.taskId, spec.repoSubpath, spec.envImageTag);
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
    const url = spec.knownUrl ?? (spec.port ? `http://localhost:${spec.port}` : 'http://localhost');
    return { mode: 'app-runner', url, handle };
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
  ctx: Pick<AppRuntimeCtx, 'taskId' | 'emitProgress'>,
  repoSubpath: string,
): Promise<DdevRunnerHandle> {
  return withDdevProgress(
    ctx,
    'Ensuring the DDEV environment is up…',
    (onLine) => ensureDdevStarted(ctx.taskId, repoSubpath, { onProgress: onLine }),
    { initialLine: 'starting containers…' },
  );
}
