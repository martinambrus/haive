import { Hono, type Context } from 'hono';
import {
  CONFIG_KEYS,
  configService,
  DDEV_CONTROL_JOB_NAMES,
  type DdevControlPayload,
  type DdevControlResult,
} from '@haive/shared';
import { verifyRagToken } from '@haive/shared/rag';
import { HttpError, type AppEnv } from '../context.js';
import { getDdevControlQueue, getDdevControlQueueEvents } from '../queues.js';

// Sandbox-facing control surface for the ddev-control MCP. The task's AI CLI (via the
// bind-mounted /haive/haive-ddev-mcp.mjs) calls these with a task-scoped Bearer token —
// NOT a user session (the sandbox has none), mirroring /rag. We verify the token,
// extract the taskId it is scoped to, then DELEGATE the actual `ddev` command to the
// worker (docker access is worker-only) and return its output. The token grants control
// only over its own task's runner, so there is no cross-task escalation.

export const ddevControlRoutes = new Hono<AppEnv>();

/** api-side await budgets. `restart` can trigger a cold-boot recovery in the worker, so
 *  it is generous; status/logs are quick reads. */
const AWAIT_TIMEOUTS: Record<DdevControlPayload['action'], number> = {
  status: 60_000,
  logs: 140_000,
  restart: 1_200_000,
};

/** Verify the Bearer token (HMAC, same as /rag) and return the taskId it is scoped to,
 *  or throw 401. */
function taskIdFromBearer(authHeader: string | undefined): string {
  const secret = process.env.CONFIG_ENCRYPTION_KEY;
  if (!secret) throw new HttpError(500, 'server misconfigured: CONFIG_ENCRYPTION_KEY unset');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const verified = token ? verifyRagToken(token, secret) : null;
  if (!verified) throw new HttpError(401, 'invalid or missing ddev token');
  return verified.taskId;
}

/** Enqueue the ddev-control job on the worker and await its result. Gated on the global
 *  kill-switch (defense in depth — the MCP isn't injected when it's off). */
async function runAction(
  taskId: string,
  action: DdevControlPayload['action'],
  extra: { service?: string; tail?: number } = {},
): Promise<DdevControlResult> {
  const enabled = await configService.getBoolean(CONFIG_KEYS.DDEV_CONTROL_MCP_ENABLED, true);
  if (!enabled) throw new HttpError(403, 'ddev-control is disabled');
  const job = await getDdevControlQueue().add(
    DDEV_CONTROL_JOB_NAMES.RUN,
    { taskId, action, ...extra } satisfies DdevControlPayload,
    { removeOnComplete: true, removeOnFail: true },
  );
  return (await job.waitUntilFinished(
    getDdevControlQueueEvents(),
    AWAIT_TIMEOUTS[action],
  )) as DdevControlResult;
}

function respond(c: Context<AppEnv>, r: DdevControlResult) {
  return c.json({ ok: r.ok, output: r.output, ...(r.error ? { error: r.error } : {}) });
}

ddevControlRoutes.post('/status', async (c) => {
  const taskId = taskIdFromBearer(c.req.header('Authorization'));
  return respond(c, await runAction(taskId, 'status'));
});

ddevControlRoutes.post('/logs', async (c) => {
  const taskId = taskIdFromBearer(c.req.header('Authorization'));
  const body = (await c.req.json().catch(() => null)) as {
    service?: unknown;
    tail?: unknown;
  } | null;
  const service = typeof body?.service === 'string' ? body.service : undefined;
  const tail =
    typeof body?.tail === 'number' && Number.isInteger(body.tail) && body.tail > 0
      ? Math.min(body.tail, 2000)
      : undefined;
  return respond(c, await runAction(taskId, 'logs', { service, tail }));
});

ddevControlRoutes.post('/restart', async (c) => {
  const taskId = taskIdFromBearer(c.req.header('Authorization'));
  return respond(c, await runAction(taskId, 'restart'));
});
