import http from 'node:http';
import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import Docker from 'dockerode';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { logger } from '@haive/shared';
import { terminalClientFrameSchema } from '@haive/shared';
import type { TerminalServerFrame } from '@haive/shared';
import { getDb } from '../db.js';
import { verifyAccessToken } from '../auth/jwt.js';
import { ACCESS_COOKIE } from '../auth/cookies.js';
import { TerminalLogBuffer } from '../terminal/log-buffer.js';

const log = logger.child({ module: 'terminal-ws' });
const WS_PATH_PREFIX = '/terminal/';
const KEEPALIVE_INTERVAL_MS = 30_000;
const LOG_FLUSH_INTERVAL_MS = 2_000;
const MAX_INPUT_BYTES = 8192;
const OAUTH_BUFFER_MAX = 16_384;
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const URL_PATTERN = /https?:\/\/[^\s<>"'`\\]+/g;
const URL_FULL_PATTERN = /^https?:\/\/[^\s<>"'`\\]+$/;
const OAUTH_HINT_PATTERN = /oauth|authorize|auth\.|login\.|verification|device\/code/i;

type ContainerRow = typeof schema.containers.$inferSelect;

export interface TerminalWsOptions {
  docker?: Docker;
  path?: string;
}

export function installTerminalWebSocket(server: Server, opts: TerminalWsOptions = {}): void {
  const docker = opts.docker ?? new Docker();
  const pathPrefix = opts.path ?? WS_PATH_PREFIX;
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const rawUrl = req.url ?? '';
    if (!rawUrl.startsWith(pathPrefix)) return;

    void (async () => {
      try {
        const containerId = extractContainerId(rawUrl, pathPrefix);
        if (!containerId) {
          rejectUpgrade(socket, 404, 'Not Found');
          return;
        }

        const auth = await authenticateUpgrade(req);
        if (!auth) {
          rejectUpgrade(socket, 401, 'Unauthorized');
          return;
        }

        const container = await loadContainerForUser(containerId, auth.userId);
        if (!container) {
          rejectUpgrade(socket, 404, 'Not Found');
          return;
        }
        if (container.status !== 'running') {
          rejectUpgrade(socket, 409, 'Container not running');
          return;
        }
        if (!container.dockerContainerId) {
          rejectUpgrade(socket, 409, 'Container not bound to docker');
          return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
          runTerminalSession(ws, container, docker, auth.userId).catch((err) => {
            log.error({ err, containerId: container.id }, 'terminal session crashed');
            sendFrame(ws, { type: 'error', message: errorMessage(err) });
            ws.close(1011, 'internal_error');
          });
        });
      } catch (err) {
        log.error({ err, url: rawUrl }, 'upgrade handler failed');
        rejectUpgrade(socket, 500, 'Internal Server Error');
      }
    })();
  });

  log.info({ pathPrefix }, 'terminal websocket installed');
}

async function runTerminalSession(
  ws: WebSocket,
  container: ContainerRow,
  docker: Docker,
  userId: string,
): Promise<void> {
  const sessionId = crypto.randomUUID();
  log.info({ sessionId, containerId: container.id }, 'terminal session opened');

  const dockerContainer = docker.getContainer(container.dockerContainerId!);
  const stream = await attachContainerStream(docker, container.dockerContainerId!);

  await incrementAttached(container.id);
  sendFrame(ws, { type: 'connected', sessionId });

  const logBuffer = new TerminalLogBuffer();
  const dbSessionId = await createTerminalSession(userId, container.id).catch((err) => {
    log.warn({ err, sessionId }, 'createTerminalSession failed');
    return null;
  });

  let allowControlChars = false;
  let oauthBuffer = '';
  const seenOauthUrls = new Set<string>();

  const onStreamData = (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    logBuffer.append(text);
    if (ws.readyState === WebSocket.OPEN) {
      sendFrame(ws, { type: 'output', data: text });
      const { nextBuffer, newFrames } = scanOauthPrompts(text, oauthBuffer, seenOauthUrls);
      oauthBuffer = nextBuffer;
      for (const frame of newFrames) sendFrame(ws, frame);
    }
  };

  const onStreamEnd = () => {
    if (ws.readyState === WebSocket.OPEN) {
      sendFrame(ws, { type: 'exit', code: 0 });
      ws.close(1000, 'stream_ended');
    }
  };

  const onStreamError = (err: Error) => {
    log.warn({ err, sessionId }, 'docker stream error');
    if (ws.readyState === WebSocket.OPEN) {
      sendFrame(ws, { type: 'error', message: err.message });
      ws.close(1011, 'stream_error');
    }
  };

  stream.on('data', onStreamData);
  stream.on('end', onStreamEnd);
  stream.on('error', onStreamError);

  const keepalive = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.ping();
      } catch {
        // ignore
      }
    }
  }, KEEPALIVE_INTERVAL_MS);

  const flushLogs = async () => {
    if (!dbSessionId || !logBuffer.hasPending()) return;
    const snap = logBuffer.consume();
    await persistTerminalLog(dbSessionId, snap).catch((err) => {
      log.warn({ err, sessionId, dbSessionId }, 'persistTerminalLog failed');
    });
  };

  const flushInterval = setInterval(() => {
    void flushLogs();
  }, LOG_FLUSH_INTERVAL_MS);

  ws.on('message', async (raw) => {
    const text = raw.toString();
    if (text.length > MAX_INPUT_BYTES) {
      sendFrame(ws, { type: 'error', message: 'frame too large' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      sendFrame(ws, { type: 'error', message: 'invalid json' });
      return;
    }
    const result = terminalClientFrameSchema.safeParse(parsed);
    if (!result.success) {
      sendFrame(ws, { type: 'error', message: 'invalid frame' });
      return;
    }
    const frame = result.data;
    if (frame.type === 'input') {
      const payload = allowControlChars ? frame.data : stripControlBytes(frame.data);
      if (!payload) return;
      try {
        stream.write(payload);
      } catch (err) {
        log.warn({ err, sessionId }, 'stream write failed');
      }
    } else if (frame.type === 'resize') {
      try {
        await dockerContainer.resize({ h: frame.rows, w: frame.cols });
      } catch (err) {
        log.warn({ err, sessionId }, 'resize failed');
      }
    } else if (frame.type === 'ping') {
      sendFrame(ws, { type: 'pong' });
    } else if (frame.type === 'set_control_passthrough') {
      allowControlChars = frame.allow;
      log.info({ sessionId, allow: frame.allow }, 'terminal control passthrough toggled');
    }
  });

  ws.on('close', async () => {
    clearInterval(keepalive);
    clearInterval(flushInterval);
    stream.off('data', onStreamData);
    stream.off('end', onStreamEnd);
    stream.off('error', onStreamError);
    try {
      stream.end();
    } catch {
      // ignore
    }
    await flushLogs();
    if (dbSessionId) {
      await markTerminalSessionEnded(dbSessionId).catch((err) => {
        log.warn({ err, dbSessionId }, 'markTerminalSessionEnded failed');
      });
    }
    await decrementAttached(container.id).catch((err) => {
      log.warn({ err, containerId: container.id }, 'decrementAttached failed');
    });
    log.info({ sessionId, containerId: container.id }, 'terminal session closed');
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
    if (!user) return null;
    if (user.status !== 'active') return null;
    if (user.tokenVersion !== payload.tv) return null;
    return { userId: user.id };
  } catch {
    return null;
  }
}

async function loadContainerForUser(
  containerId: string,
  userId: string,
): Promise<ContainerRow | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.containers)
    .where(eq(schema.containers.id, containerId))
    .limit(1);
  const container = rows[0];
  if (!container) return null;

  if (container.purpose === 'cli_login') {
    if (!container.cliProviderId) return null;
    const providerRows = await db
      .select({ userId: schema.cliProviders.userId })
      .from(schema.cliProviders)
      .where(eq(schema.cliProviders.id, container.cliProviderId))
      .limit(1);
    const provider = providerRows[0];
    if (!provider || provider.userId !== userId) return null;
    return container;
  }

  if (!container.taskId) return null;
  const taskRows = await db
    .select({ userId: schema.tasks.userId })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, container.taskId))
    .limit(1);
  const task = taskRows[0];
  if (!task || task.userId !== userId) return null;
  return container;
}

async function createTerminalSession(userId: string, containerId: string): Promise<string> {
  const db = getDb();
  const rows = await db
    .insert(schema.terminalSessions)
    .values({ userId, containerId })
    .returning({ id: schema.terminalSessions.id });
  return rows[0]!.id;
}

async function persistTerminalLog(
  dbSessionId: string,
  snap: { fullLog: string; byteCount: number; truncated: boolean },
): Promise<void> {
  const db = getDb();
  await db
    .update(schema.terminalSessions)
    .set({ fullLog: snap.fullLog, byteCount: snap.byteCount, truncated: snap.truncated })
    .where(eq(schema.terminalSessions.id, dbSessionId));
}

async function markTerminalSessionEnded(dbSessionId: string): Promise<void> {
  const db = getDb();
  await db
    .update(schema.terminalSessions)
    .set({ endedAt: new Date() })
    .where(eq(schema.terminalSessions.id, dbSessionId));
}

async function incrementAttached(containerId: string): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ count: schema.containers.attachedWsCount })
    .from(schema.containers)
    .where(eq(schema.containers.id, containerId))
    .limit(1);
  const current = rows[0]?.count ?? 0;
  await db
    .update(schema.containers)
    .set({ attachedWsCount: current + 1 })
    .where(eq(schema.containers.id, containerId));
}

async function decrementAttached(containerId: string): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ count: schema.containers.attachedWsCount })
    .from(schema.containers)
    .where(eq(schema.containers.id, containerId))
    .limit(1);
  const current = rows[0]?.count ?? 0;
  await db
    .update(schema.containers)
    .set({ attachedWsCount: Math.max(0, current - 1) })
    .where(eq(schema.containers.id, containerId));
}

function extractContainerId(rawUrl: string, pathPrefix: string): string | null {
  const qIndex = rawUrl.indexOf('?');
  const pathOnly = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
  if (!pathOnly.startsWith(pathPrefix)) return null;
  const remainder = pathOnly.slice(pathPrefix.length);
  if (!remainder || remainder.includes('/')) return null;
  return remainder;
}

function parseCookieValue(header: string, name: string): string | null {
  const parts = header.split(/;\s*/);
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq);
    if (key === name) {
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

function sendFrame(ws: WebSocket, frame: TerminalServerFrame): void {
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

async function attachContainerStream(docker: Docker, dockerContainerId: string): Promise<Duplex> {
  const modemOpts = (
    docker as unknown as {
      modem: { socketPath?: string; host?: string; port?: number; protocol?: string };
    }
  ).modem;
  return new Promise<Duplex>((resolve, reject) => {
    const reqOpts: http.RequestOptions = {
      method: 'POST',
      path: `/containers/${dockerContainerId}/attach?stream=1&stdin=1&stdout=1&stderr=1&logs=1`,
      headers: {
        Host: 'docker',
        Connection: 'Upgrade',
        Upgrade: 'tcp',
        'Content-Type': 'application/vnd.docker.raw-stream',
        'Content-Length': '0',
      },
    };
    if (modemOpts.socketPath) {
      reqOpts.socketPath = modemOpts.socketPath;
    } else {
      reqOpts.host = modemOpts.host;
      reqOpts.port = modemOpts.port;
    }
    const req = http.request(reqOpts);
    req.on('upgrade', (_res, socket, head) => {
      if (head.length > 0) socket.unshift(head);
      resolve(socket as Duplex);
    });
    req.on('error', reject);
    req.on('response', (res) => {
      reject(new Error(`docker attach failed: ${res.statusCode}`));
    });
    req.end();
  });
}

export function scanOauthPrompts(
  chunk: string,
  priorBuffer: string,
  seen: Set<string>,
): { nextBuffer: string; newFrames: TerminalServerFrame[] } {
  let buffer = priorBuffer + chunk.replace(ANSI_PATTERN, '');
  if (buffer.length > OAUTH_BUFFER_MAX) {
    buffer = buffer.slice(-OAUTH_BUFFER_MAX);
  }
  const frames: TerminalServerFrame[] = [];
  const matches = buffer.match(URL_PATTERN);
  if (matches) {
    for (const raw of matches) {
      const url = raw.replace(/[.,;:)\]]+$/, '');
      if (!OAUTH_HINT_PATTERN.test(url)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      frames.push({ type: 'oauth_prompt', url, service: inferOauthService(url) });
    }
  }
  const tailIdx = buffer.search(/\s[^\s]*$/);
  const tail = tailIdx >= 0 ? buffer.slice(tailIdx + 1) : buffer;
  let nextBuffer = tail;
  if (tail && URL_FULL_PATTERN.test(tail)) {
    const tailUrl = tail.replace(/[.,;:)\]]+$/, '');
    if (seen.has(tailUrl)) nextBuffer = '';
  }
  return { nextBuffer, newFrames: frames };
}

export function stripControlBytes(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code === 0x03 || code === 0x04) continue;
    out += input[i];
  }
  return out;
}

function inferOauthService(url: string): string | undefined {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes('anthropic') || host.includes('claude')) return 'claude';
    if (host.includes('openai')) return 'codex';
    if (host.includes('google') || host.includes('gemini')) return 'gemini';
    if (host.includes('x.ai') || host.includes('grok')) return 'grok';
    if (host.includes('sourcegraph') || host.includes('ampcode')) return 'amp';
    return undefined;
  } catch {
    return undefined;
  }
}
