import net from 'node:net';
import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Hono, type Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  CONFIG_KEYS,
  configService,
  IDE_ENSURE_JOB_NAMES,
  IDE_INTERNAL_PORT,
  IDE_SESSION_PREFIX,
  ideRunnerName,
  ideSessionKey,
  logger,
  repoIdeSessionId,
  type IdeEnsurePayload,
  type IdeEnsureResult,
} from '@haive/shared';
import { getDb } from '../db.js';
import { getRedis } from '../redis.js';
import { getIdeEnsureQueue, getIdeEnsureQueueEvents } from '../queues.js';
import { authenticateUpgrade, rejectUpgrade } from '../lib/upgrade-auth.js';
import { guardUpgradeSocket } from '../lib/upgrade-errors.js';
import type { UpgradeSession } from '../lib/user-sockets.js';
import {
  isSessionSetCookie,
  withoutSessionCookies,
  withoutSessionSetCookies,
} from '../auth/cookies.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';
import { isForeignOrigin, trustedOrigins } from '../lib/request-origin.js';
import { isCanonicalUuid } from '../lib/uuid.js';

// Reverse-proxies task and repository code-server editors through the authenticated api,
// exactly mirroring how the terminal/VNC routes proxy into per-task containers.
// Two transports:
//   - HTTP (this Hono router): the editor SPA + its assets. The iframe loads
//     /ide/<taskId>/ and code-server emits relative links (it has no base-path),
//     so every request lands under /ide/<taskId>/; we strip that prefix and
//     forward to <ide-container>:8080 on the sandbox network.
//   - WebSocket (installIdeWebSocket): code-server's live session socket, bridged
//     as a raw upgrade replay. Connection open/close drives the Redis refcount the
//     worker's idle reaper reads to grace-stop the container after the tab closes.
// code-server runs `--auth none`; the api proxy (cookie-JWT + task/repo ownership) is
// the only auth boundary, and the container is never host-published.

const log = logger.child({ module: 'ide-proxy' });
const WS_PATH_PREFIX = '/ide/';
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

// Both transports cross the same boundary. Connection can nominate arbitrary
// headers, so collect its tokens before removing it. No client forwarding metadata
// is trusted; fetch derives the HTTP Host, and the upgrade path sets Host/Origin.
function upstreamRequestHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  const connectionHeaders = (headers.get('connection') ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  for (const name of [
    'host',
    'authorization',
    'connection',
    'keep-alive',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'forwarded',
    ...connectionHeaders,
  ]) {
    headers.delete(name);
  }
  for (const name of [...headers.keys()]) {
    if (name.startsWith('proxy-') || name.startsWith('x-forwarded-')) headers.delete(name);
  }
  // code-server runs repository-controlled code, so the Haive session must not reach it.
  const keptCookie = withoutSessionCookies(headers.get('cookie') ?? '');
  if (keptCookie === null) headers.delete('cookie');
  else headers.set('cookie', keptCookie);
  return headers;
}

// ---- HTTP reverse proxy ---------------------------------------------------

export const ideRoutes = new Hono<AppEnv>();
ideRoutes.use('*', requireAuth);

interface IdeTarget {
  sessionId: string;
  prefix: string;
  payload: IdeEnsurePayload;
}

function ideTarget(id: string, userId: string, repository = false): IdeTarget {
  return {
    sessionId: repository ? repoIdeSessionId(id) : id,
    prefix: repository ? `/ide/repos/${id}` : `/ide/${id}`,
    payload: repository ? { repositoryId: id, userId } : { taskId: id, userId },
  };
}

async function targetBelongsToUser(target: IdeTarget): Promise<boolean> {
  const db = getDb();
  const { userId, repositoryId, taskId } = target.payload;
  const row = repositoryId
    ? await db.query.repositories.findFirst({
        where: and(
          eq(schema.repositories.id, repositoryId),
          eq(schema.repositories.userId, userId),
        ),
        columns: { id: true },
      })
    : await db.query.tasks.findFirst({
        where: and(eq(schema.tasks.id, taskId!), eq(schema.tasks.userId, userId)),
        columns: { id: true },
      });
  return row != null;
}

// Starting an editor is an explicit POST. Loading its HTML/assets only proxies an existing one.
export const repoIdeAccessRoutes = new Hono<AppEnv>();
repoIdeAccessRoutes.post('/:id/ensure-ide', requireAuth, async (c) => {
  const id = c.req.param('id');
  if (!isCanonicalUuid(id)) throw new HttpError(404, 'Repository not found');
  const target = ideTarget(id, c.get('userId'), true);
  if (!(await targetBelongsToUser(target))) throw new HttpError(404, 'Repository not found');
  const enabled = await configService.getBoolean(CONFIG_KEYS.IDE_ENABLED, true);
  if (!enabled) return c.json({ enabled: false, ready: false });
  try {
    const result = await ensureIde(target);
    if (result?.ok) return c.json({ enabled: true, ready: true });
    return c.json({ enabled: true, ready: false, reason: result?.reason ?? 'unavailable' }, 409);
  } catch {
    return c.json({ enabled: true, ready: false, pending: true }, 202);
  }
});

async function proxyHttp(c: Context<AppEnv>, repository = false): Promise<Response> {
  const userId = c.get('userId');
  const taskId = c.req.param('id');
  if (!taskId || !isCanonicalUuid(taskId)) throw new HttpError(404, 'Not found');
  const target = ideTarget(taskId, userId, repository);
  if (!(await targetBelongsToUser(target))) throw new HttpError(404, 'Not found');

  const url = new URL(c.req.url);
  const prefix = target.prefix;
  const rest = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : '/';
  const upstreamUrl = `http://${ideRunnerName(target.sessionId)}:${IDE_INTERNAL_PORT}${rest || '/'}${url.search}`;

  const headers = upstreamRequestHeaders(c.req.raw.headers);
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
  withoutSessionSetCookies(outHeaders);
  // Re-prefix a root-absolute redirect so it stays inside the proxy namespace.
  const loc = outHeaders.get('location');
  if (loc && loc.startsWith('/') && !loc.startsWith('//')) {
    outHeaders.set('location', `${prefix}${loc}`);
  }
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: outHeaders,
  });
}

ideRoutes.all('/repos/:id', (c) => proxyHttp(c, true));
ideRoutes.all('/repos/:id/*', (c) => proxyHttp(c, true));
ideRoutes.all('/:id', (c) => proxyHttp(c));
ideRoutes.all('/:id/*', (c) => proxyHttp(c));

// ---- WebSocket reverse proxy (raw upgrade replay) -------------------------

export function installIdeWebSocket(server: Server): void {
  void resetStaleIdeRefcounts().catch((err) => log.warn({ err }, 'boot ide refcount reset failed'));

  server.on('upgrade', (req, socket, head) => {
    guardUpgradeSocket(socket);
    const rawUrl = req.url ?? '';
    if (!rawUrl.startsWith(WS_PATH_PREFIX)) return;
    if (isForeignOrigin(req.headers.origin, req.headers.host, trustedOrigins())) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }

    void (async () => {
      try {
        const parsed = extractIdeTarget(rawUrl);
        if (!parsed) {
          rejectUpgrade(socket, 404, 'Not Found');
          return;
        }
        const auth = await authenticateUpgrade(req);
        if (!auth) {
          rejectUpgrade(socket, 401, 'Unauthorized');
          return;
        }
        const target = ideTarget(parsed.id, auth.userId, parsed.repository);
        const owned = await targetBelongsToUser(target);
        if (!owned) {
          rejectUpgrade(socket, 404, 'Not Found');
          return;
        }
        if (auth.session.revoked) return;
        // Bring the IDE container up before bridging (worker-only). Coalesced per
        // task; on timeout reject so the editor's reconnect retries once a slow
        // first-launch image pull finishes in the background.
        const ready = await ensureIde(target)
          .then((r) => r?.ok === true)
          .catch((err) => {
            log.warn(
              { sessionId: target.sessionId, err },
              'ide ensure for ws did not complete in time',
            );
            return false;
          });
        if (!ready) {
          rejectUpgrade(socket, 503, 'IDE starting');
          return;
        }
        if (auth.session.revoked) return;
        proxyWsUpgrade(req, socket, head, target, auth.session);
      } catch (err) {
        log.error({ err, url: rawUrl }, 'ide upgrade handler failed');
        rejectUpgrade(socket, 500, 'Internal Server Error');
      }
    })();
  });

  log.info({ pathPrefix: WS_PATH_PREFIX }, 'ide websocket installed');
}

const MAX_UPGRADE_RESPONSE_HEAD = 64 * 1024;

function relayUpgradeResponse(
  upstream: net.Socket,
  socket: Duplex,
  teardown: (reason: string) => void,
  session: UpgradeSession,
): void {
  let buffered = Buffer.alloc(0);
  const onData = (chunk: Buffer): void => {
    buffered = Buffer.concat([buffered, chunk]);
    const end = buffered.indexOf('\r\n\r\n');
    if (end === -1) {
      if (buffered.length > MAX_UPGRADE_RESPONSE_HEAD) teardown('upgrade response head too large');
      return;
    }
    upstream.off('data', onData);
    const head = buffered
      .subarray(0, end)
      .toString('latin1')
      .split('\r\n')
      .filter((line) => {
        const colon = line.indexOf(':');
        const isSetCookie =
          colon !== -1 && line.slice(0, colon).trim().toLowerCase() === 'set-cookie';
        return !(isSetCookie && isSessionSetCookie(line.slice(colon + 1)));
      })
      .join('\r\n');
    if (/^HTTP\/1\.[01] 101(?: |$)/.test(head.split('\r\n')[0] ?? '') && !session.acceptRaw()) {
      teardown('session revoked');
      return;
    }
    socket.write(Buffer.concat([Buffer.from(head, 'latin1'), buffered.subarray(end)]));
    buffered = Buffer.alloc(0);
    upstream.pipe(socket);
  };
  upstream.on('data', onData);
}

/** Replay the client's upgrade request to the code-server container with the
 *  /ide/<taskId> prefix stripped, then pipe bytes both ways. Holds a refcount on
 *  the task's IDE session for the life of the connection so the idle reaper never
 *  grace-stops a container with a live editor attached. */
function proxyWsUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  target: IdeTarget,
  session: UpgradeSession,
): void {
  const taskId = target.sessionId;
  const prefix = target.prefix;
  const rawUrl = req.url ?? '';
  const strippedPath = rawUrl.slice(prefix.length) || '/';
  const host = ideRunnerName(taskId);
  const upstream = net.connect({ host, port: IDE_INTERNAL_PORT });
  let closed = false;
  let counted = false;

  const teardown = (reason: string, closeSocket = true): void => {
    if (closed) return;
    closed = true;
    if (counted) void releaseIdeSession(taskId);
    try {
      upstream.destroy();
    } catch {
      /* ignore */
    }
    try {
      if (closeSocket) socket.destroy();
    } catch {
      /* ignore */
    }
    log.info({ taskId, reason }, 'ide ws bridge closed');
  };

  session.onRevoke(() => teardown('session revoked', false));

  upstream.on('connect', () => {
    if (session.revoked) return;
    const lines = [`${req.method ?? 'GET'} ${strippedPath} HTTP/1.1`];
    const incoming = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) incoming.append(name, item);
      } else if (value !== undefined) {
        incoming.set(name, value);
      }
    }
    const headers = upstreamRequestHeaders(incoming);
    lines.push(`Host: ${host}:${IDE_INTERNAL_PORT}`);
    // The handler already checked the browser's Origin. code-server requires
    // the upstream Origin to match its Host, which is the container here.
    headers.set('origin', `http://${host}:${IDE_INTERNAL_PORT}`);
    headers.set('connection', 'Upgrade');
    headers.set('upgrade', 'websocket');
    for (const [name, value] of headers) lines.push(`${name}: ${value}`);
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head && head.length) upstream.write(head);
    relayUpgradeResponse(upstream, socket, teardown, session);
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

async function ensureIde(target: IdeTarget): Promise<IdeEnsureResult> {
  const job = await getIdeEnsureQueue().add(IDE_ENSURE_JOB_NAMES.ENSURE, target.payload, {
    jobId: `ensure-ide-${target.sessionId}`,
    removeOnComplete: true,
    removeOnFail: true,
  });
  return (await job.waitUntilFinished(
    getIdeEnsureQueueEvents(),
    IDE_ENSURE_TIMEOUT_MS,
  )) as IdeEnsureResult;
}

function extractIdeTarget(rawUrl: string): { id: string; repository: boolean } | null {
  const withoutQuery = rawUrl.split('?')[0] ?? rawUrl;
  const parts = withoutQuery.slice(WS_PATH_PREFIX.length).split('/');
  const repository = parts[0] === 'repos';
  const id = parts[repository ? 1 : 0] ?? '';
  return isCanonicalUuid(id) ? { id, repository } : null;
}
