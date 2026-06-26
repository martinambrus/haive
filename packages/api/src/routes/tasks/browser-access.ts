import { readFile } from 'node:fs/promises';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  CONFIG_KEYS,
  configService,
  RUNTIME_ENSURE_JOB_NAMES,
  IDE_ENSURE_JOB_NAMES,
  type RuntimeEnsurePayload,
  type RuntimeEnsureResult,
  type IdeEnsurePayload,
  type IdeEnsureResult,
  type TaskAccessEndpoint,
} from '@haive/shared';
import { getDb } from '../../db.js';
import { HttpError, type AppEnv } from '../../context.js';
import {
  getRuntimeEnsureQueue,
  getRuntimeEnsureQueueEvents,
  getIdeEnsureQueue,
  getIdeEnsureQueueEvents,
} from '../../queues.js';

// Direct browser access: the user opens a task's running app in their OWN browser
// (localhost + *.ddev.site URLs) instead of the VNC pixel stream. The worker
// publishes the runner's port + computes the URLs; these routes surface them, with
// the SAME ensure-and-await handshake the VNC bridge uses (the api can't start a
// runtime itself). Auth + task ownership come from the parent taskRoutes
// (requireAuth + userId), mirroring files.ts / steps.ts.

export const browserAccessRoutes = new Hono<AppEnv>();

/** rootCA.pem of the shared DDEV CA, mounted read-only into the api container
 *  (docker-compose.yml). The worker generates it once on boot. */
const DDEV_CA_PATH = process.env.DDEV_CA_PATH || '/var/lib/haive/ddev-ca/rootCA.pem';
/** Bound wait for a runtime cold boot, sized like the VNC ensure so a slow DDEV
 *  start bridges in one shot rather than erroring early. */
const ACCESS_ENSURE_TIMEOUT_MS = 180_000;
/** Bound wait for the IDE container to come up. A first-ever launch also pulls the
 *  code-server image; if that runs past this, the await times out → 202 pending and
 *  the Editor tab retries (the coalesced ensure job keeps running). */
const IDE_ENSURE_TIMEOUT_MS = 180_000;

async function requireOwnedTask(taskId: string, userId: string): Promise<void> {
  const db = getDb();
  const row = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, taskId), eq(schema.tasks.userId, userId)),
    columns: { id: true },
  });
  if (!row) throw new HttpError(404, 'Task not found');
}

/** Direct-access URLs for a task: ensures the runtime is up (same coalesced ensure
 *  job as the VNC panel — shared jobId) and returns the URLs the worker computed
 *  from the live runner. Short-circuits when the feature is off so a disabled
 *  install never cold-boots a runtime just to answer. `pending` (202) means the
 *  ensure is still running — the client should retry. */
browserAccessRoutes.get('/:id/access-urls', async (c) => {
  const userId = c.get('userId');
  const taskId = c.req.param('id');
  await requireOwnedTask(taskId, userId);

  const enabled = await configService.getBoolean(CONFIG_KEYS.BROWSER_DIRECT_ACCESS, true);
  if (!enabled) return c.json({ enabled: false, accessUrls: [] as TaskAccessEndpoint[] });

  try {
    const job = await getRuntimeEnsureQueue().add(
      RUNTIME_ENSURE_JOB_NAMES.ENSURE,
      { taskId, userId } satisfies RuntimeEnsurePayload,
      { jobId: `ensure-${taskId}`, removeOnComplete: true, removeOnFail: true },
    );
    const result = (await job.waitUntilFinished(
      getRuntimeEnsureQueueEvents(),
      ACCESS_ENSURE_TIMEOUT_MS,
    )) as RuntimeEnsureResult;
    return c.json({ enabled: true, accessUrls: result?.accessUrls ?? [] });
  } catch {
    return c.json({ enabled: true, accessUrls: [] as TaskAccessEndpoint[], pending: true }, 202);
  }
});

/** Ensure the task's browser IDE (code-server) is up before the Editor tab loads
 *  it in an iframe. Same coalesced ensure-and-await handshake as the VNC panel
 *  (shared jobId `ensure-ide-<taskId>`). 202 `pending` means the ensure (incl. a
 *  cold image pull) is still running — the client retries. 409 means the IDE can't
 *  start for this task (no editable repo). Short-circuits when the feature is off. */
browserAccessRoutes.post('/:id/ensure-ide', async (c) => {
  const userId = c.get('userId');
  const taskId = c.req.param('id');
  await requireOwnedTask(taskId, userId);

  const enabled = await configService.getBoolean(CONFIG_KEYS.IDE_ENABLED, true);
  if (!enabled) return c.json({ enabled: false, ready: false });

  try {
    const job = await getIdeEnsureQueue().add(
      IDE_ENSURE_JOB_NAMES.ENSURE,
      { taskId, userId } satisfies IdeEnsurePayload,
      { jobId: `ensure-ide-${taskId}`, removeOnComplete: true, removeOnFail: true },
    );
    const result = (await job.waitUntilFinished(
      getIdeEnsureQueueEvents(),
      IDE_ENSURE_TIMEOUT_MS,
    )) as IdeEnsureResult;
    if (result?.ok) return c.json({ enabled: true, ready: true });
    return c.json({ enabled: true, ready: false, reason: result?.reason ?? 'unavailable' }, 409);
  } catch {
    return c.json({ enabled: true, ready: false, pending: true }, 202);
  }
});

/** Serve the shared DDEV CA so the user installs it once and trusts every task's
 *  https://<name>.ddev.site. 404 until the worker has generated it. */
browserAccessRoutes.get('/:id/ddev-ca', async (c) => {
  const userId = c.get('userId');
  const taskId = c.req.param('id');
  await requireOwnedTask(taskId, userId);
  let pem: string;
  try {
    pem = await readFile(DDEV_CA_PATH, 'utf8');
  } catch {
    throw new HttpError(404, 'DDEV CA not available yet');
  }
  c.header('Content-Type', 'application/x-pem-file');
  c.header('Content-Disposition', 'attachment; filename="haive-ddev-rootCA.pem"');
  c.header('Cache-Control', 'no-store');
  return c.body(pem);
});
