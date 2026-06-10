import net from 'node:net';
import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { and, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { DDEV_RUNNER_VNC_PORT, ddevRunnerName, logger } from '@haive/shared';
import { getDb } from '../db.js';
import { verifyAccessToken } from '../auth/jwt.js';
import { ACCESS_COOKIE } from '../auth/cookies.js';

// Bridges the web noVNC panel to the headed-browser desktop inside a task's
// DDEV runner: RFB-over-WebSocket on the client side, raw TCP to
// <haive-ddev-taskId8>:5900 over the internal sandbox network (the api joins it
// in docker-compose). This is websockify-in-api: pipe bytes both ways. Auth is
// the same cookie-JWT upgrade check the terminal proxy uses, plus task
// ownership; the runner's VNC itself is passwordless and never host-published.

const log = logger.child({ module: 'browser-vnc-ws' });
const WS_PATH_PREFIX = '/browser-vnc/';

export interface BrowserVncWsOptions {
  path?: string;
  vncPort?: number;
}

export function installBrowserVncWebSocket(server: Server, opts: BrowserVncWsOptions = {}): void {
  const pathPrefix = opts.path ?? WS_PATH_PREFIX;
  const vncPort = opts.vncPort ?? DDEV_RUNNER_VNC_PORT;
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const rawUrl = req.url ?? '';
    if (!rawUrl.startsWith(pathPrefix)) return;

    void (async () => {
      try {
        const taskId = extractTaskId(rawUrl, pathPrefix);
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
        wss.handleUpgrade(req, socket, head, (ws) => {
          runVncBridge(ws, ddevRunnerName(taskId), vncPort, taskId);
        });
      } catch (err) {
        log.error({ err, url: rawUrl }, 'vnc upgrade handler failed');
        rejectUpgrade(socket, 500, 'Internal Server Error');
      }
    })();
  });

  log.info({ pathPrefix }, 'browser-vnc websocket installed');
}

/** Pipe RFB bytes both ways between the browser's WS and the runner's VNC TCP
 *  socket. Either side closing/erroring tears down the other. */
function runVncBridge(ws: WebSocket, host: string, port: number, taskId: string): void {
  const tcp = net.connect({ host, port });
  let closed = false;

  const teardown = (reason: string): void => {
    if (closed) return;
    closed = true;
    log.info({ taskId, host, reason }, 'vnc bridge closed');
    try {
      tcp.destroy();
    } catch {
      /* ignore */
    }
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      try {
        ws.close(1000, reason.slice(0, 100));
      } catch {
        /* ignore */
      }
    }
  };

  tcp.on('connect', () => {
    log.info({ taskId, host, port }, 'vnc bridge connected');
  });
  tcp.on('data', (chunk) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
  });
  tcp.on('error', (err) => teardown(`vnc tcp error: ${err.message}`));
  tcp.on('close', () => teardown('vnc tcp closed'));

  ws.on('message', (data) => {
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
    if (!tcp.destroyed) tcp.write(buf);
  });
  ws.on('error', (err) => teardown(`ws error: ${err.message}`));
  ws.on('close', () => teardown('ws closed'));
}

function extractTaskId(rawUrl: string, prefix: string): string | null {
  const withoutQuery = rawUrl.split('?')[0] ?? rawUrl;
  const id = withoutQuery.slice(prefix.length).replace(/\/+$/, '');
  return /^[0-9a-f-]{36}$/.test(id) ? id : null;
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
    // ignore
  }
  socket.destroy();
}
