import { Worker, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  QUEUE_NAMES,
  RUNTIME_ENSURE_JOB_NAMES,
  logger,
  type RuntimeEnsurePayload,
  type RuntimeEnsureResult,
  type TaskAccessEndpoint,
} from '@haive/shared';
import { getDb } from '../db.js';
import { getBullRedis } from '../redis.js';
import {
  ensureAppServing,
  resolveDdevDbAccess,
  type AppRuntimeCtx,
  type ServingRuntime,
} from '../step-engine/steps/workflow/_app-runtime.js';
import {
  startBrowserDesktop as startDdevBrowserDesktop,
  ddevAccessUrls,
  ddevMailpitUrls,
  runnerExec,
} from '../sandbox/ddev-runner.js';
import {
  startBrowserDesktop as startAppBrowserDesktop,
  appRunnerAccessUrls,
  appRunnerExec,
} from '../sandbox/app-runner.js';

// The worker side of the VNC "ensure runtime" handshake. The api enqueues a job
// here when the live Browser panel opens; the worker brings the task's app +
// headed-browser desktop up (the api cannot — spawning task containers is
// worker-only) and returns once the desktop is reachable, so the api's VNC bridge
// connects to a live desktop instead of silently tearing down a dead one.

const log = logger.child({ module: 'runtime-ensure' });

/** Point the freshly-recovered headed-browser desktop at the app URL — the same
 *  navigate every desktop-start site runs (08a, Gate-2 detect, 99-run-app). The step's
 *  own detect did this once, but a parked step does NOT re-detect (step-runner only
 *  detects when detectOutput is null), so after a worker/host restart this ensure path
 *  is the only thing that brings the desktop back — and without the navigate the VNC
 *  panel bridges to a blank Chrome, leaving the user with no app to test. Best-effort:
 *  runnerExec/appRunnerExec never throw and a non-zero/failed navigate must not fail the
 *  ensure job (it also feeds /access-urls + /db-access); the panel still bridges. */
async function navigateDesktopTo(
  runtime: ServingRuntime,
  taskId: string,
  url: string | null,
): Promise<void> {
  if (runtime.mode !== 'ddev' && runtime.mode !== 'app-runner') return;
  if (!url) return;
  try {
    const r =
      runtime.mode === 'ddev'
        ? await runnerExec(runtime.handle, `node /opt/browser-probe-connect.js '${url}'`, {
            timeoutMs: 30_000,
          })
        : await appRunnerExec(
            runtime.handle,
            `node /opt/browser/browser-probe-connect.js '${url}'`,
            { timeoutMs: 30_000 },
          );
    if (r.exitCode !== 0)
      log.warn({ taskId, url }, 'runtime-ensure browser navigate returned non-zero');
  } catch (err) {
    log.warn({ taskId, err }, 'runtime-ensure browser navigate failed (panel unaffected)');
  }
}

function navigateDesktopToApp(runtime: ServingRuntime, taskId: string): Promise<void> {
  return navigateDesktopTo(runtime, taskId, runtime.url);
}

/** The task's serving runtime, or null when the task has no repository to serve. Reads the
 *  repo path the same way the task worker builds a step context, then delegates to the
 *  shared ensureAppServing primitive. Idempotent. */
async function resolveServingRuntime(taskId: string): Promise<ServingRuntime | null> {
  const db = getDb();
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
  const ctx: AppRuntimeCtx = { db, taskId, repoPath, logger: log };
  return ensureAppServing(ctx);
}

/** Ensure the task's app is serving and its headed-browser desktop is up. Idempotent.
 *
 *  Every caller is USER-INITIATED (the browser-vnc bridge, direct-browser-access,
 *  db-access) — someone is actively viewing the task and waiting on the runtime — so a
 *  FAILED task is brought up on demand, which is the whole point of keeping a failed
 *  task's browser panel for debugging (tasks/[id]/page.tsx). It is intentionally NOT
 *  gated on task status: a dead task cold-booting a runner nobody watches is prevented by
 *  the runtime reaper, whose grace is anchored to the task's failure time — a long-failed
 *  task's runner is reclaimed on the next sweep, so it cannot squat a slot. */
export async function ensureRuntimeForTask(taskId: string): Promise<RuntimeEnsureResult> {
  const db = getDb();
  const runtime = await resolveServingRuntime(taskId);
  if (!runtime) return { ok: false, url: null, mode: 'none' };
  // Bring up the headed-browser desktop the VNC bridge attaches to (mirrors 08a),
  // and collect the direct-browser-access URLs from the live runner so the user can
  // open the app in their own browser — a fast alternative to the VNC pixel stream.
  let accessUrls: TaskAccessEndpoint[] = [];
  if (runtime.mode === 'ddev') {
    await startDdevBrowserDesktop(runtime.handle);
    await navigateDesktopToApp(runtime, taskId);
    accessUrls = await ddevAccessUrls(runtime.handle, taskId);
    // Append the database endpoint when the task opted into db access (gated inside
    // resolveDdevDbAccess on the global DB switch + the per-task flag). Independent of the
    // browser flag, so the /db-access route surfaces it even when browser access is off.
    accessUrls = accessUrls.concat(await resolveDdevDbAccess(db, taskId, runtime.handle));
  } else if (runtime.mode === 'app-runner') {
    await startAppBrowserDesktop(runtime.handle);
    await navigateDesktopToApp(runtime, taskId);
    accessUrls = await appRunnerAccessUrls(taskId, runtime.port);
  }
  return { ok: runtime.mode !== 'none', url: runtime.url, mode: runtime.mode, accessUrls };
}

/** Point the task's headed-browser desktop at the DDEV project's Mailpit UI, so the human
 *  reads the mail the app just sent without leaving the in-app browser.
 *
 *  The URL is resolved HERE rather than carried on the job, exactly like `runtime.url`: the
 *  route then cannot be used to aim the in-app browser at an arbitrary address.
 *
 *  HTTP rather than HTTPS deliberately. The traffic never leaves the runner, and while curl
 *  inside the runner trusts the mkcert cert from the system store, Chromium keeps its own —
 *  an interstitial here would land the user on a warning page instead of their mailbox.
 *
 *  DDEV only: an app-runner task has no Mailpit, and says so rather than navigating. */
async function navigateDesktopToMailpit(taskId: string): Promise<RuntimeEnsureResult> {
  const runtime = await resolveServingRuntime(taskId);
  if (!runtime) return { ok: false, url: null, mode: 'none' };
  if (runtime.mode !== 'ddev') return { ok: false, url: null, mode: runtime.mode };
  // The desktop may not be up yet (a cold runner, or one whose Chromium was reaped after
  // Gate 2 approval) — bring it up first, or the navigate has nothing to drive.
  await startDdevBrowserDesktop(runtime.handle);
  const mailpit = await ddevMailpitUrls(runtime.handle);
  if (!mailpit) return { ok: false, url: null, mode: runtime.mode };
  await navigateDesktopTo(runtime, taskId, mailpit.http);
  return { ok: true, url: mailpit.http, mode: runtime.mode };
}

export function startRuntimeEnsureWorker(): Worker<RuntimeEnsurePayload, RuntimeEnsureResult> {
  const worker = new Worker<RuntimeEnsurePayload, RuntimeEnsureResult>(
    QUEUE_NAMES.RUNTIME_ENSURE,
    async (job: Job<RuntimeEnsurePayload>) => {
      if (job.name === RUNTIME_ENSURE_JOB_NAMES.NAVIGATE_MAILPIT) {
        return navigateDesktopToMailpit(job.data.taskId);
      }
      if (job.name !== RUNTIME_ENSURE_JOB_NAMES.ENSURE) {
        throw new Error(`Unknown runtime-ensure job: ${job.name}`);
      }
      return ensureRuntimeForTask(job.data.taskId);
    },
    { connection: getBullRedis(), concurrency: 3 },
  );
  worker.on('failed', (job, err) => {
    log.warn({ jobId: job?.id, taskId: job?.data?.taskId, err }, 'runtime-ensure job failed');
  });
  return worker;
}
