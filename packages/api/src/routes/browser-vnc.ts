import net from 'node:net';
import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { and, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  DDEV_RUNNER_VNC_PORT,
  ddevRunnerName,
  appRunnerName,
  logger,
  RUNTIME_ENSURE_JOB_NAMES,
  type RuntimeEnsurePayload,
  type RuntimeEnsureResult,
} from '@haive/shared';
import { getDb } from '../db.js';
import { getRuntimeEnsureQueue, getRuntimeEnsureQueueEvents } from '../queues.js';
import { verifyAccessToken } from '../auth/jwt.js';
import { ACCESS_COOKIE } from '../auth/cookies.js';

// Bridges the web noVNC panel to the headed-browser desktop inside a task's
// runtime container: RFB-over-WebSocket on the client side, raw TCP to
// <container>:5900 over the internal sandbox network (the api joins it in
// docker-compose). The target is the DDEV runner for DDEV projects, else the
// non-DDEV app-runner — resolved from the task's env-template containerTool.
// This is websockify-in-api: pipe bytes both ways. Auth is the same cookie-JWT
// upgrade check the terminal proxy uses, plus task ownership; the desktop's VNC
// itself is passwordless and never host-published.

const log = logger.child({ module: 'browser-vnc-ws' });
const WS_PATH_PREFIX = '/browser-vnc/';
/** Bounded wait for the worker to bring the runtime + browser desktop up before
 *  bridging — sized to cover a DDEV cold boot (image already built) so the WS stays
 *  pending through the boot and bridges in ONE shot. At 30s it timed out mid-cold-
 *  boot → 503 → noVNC "Connection closed (1006)" console-error spam while the panel
 *  re-tried each cycle. waitUntilFinished returns as soon as the ensure job
 *  completes, so a warm/fast boot still bridges quickly; a boot slower than this
 *  still falls back to the panel's reconnect. */
const VNC_ENSURE_TIMEOUT_MS = 180_000;

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
        // Fast path: if the desktop VNC is ALREADY reachable, bridge straight to it. Do NOT run
        // the ensure job on a reconnect — it re-navigates Chrome to the app root (page.goto),
        // which resets an in-progress session (e.g. an install wizard) each time the bridge
        // re-establishes. The VNC bridge only needs the desktop reachable, not re-navigated.
        let desktopHost = await reachableDesktopHost(taskId, vncPort);
        if (!desktopHost) {
          // Desktop is down (a worker-boot reap / restart / first open). The api can't start it
          // (spawning task containers is worker-only), so enqueue a worker ensure job and await
          // it; it cold-boots the runtime AND navigates Chrome to the app on this first load. On
          // timeout/failure reject so the panel's retry reconnects once the boot finishes.
          const ready = await ensureRuntimeUp(taskId, auth.userId);
          if (!ready) {
            rejectUpgrade(socket, 503, 'Runtime starting');
            return;
          }
          desktopHost = await resolveDesktopContainer(taskId, vncPort);
        }
        const host = desktopHost;
        wss.handleUpgrade(req, socket, head, (ws) => {
          runVncBridge(ws, host, vncPort, taskId);
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

  // Keepalive: a VNC session parked on a STATIC screen (a Gate-2 review, an idle desktop) sends
  // no framebuffer data, so the socket goes idle and is dropped abnormally (close 1006, no
  // handshake) after ~20s — the panel then sees a drop and reconnect-loops (observed on
  // ec9371b3: "ws closed" every ~21-24s). A periodic WS ping keeps the socket active (the
  // browser auto-pongs), so an idle-but-alive session stays connected. Cleared on teardown.
  const keepAlive = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, 15_000);

  const teardown = (reason: string): void => {
    if (closed) return;
    closed = true;
    clearInterval(keepAlive);
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

/** Probe whether <host>:<port> accepts a TCP connection within `timeoutMs`. */
function probeTcp(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => finish(true));
    sock.on('timeout', () => finish(false));
    sock.on('error', () => finish(false));
  });
}

/** The container hosting the task's live browser desktop. The DDEV runner wins
 *  whenever it's up — 08a / Gate 2 use it whenever `.ddev` is present, including
 *  an add-DDEV task whose env template was non-DDEV — else the non-DDEV
 *  app-runner. Resolved by probing the VNC port so it mirrors the runtime the
 *  workflow actually selected, not just the template value. */
async function resolveDesktopContainer(taskId: string, port: number): Promise<string> {
  const ddev = ddevRunnerName(taskId);
  if (await probeTcp(ddev, port)) return ddev;
  return appRunnerName(taskId);
}

/** The desktop container whose VNC port is ALREADY reachable, or null if neither is. Lets a VNC
 *  upgrade bridge straight to a live desktop and SKIP the ensure job — which re-navigates Chrome
 *  to the app root (page.goto) and would reset an in-progress session (e.g. an install wizard) on
 *  every reconnect. Only a genuinely-down desktop pays for the ensure (which navigates on first
 *  load). Probes both runtime kinds; the ddev runner wins when both answer (mirrors resolve). */
async function reachableDesktopHost(taskId: string, port: number): Promise<string | null> {
  const ddev = ddevRunnerName(taskId);
  if (await probeTcp(ddev, port)) return ddev;
  const app = appRunnerName(taskId);
  if (await probeTcp(app, port)) return app;
  return null;
}

/** Ask the worker to ensure the task's app + browser desktop are up, awaiting the
 *  result with a bounded timeout. Coalesced per task (jobId = ensure-<taskId>) so
 *  repeated panel (re)connects share one ensure and never race two cold boots of
 *  the same runner. Returns false on timeout/failure — the ensure job keeps
 *  running, so a later retry connects once it completes. */
async function ensureRuntimeUp(taskId: string, userId: string): Promise<boolean> {
  try {
    const job = await getRuntimeEnsureQueue().add(
      RUNTIME_ENSURE_JOB_NAMES.ENSURE,
      { taskId, userId } satisfies RuntimeEnsurePayload,
      { jobId: `ensure-${taskId}`, removeOnComplete: true, removeOnFail: true },
    );
    const result = (await job.waitUntilFinished(
      getRuntimeEnsureQueueEvents(),
      VNC_ENSURE_TIMEOUT_MS,
    )) as RuntimeEnsureResult;
    return result?.ok === true;
  } catch (err) {
    log.warn({ taskId, err }, 'runtime ensure for VNC did not complete in time');
    return false;
  }
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
