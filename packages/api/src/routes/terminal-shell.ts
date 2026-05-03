import { randomUUID } from 'node:crypto';
import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  TERMINAL_CTL_CHANNEL_PREFIX,
  TERMINAL_IN_CHANNEL_PREFIX,
  TERMINAL_OUT_CHANNEL_PREFIX,
  TERMINAL_REPLY_CHANNEL_PREFIX,
  TERMINAL_REQUEST_CHANNEL,
  TERMINAL_SESSION_PREFIX,
  logger,
  terminalClientFrameSchema,
  type TerminalOpenResult,
} from '@haive/shared';
import { getDb } from '../db.js';
import { getRedis } from '../redis.js';
import { verifyAccessToken } from '../auth/jwt.js';
import { ACCESS_COOKIE } from '../auth/cookies.js';

const log = logger.child({ module: 'terminal-shell-ws' });
const WS_PATH_PREFIX = '/terminal-shell/';
const KEEPALIVE_INTERVAL_MS = 30_000;
const OPEN_REPLY_TIMEOUT_MS = 15_000;

interface TerminalShellWsOptions {
  path?: string;
}

/** Per-(user, task, provider) interactive shell WS bridge.
 *  URL: /terminal-shell/{taskId}/{cliProviderId}.
 *  API holds the WS but no docker socket — it forwards bytes to the worker
 *  via Redis pub/sub. Worker spawns the container + PTY and replies with a
 *  sessionId. Refcount is owned by API alone (HINCRBY on attach/detach);
 *  worker only writes container metadata. */
export function installTerminalShellWebSocket(
  server: Server,
  opts: TerminalShellWsOptions = {},
): void {
  const pathPrefix = opts.path ?? WS_PATH_PREFIX;
  const wss = new WebSocketServer({ noServer: true });

  // Boot-time refcount reset. On API restart, any prior session entries in
  // redis carry refcount values that referenced the dead process's WS
  // instances. Without this reset the reaper would skip those entries
  // forever (refcount > 0 short-circuit) and the containers would survive
  // until the next manual cleanup. We're the only API instance per
  // deployment, so it is safe to zero everything at boot.
  void resetStaleRefcounts().catch((err) => log.warn({ err }, 'boot refcount reset failed'));

  server.on('upgrade', (req, socket, head) => {
    const rawUrl = req.url ?? '';
    if (!rawUrl.startsWith(pathPrefix)) return;

    void (async () => {
      try {
        const ids = extractIds(rawUrl, pathPrefix);
        if (!ids) {
          rejectUpgrade(socket, 404, 'Not Found');
          return;
        }
        const auth = await authenticateUpgrade(req);
        if (!auth) {
          rejectUpgrade(socket, 401, 'Unauthorized');
          return;
        }
        const ownership = await verifyOwnership(ids.taskId, ids.cliProviderId, auth.userId);
        if (!ownership) {
          rejectUpgrade(socket, 404, 'Not Found');
          return;
        }
        if (ownership.taskTerminal === false) {
          rejectUpgrade(socket, 409, `Task is ${ownership.taskStatus} - terminal disabled`);
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          runShellSession(ws, auth.userId, ids.taskId, ids.cliProviderId).catch((err) => {
            log.error(
              { err, taskId: ids.taskId, cliProviderId: ids.cliProviderId },
              'shell session crashed',
            );
            try {
              ws.close(1011, 'internal_error');
            } catch {
              // ignore
            }
          });
        });
      } catch (err) {
        log.error({ err, url: rawUrl }, 'shell upgrade failed');
        rejectUpgrade(socket, 500, 'Internal Server Error');
      }
    })();
  });

  log.info({ pathPrefix }, 'terminal-shell websocket installed');
}

export async function runShellSession(
  ws: WebSocket,
  userId: string,
  taskId: string,
  cliProviderId: string,
): Promise<void> {
  const correlationId = randomUUID();
  const replyChannel = `${TERMINAL_REPLY_CHANNEL_PREFIX}${correlationId}`;

  // Subscriber connection — ioredis subscribe-mode monopolises the socket so
  // we can't share with the publisher. duplicate() inherits config.
  const subscriber = getRedis().duplicate();
  // Defensive error listener. ioredis emits 'error' on the instance for
  // socket-level failures; without a listener Node crashes the process. The
  // refcount fix triggers this because cleanup() can call subscriber.quit()
  // while openSession's subscribe() is still pending — the pending subscribe
  // rejects with "Connection is closed" and propagates as unhandled.
  subscriber.on('error', (err) => {
    log.debug({ err, correlationId }, 'subscriber error');
  });
  await subscriber.connect().catch(() => undefined);
  const publisher = getRedis();

  // Refcount/cleanup state — set up BEFORE the openSession await. React
  // StrictMode mounts the InteractiveShell effect twice; the first mount's
  // cleanup fires `ws.close()` while we're still awaiting the worker reply.
  // If we registered ws.on('close') only AFTER that await (the previous
  // implementation), the close event slipped past with no listener — and
  // then we still hincrby +1 when the reply arrived. Net: orphan +1 per
  // StrictMode cycle, refcount never returns to 0, reaper never kills the
  // container.
  let refcountHeld = false;
  let registryKey: string | null = null;
  let outChannel: string | null = null;
  let keepalive: NodeJS.Timeout | null = null;
  let cleanupRan = false;
  let sessionId: string | null = null;

  const cleanup = async () => {
    if (cleanupRan) return;
    cleanupRan = true;
    if (keepalive) clearInterval(keepalive);
    if (outChannel) await subscriber.unsubscribe(outChannel).catch(() => undefined);
    await subscriber.quit().catch(() => undefined);
    if (refcountHeld && registryKey) {
      refcountHeld = false;
      const newCount = await publisher.hincrby(registryKey, 'refcount', -1);
      if (newCount < 0) await publisher.hset(registryKey, 'refcount', '0');
      await publisher.hset(registryKey, 'lastSeenAt', String(Date.now()));
      log.info(
        { sessionId, taskId, cliProviderId, refcountAfter: Math.max(0, newCount) },
        'shell session closed',
      );
    } else {
      log.info(
        { taskId, cliProviderId, sessionId, correlationId },
        'shell ws closed before refcount acquired (likely StrictMode double-mount)',
      );
    }
  };

  ws.on('close', () => {
    void cleanup();
  });
  ws.on('error', (err) => {
    log.warn({ err, sessionId }, 'ws error');
  });

  const reply = await openSession({
    subscriber,
    publisher,
    correlationId,
    replyChannel,
    userId,
    taskId,
    cliProviderId,
  }).catch((err) => {
    log.warn({ err, taskId, cliProviderId, correlationId }, 'open-session request failed');
    return { ok: false as const, error: errorMessage(err) };
  });

  if (!reply.ok) {
    if (!cleanupRan) sendJson(ws, { type: 'error', message: reply.error });
    try {
      ws.close(1011, 'open_failed');
    } catch {
      // ignore
    }
    await cleanup();
    return;
  }

  sessionId = reply.sessionId;
  const containerName = reply.containerName;
  const shell = reply.shell;
  const inChannel = `${TERMINAL_IN_CHANNEL_PREFIX}${sessionId}`;
  const ctlChannel = `${TERMINAL_CTL_CHANNEL_PREFIX}${sessionId}`;
  outChannel = `${TERMINAL_OUT_CHANNEL_PREFIX}${sessionId}`;
  registryKey = `${TERMINAL_SESSION_PREFIX}${userId}:${taskId}:${cliProviderId}`;

  if (cleanupRan || ws.readyState !== WebSocket.OPEN) {
    // ws.close() fired during openSession await. cleanup() already ran with
    // refcountHeld=false → no -1 was issued. Don't take a refcount now.
    log.info(
      { taskId, cliProviderId, sessionId, correlationId },
      'shell ws closed during openSession — skipping refcount',
    );
    if (!cleanupRan) await cleanup();
    return;
  }

  // Refcount += 1. Reaper only kills container when refcount==0 AND idle > grace.
  await publisher.hincrby(registryKey, 'refcount', 1);
  refcountHeld = true;
  await publisher.hset(registryKey, 'lastSeenAt', String(Date.now()));

  // Race window: ws.close() may have fired while hincrby was in flight.
  // If cleanup already ran, refcountHeld was false at that time → no -1
  // was issued for our +1. Undo it now. (Both commands are issued on the
  // same publisher; redis preserves submission order so this nets to 0.)
  if (cleanupRan) {
    refcountHeld = false;
    const undoCount = await publisher.hincrby(registryKey, 'refcount', -1).catch(() => null);
    if (undoCount !== null && undoCount < 0) {
      await publisher.hset(registryKey, 'refcount', '0').catch(() => undefined);
    }
    await publisher.hset(registryKey, 'lastSeenAt', String(Date.now())).catch(() => undefined);
    log.info(
      { sessionId, taskId, cliProviderId, refcountAfter: Math.max(0, undoCount ?? 0) },
      'shell session closed during attach — refcount undone',
    );
    return;
  }

  await subscriber.subscribe(outChannel);
  if (cleanupRan) return;

  subscriber.on('message', (channel, raw) => {
    if (channel !== outChannel) return;
    if (ws.readyState !== WebSocket.OPEN) return;
    // Worker publishes raw PTY bytes (utf8 string). One special JSON message:
    // {"type":"exit"} signals the PTY ended (process exit / container gone).
    if (raw.startsWith('{"type":"exit"')) {
      sendJson(ws, { type: 'exit' });
      try {
        ws.close(1000, 'pty_ended');
      } catch {
        // ignore
      }
      return;
    }
    sendJson(ws, { type: 'output', data: raw });
  });

  sendJson(ws, { type: 'connected', sessionId, containerName, shell });

  keepalive = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.ping();
      } catch {
        // ignore
      }
    }
  }, KEEPALIVE_INTERVAL_MS);

  ws.on('message', async (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      sendJson(ws, { type: 'error', message: 'invalid json' });
      return;
    }
    const result = terminalClientFrameSchema.safeParse(parsed);
    if (!result.success) {
      sendJson(ws, { type: 'error', message: 'invalid frame' });
      return;
    }
    const frame = result.data;
    if (frame.type === 'input') {
      // Input bytes go raw on the in-channel; worker writes them to the PTY
      // stdin. No control-byte stripping — the user wants Ctrl+C to work.
      await publisher.publish(inChannel, frame.data).catch((err) => {
        log.warn({ err, sessionId }, 'publish input failed');
      });
    } else if (frame.type === 'resize') {
      await publisher
        .publish(ctlChannel, JSON.stringify({ type: 'resize', cols: frame.cols, rows: frame.rows }))
        .catch((err) => {
          log.warn({ err, sessionId }, 'publish resize failed');
        });
    } else if (frame.type === 'ping') {
      sendJson(ws, { type: 'pong' });
    }
    // set_control_passthrough is a no-op here — shell terminal always passes
    // control chars through (it's the whole point).
  });
}

interface OpenSessionArgs {
  subscriber: ReturnType<typeof getRedis>;
  publisher: ReturnType<typeof getRedis>;
  correlationId: string;
  replyChannel: string;
  userId: string;
  taskId: string;
  cliProviderId: string;
}

function openSession(args: OpenSessionArgs): Promise<TerminalOpenResult> {
  const { subscriber, publisher, correlationId, replyChannel } = args;
  return new Promise<TerminalOpenResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('worker did not reply within timeout'));
    }, OPEN_REPLY_TIMEOUT_MS);

    const onMessage = (channel: string, raw: string) => {
      if (channel !== replyChannel) return;
      cleanup();
      try {
        const parsed = JSON.parse(raw) as TerminalOpenResult;
        resolve(parsed);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      subscriber.off('message', onMessage);
      void subscriber.unsubscribe(replyChannel).catch(() => undefined);
    };

    subscriber.on('message', onMessage);
    subscriber
      .subscribe(replyChannel)
      .then(() =>
        publisher.publish(
          TERMINAL_REQUEST_CHANNEL,
          JSON.stringify({
            op: 'open',
            correlationId,
            userId: args.userId,
            taskId: args.taskId,
            cliProviderId: args.cliProviderId,
          }),
        ),
      )
      .catch((err) => {
        // Either subscribe or publish failed (most commonly: subscriber.quit()
        // was called from runShellSession's cleanup because the WS died
        // during the open window). The timer may have rejected first; reject
        // is idempotent so the second call is a no-op. This catch must exist
        // — Node v24 exits the process on unhandled rejections by default.
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

async function authenticateUpgrade(req: IncomingMessage): Promise<{ userId: string } | null> {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  const token = parseCookieValue(cookieHeader, ACCESS_COOKIE);
  if (!token) return null;
  try {
    const payload = await verifyAccessToken(token);
    const db = getDb();
    const user = await db.query.users.findFirst({
      where: eq(schema.users.id, payload.sub),
      columns: { id: true, status: true, tokenVersion: true },
    });
    if (!user || user.status !== 'active' || user.tokenVersion !== payload.tv) return null;
    return { userId: user.id };
  } catch {
    return null;
  }
}

interface OwnershipResult {
  taskTerminal: boolean;
  taskStatus: string;
}

async function verifyOwnership(
  taskId: string,
  cliProviderId: string,
  userId: string,
): Promise<OwnershipResult | null> {
  const db = getDb();
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { userId: true, status: true },
  });
  if (!task || task.userId !== userId) return null;
  const provider = await db.query.cliProviders.findFirst({
    where: eq(schema.cliProviders.id, cliProviderId),
    columns: { userId: true },
  });
  if (!provider || provider.userId !== userId) return null;
  const terminalDisabled =
    task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled';
  return { taskTerminal: !terminalDisabled, taskStatus: task.status };
}

export function extractIds(
  rawUrl: string,
  pathPrefix: string,
): { taskId: string; cliProviderId: string } | null {
  const qIdx = rawUrl.indexOf('?');
  const pathOnly = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
  if (!pathOnly.startsWith(pathPrefix)) return null;
  const remainder = pathOnly.slice(pathPrefix.length);
  const parts = remainder.split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  const [taskId, cliProviderId] = parts as [string, string];
  if (!taskId || !cliProviderId) return null;
  return { taskId, cliProviderId };
}

function parseCookieValue(header: string, name: string): string | null {
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq) === name) {
      return decodeURIComponent(part.slice(eq + 1));
    }
  }
  return null;
}

function rejectUpgrade(socket: Duplex, status: number, statusText: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\n\r\n`);
  } catch {
    // ignore
  }
  socket.destroy();
}

function sendJson(ws: WebSocket, frame: Record<string, unknown>): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    // ignore
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export async function resetStaleRefcounts(redis: Redis = getRedis()): Promise<void> {
  let cursor = '0';
  let cleared = 0;
  do {
    const [next, keys] = await redis.scan(
      cursor,
      'MATCH',
      `${TERMINAL_SESSION_PREFIX}*`,
      'COUNT',
      '100',
    );
    cursor = next;
    for (const key of keys) {
      const current = await redis.hget(key, 'refcount').catch(() => null);
      if (current && current !== '0') {
        await redis.hset(key, 'refcount', '0').catch(() => undefined);
        cleared += 1;
      }
    }
  } while (cursor !== '0');
  if (cleared > 0) {
    log.info({ cleared }, 'cleared stale terminal session refcounts on boot');
  }
}
