import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { logger } from '@haive/shared';
import { getDb } from '../db.js';
import { getRedis } from '../redis.js';
import { verifyAccessToken } from '../auth/jwt.js';
import { ACCESS_COOKIE } from '../auth/cookies.js';

const log = logger.child({ module: 'cli-stream-ws' });
const WS_PATH_PREFIX = '/cli-stream/';
const STREAM_PREFIX = 'cli-stream:';
const KEEPALIVE_INTERVAL_MS = 30_000;
/** Max wait per XREAD BLOCK call. Short enough that disconnects unblock
 *  quickly, long enough to avoid command churn under idle. */
const XREAD_BLOCK_MS = 5_000;

interface CliStreamWsOptions {
  path?: string;
}

export function installCliStreamWebSocket(server: Server, opts: CliStreamWsOptions = {}): void {
  const pathPrefix = opts.path ?? WS_PATH_PREFIX;
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const rawUrl = req.url ?? '';
    if (!rawUrl.startsWith(pathPrefix)) return;

    void (async () => {
      try {
        const invocationId = extractInvocationId(rawUrl, pathPrefix);
        if (!invocationId) {
          rejectUpgrade(socket, 404, 'Not Found');
          return;
        }
        const auth = await authenticateUpgrade(req);
        if (!auth) {
          rejectUpgrade(socket, 401, 'Unauthorized');
          return;
        }
        const ownership = await verifyInvocationOwnership(invocationId, auth.userId);
        if (!ownership) {
          rejectUpgrade(socket, 404, 'Not Found');
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          runStreamSession(ws, invocationId, ownership.steerable, ownership.startedAt).catch(
            (err) => {
              log.error({ err, invocationId }, 'cli-stream session crashed');
              sendFrame(ws, { type: 'error', message: errorMessage(err) });
              try {
                ws.close(1011, 'internal_error');
              } catch {
                // ignore
              }
            },
          );
        });
      } catch (err) {
        log.error({ err, url: rawUrl }, 'cli-stream upgrade failed');
        rejectUpgrade(socket, 500, 'Internal Server Error');
      }
    })();
  });

  log.info({ pathPrefix }, 'cli-stream websocket installed');
}

interface StreamFrameOut {
  type:
    | 'connected'
    | 'output'
    | 'exit'
    | 'error'
    | 'pong'
    | 'steer_consumed'
    | 'retry'
    | 'retry_resolved';
  invocationId?: string;
  /** On the `connected` frame: whether this invocation accepts mid-run steering
   *  (drives the web steer box). */
  steerable?: boolean;
  /** On the `connected` frame: how long this stream has ALREADY been silent, so the viewer's
   *  stall clock continues an existing silence instead of restarting it at connect. */
  idleMs?: number;
  /** On every forwarded frame: how long ago it was WRITTEN. A viewer connecting mid-run replays
   *  the whole buffer from id 0, so without this the arrival of hours-old frames would restamp
   *  the stall clock as if the CLI had just spoken. Server-computed elapsed time, not a
   *  timestamp, so browser clock skew cannot make it negative. */
  ageMs?: number;
  stream?: 'stdout' | 'stderr' | 'text';
  data?: string;
  code?: number;
  message?: string;
  /** On the `steer_consumed` frame: the client steer id that was just drained at
   *  a tool-call boundary, so the viewer can tick the matching list row. */
  id?: string;
  /** On the `retry` frame: the CLI's own api_retry fields, forwarded verbatim so the viewer
   *  words the reason rather than the wire format doing it. `errorStatus` is absent when no HTTP
   *  response arrived at all — which is itself the signal that the transport failed. */
  attempt?: number;
  maxRetries?: number;
  errorStatus?: number;
  error?: string;
}

async function runStreamSession(
  ws: WebSocket,
  invocationId: string,
  steerable: boolean,
  startedAt: Date | null,
): Promise<void> {
  log.info({ invocationId }, 'cli-stream session opened');
  sendFrame(ws, {
    type: 'connected',
    invocationId,
    steerable,
    idleMs: await resolveIdleMs(invocationId, startedAt),
  });

  // Dedicated Redis connection — XREAD BLOCK monopolizes the socket.
  const redis = getRedis().duplicate();
  await redis.connect().catch(() => undefined);

  let closed = false;
  let lastId = '0';
  const streamKey = `${STREAM_PREFIX}${invocationId}`;

  const stop = () => {
    if (closed) return;
    closed = true;
    void redis.quit().catch(() => undefined);
  };

  ws.on('close', () => {
    stop();
    log.info({ invocationId }, 'cli-stream session closed');
  });
  ws.on('error', () => stop());

  ws.on('message', (raw) => {
    try {
      const parsed = JSON.parse(raw.toString()) as { type?: string };
      if (parsed.type === 'ping') sendFrame(ws, { type: 'pong' });
    } catch {
      // ignore malformed input — stream is read-only
    }
  });

  const keepalive = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.ping();
      } catch {
        // ignore
      }
    }
  }, KEEPALIVE_INTERVAL_MS);

  try {
    while (!closed && ws.readyState === WebSocket.OPEN) {
      let entries: Array<[string, string[]]> | null;
      try {
        const res = (await redis.xread(
          'BLOCK',
          XREAD_BLOCK_MS,
          'STREAMS',
          streamKey,
          lastId,
        )) as Array<[string, Array<[string, string[]]>]> | null;
        entries = res?.[0]?.[1] ?? null;
      } catch (err) {
        if (closed) break;
        log.warn({ err, invocationId }, 'xread failed');
        sendFrame(ws, { type: 'error', message: errorMessage(err) });
        break;
      }
      if (!entries) continue;
      let sawExit = false;
      for (const [id, fields] of entries) {
        lastId = id;
        const frame = fieldsToFrame(fields);
        if (!frame) continue;
        frame.ageMs = entryAgeMs(id);
        if (frame.type === 'exit') {
          sendFrame(ws, frame);
          sawExit = true;
        } else if (
          frame.type === 'output' ||
          frame.type === 'steer_consumed' ||
          frame.type === 'retry' ||
          frame.type === 'retry_resolved'
        ) {
          sendFrame(ws, frame);
        }
      }
      if (sawExit) {
        // Close gracefully — no more frames will arrive on this stream.
        try {
          ws.close(1000, 'cli_exited');
        } catch {
          // ignore
        }
        break;
      }
    }
  } finally {
    clearInterval(keepalive);
    stop();
  }
}

/** Age of one stream entry. Redis entry ids are `<ms>-<seq>`, i.e. the write time. */
function entryAgeMs(entryId: string): number {
  const ms = parseInt(entryId.split('-')[0] ?? '', 10);
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Date.now() - ms);
}

/** How long this stream has already been silent when the viewer connects.
 *
 *  Without it the viewer's stall clock would start at connect, so opening the terminal on a run
 *  that froze twenty minutes ago would show nothing for another five — which is precisely the
 *  moment the user opens it. Measured from the last stream entry (Redis entry ids ARE the write
 *  time in ms) and, for a run that never wrote a byte at all, from the invocation's own
 *  started_at. Sent as an ELAPSED duration rather than a timestamp so it is immune to clock skew
 *  between this host and the browser. */
async function resolveIdleMs(invocationId: string, startedAt: Date | null): Promise<number> {
  const key = `${STREAM_PREFIX}${invocationId}`;
  let sinceMs: number | null = null;
  try {
    const last = (await getRedis().xrevrange(key, '+', '-', 'COUNT', 1)) as Array<
      [string, string[]]
    >;
    const id = last?.[0]?.[0];
    const ms = id ? parseInt(id.split('-')[0] ?? '', 10) : NaN;
    if (Number.isFinite(ms)) sinceMs = ms;
  } catch (err) {
    log.warn({ err, invocationId }, 'idle probe failed; falling back to started_at');
  }
  if (sinceMs === null && startedAt) sinceMs = startedAt.getTime();
  if (sinceMs === null) return 0;
  return Math.max(0, Date.now() - sinceMs);
}

function fieldsToFrame(fields: string[]): StreamFrameOut | null {
  // ioredis XREAD returns each entry as [k1, v1, k2, v2, ...].
  const map = new Map<string, string>();
  for (let i = 0; i + 1 < fields.length; i += 2) {
    map.set(fields[i]!, fields[i + 1]!);
  }
  const stream = map.get('stream');
  if (stream === 'exit') {
    const code = parseInt(map.get('code') ?? '-1', 10);
    return { type: 'exit', code: Number.isFinite(code) ? code : -1 };
  }
  if (stream === 'stdout' || stream === 'stderr' || stream === 'text') {
    const data = map.get('data');
    if (typeof data === 'string') {
      return { type: 'output', stream, data };
    }
  }
  if (stream === 'steer_consumed') {
    const id = map.get('id');
    if (typeof id === 'string') return { type: 'steer_consumed', id };
  }
  if (stream === 'retry') {
    // Redis stream fields are strings; a field the CLI's event did not carry is simply absent.
    const attempt = parseInt(map.get('attempt') ?? '', 10);
    if (!Number.isFinite(attempt)) return null;
    const maxRetries = parseInt(map.get('maxRetries') ?? '', 10);
    const errorStatus = parseInt(map.get('errorStatus') ?? '', 10);
    return {
      type: 'retry',
      attempt,
      maxRetries: Number.isFinite(maxRetries) ? maxRetries : undefined,
      errorStatus: Number.isFinite(errorStatus) ? errorStatus : undefined,
      error: map.get('error'),
    };
  }
  if (stream === 'retry_resolved') return { type: 'retry_resolved' };
  return null;
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

async function verifyInvocationOwnership(
  invocationId: string,
  userId: string,
): Promise<{ taskId: string; steerable: boolean; startedAt: Date | null } | null> {
  const db = getDb();
  const inv = await db.query.cliInvocations.findFirst({
    where: eq(schema.cliInvocations.id, invocationId),
    columns: { taskId: true, steerable: true, startedAt: true },
  });
  if (!inv?.taskId) return null;
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, inv.taskId),
    columns: { userId: true },
  });
  if (!task || task.userId !== userId) return null;
  return { taskId: inv.taskId, steerable: inv.steerable, startedAt: inv.startedAt ?? null };
}

function extractInvocationId(rawUrl: string, pathPrefix: string): string | null {
  const qIdx = rawUrl.indexOf('?');
  const pathOnly = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
  if (!pathOnly.startsWith(pathPrefix)) return null;
  const remainder = pathOnly.slice(pathPrefix.length);
  if (!remainder || remainder.includes('/')) return null;
  return remainder;
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

function sendFrame(ws: WebSocket, frame: StreamFrameOut): void {
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
