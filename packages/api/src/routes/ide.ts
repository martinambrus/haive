import net from 'node:net';
import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Hono, type Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  IDE_ENSURE_JOB_NAMES,
  IDE_INTERNAL_PORT,
  IDE_SESSION_PREFIX,
  ideRunnerName,
  ideSessionKey,
  logger,
  type IdeEnsurePayload,
  type IdeEnsureResult,
} from '@haive/shared';
import { getDb } from '../db.js';
import { getRedis } from '../redis.js';
import { getIdeEnsureQueue, getIdeEnsureQueueEvents } from '../queues.js';
import { verifyAccessToken } from '../auth/jwt.js';
import { ACCESS_COOKIE } from '../auth/cookies.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';

// Reverse-proxies the in-task code-server editor through the authenticated api,
// exactly mirroring how the terminal/VNC routes proxy into per-task containers.
// Two transports:
//   - HTTP (this Hono router): the editor SPA + its assets. The iframe loads
//     /ide/<taskId>/ and code-server emits relative links (it has no base-path),
//     so every request lands under /ide/<taskId>/; we strip that prefix and
//     forward to <ide-container>:8080 on the sandbox network.
//   - WebSocket (installIdeWebSocket): code-server's live session socket, bridged
//     as a raw upgrade replay. Connection open/close drives the Redis refcount the
//     worker's idle reaper reads to grace-stop the container after the tab closes.
// code-server runs `--auth none`; the api proxy (cookie-JWT + task ownership) is
// the only auth boundary, and the container is never host-published.

const log = logger.child({ module: 'ide-proxy' });
const WS_PATH_PREFIX = '/ide/';
const UUID_RE = /^[0-9a-f-]{36}$/;
const IDE_ENSURE_TIMEOUT_MS = 180_000;
// Response headers that must not be forwarded verbatim. content-encoding/length
// are dropped because undici's fetch auto-decodes the upstream body (we also force
// identity upstream); the rest are connection-scoped.
const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
];

// ---- HTTP reverse proxy ---------------------------------------------------

export const ideRoutes = new Hono<AppEnv>();
ideRoutes.use('*', requireAuth);

async function requireOwnedTask(taskId: string, userId: string): Promise<void> {
  const db = getDb();
  const row = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, taskId), eq(schema.tasks.userId, userId)),
    columns: { id: true },
  });
  if (!row) throw new HttpError(404, 'Task not found');
}

async function proxyHttp(c: Context<AppEnv>): Promise<Response> {
  const userId = c.get('userId');
  const taskId = c.req.param('id');
  if (!taskId || !UUID_RE.test(taskId)) throw new HttpError(404, 'Not found');
  await requireOwnedTask(taskId, userId);

  const url = new URL(c.req.url);
  const prefix = `/ide/${taskId}`;
  const rest = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : '/';
  const upstreamUrl = `http://${ideRunnerName(taskId)}:${IDE_INTERNAL_PORT}${rest || '/'}${url.search}`;

  const headers = new Headers(c.req.raw.headers);
  headers.delete('host');
  // Force identity so undici's auto-decompression can't desync content-encoding.
  headers.set('accept-encoding', 'identity');

  let resp: Response;
  try {
    resp = await fetch(upstreamUrl, {
      method: c.req.method,
      headers,
      body: c.req.method === 'GET' || c.req.method === 'HEAD' ? undefined : c.req.raw.body,
      redirect: 'manual',
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
  } catch (err) {
    log.warn(
      { taskId, err: err instanceof Error ? err.message : String(err) },
      'ide http proxy upstream failed',
    );
    return new Response('IDE not reachable', { status: 502 });
  }

  const outHeaders = new Headers(resp.headers);
  for (const h of HOP_BY_HOP) outHeaders.delete(h);
  // Re-prefix a root-absolute redirect so it stays inside the proxy namespace.
  const loc = outHeaders.get('location');
  if (loc && loc.startsWith('/') && !loc.startsWith('//')) {
    outHeaders.set('location', `/ide/${taskId}${loc}`);
  }
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: outHeaders,
  });
}

ideRoutes.all('/:id', (c) => proxyHttp(c));
ideRoutes.all('/:id/*', (c) => proxyHttp(c));

// ---- WebSocket reverse proxy (raw upgrade replay) -------------------------

export function installIdeWebSocket(server: Server): void {
  void resetStaleIdeRefcounts().catch((err) => log.warn({ err }, 'boot ide refcount reset failed'));

  server.on('upgrade', (req, socket, head) => {
    const rawUrl = req.url ?? '';
    if (!rawUrl.startsWith(WS_PATH_PREFIX)) return;

    void (async () => {
      try {
        const taskId = extractIdeTaskId(rawUrl);
        if (!taskId) {
          rejectUpgrade(socket, 404, 'Not Found');
          return;
        }
        const auth = await authenticateUpgrade(req);
        if (!auth) {
          rejectUpgrade(socket, 401, 'Unauthorized');
          return;
        }
        const owned = await taskBelongsToUser(taskId, auth.userId);
        if (!owned) {
          rejectUpgrade(socket, 404, 'Not Found');
          return;
        }
        // Bring the IDE container up before bridging (worker-only). Coalesced per
        // task; on timeout reject so the editor's reconnect retries once a slow
        // first-launch image pull finishes in the background.
        const ready = await ensureIdeUp(taskId, auth.userId);
        if (!ready) {
          rejectUpgrade(socket, 503, 'IDE starting');
          return;
        }
        proxyWsUpgrade(req, socket, head, taskId);
      } catch (err) {
        log.error({ err, url: rawUrl }, 'ide upgrade handler failed');
        rejectUpgrade(socket, 500, 'Internal Server Error');
      }
    })();
  });

  log.info({ pathPrefix: WS_PATH_PREFIX }, 'ide websocket installed');
}

/** Replay the client's upgrade request to the code-server container with the
 *  /ide/<taskId> prefix stripped, then pipe bytes both ways. Holds a refcount on
 *  the task's IDE session for the life of the connection so the idle reaper never
 *  grace-stops a container with a live editor attached. */
function proxyWsUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, taskId: string): void {
  const prefix = `/ide/${taskId}`;
  const rawUrl = req.url ?? '';
  const strippedPath = rawUrl.slice(prefix.length) || '/';
  const host = ideRunnerName(taskId);
  const upstream = net.connect({ host, port: IDE_INTERNAL_PORT });
  let closed = false;
  let counted = false;

  const teardown = (reason: string): void => {
    if (closed) return;
    closed = true;
    if (counted) void releaseIdeSession(taskId);
    try {
      upstream.destroy();
    } catch {
      /* ignore */
    }
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
    log.info({ taskId, reason }, 'ide ws bridge closed');
  };

  upstream.on('connect', () => {
    const lines = [`${req.method ?? 'GET'} ${strippedPath} HTTP/1.1`];
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.toLowerCase() === 'host') {
        lines.push(`Host: ${host}:${IDE_INTERNAL_PORT}`);
        continue;
      }
      if (Array.isArray(v)) {
        for (const vv of v) lines.push(`${k}: ${vv}`);
      } else if (v !== undefined) {
        lines.push(`${k}: ${v}`);
      }
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
    counted = true;
    void acquireIdeSession(taskId);
    log.info({ taskId, host }, 'ide ws bridge connected');
  });
  upstream.on('error', (err) => teardown(`upstream error: ${err.message}`));
  upstream.on('close', () => teardown('upstream closed'));
  socket.on('error', (err) => teardown(`socket error: ${err.message}`));
  socket.on('close', () => teardown('socket closed'));
}

// ---- IDE session registry (refcount + lastSeenAt) -------------------------

async function acquireIdeSession(taskId: string): Promise<void> {
  const key = ideSessionKey(taskId);
  const redis = getRedis();
  await redis.hincrby(key, 'refcount', 1);
  await redis.hset(key, 'lastSeenAt', String(Date.now()));
}

async function releaseIdeSession(taskId: string): Promise<void> {
  const key = ideSessionKey(taskId);
  const redis = getRedis();
  const n = await redis.hincrby(key, 'refcount', -1);
  if (n < 0) await redis.hset(key, 'refcount', '0');
  await redis.hset(key, 'lastSeenAt', String(Date.now()));
}

/** On api boot, zero every IDE session refcount. A prior api pid that died holding
 *  open editor connections left refcount>0 with no live socket; without this the
 *  reaper's refcount>0 short-circuit would pin those containers forever. Mirrors
 *  the terminal-shell boot reset. lastSeenAt is left as-is so a genuinely idle
 *  session still reaps on schedule. */
export async function resetStaleIdeRefcounts(): Promise<void> {
  const redis = getRedis();
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(
      cursor,
      'MATCH',
      `${IDE_SESSION_PREFIX}*`,
      'COUNT',
      '100',
    );
    cursor = next;
    for (const key of keys) {
      await redis.hset(key, 'refcount', '0');
    }
  } while (cursor !== '0');
}

// ---- ensure + auth helpers (mirror browser-vnc) ---------------------------

async function ensureIdeUp(taskId: string, userId: string): Promise<boolean> {
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
    return result?.ok === true;
  } catch (err) {
    log.warn({ taskId, err }, 'ide ensure for ws did not complete in time');
    return false;
  }
}

function extractIdeTaskId(rawUrl: string): string | null {
  const withoutQuery = rawUrl.split('?')[0] ?? rawUrl;
  const afterPrefix = withoutQuery.slice(WS_PATH_PREFIX.length);
  const id = (afterPrefix.split('/')[0] ?? '').replace(/\/+$/, '');
  return UUID_RE.test(id) ? id : null;
}

async function taskBelongsToUser(taskId: string, userId: string): Promise<boolean> {
  const db = getDb();
  const row = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, taskId), eq(schema.tasks.userId, userId)),
    columns: { id: true },
  });
  return row !== undefined && row !== null;
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
    if (!user) return null;
    if (user.status !== 'active') return null;
    if (user.tokenVersion !== payload.tv) return null;
    return { userId: user.id };
  } catch {
    return null;
  }
}

function parseCookieValue(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function rejectUpgrade(socket: Duplex, status: number, statusText: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\n\r\n`);
  } catch {
    /* ignore */
  }
  socket.destroy();
}
