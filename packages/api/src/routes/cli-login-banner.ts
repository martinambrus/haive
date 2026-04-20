import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import Docker from 'dockerode';
import { and, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  AUTH_URL_PREFIXES,
  CLI_EXEC_JOB_NAMES,
  TOKEN_PASTE_PROVIDERS,
  detectAuthResult,
  extractDeviceCode,
  extractWrappedUrl,
  logger,
  stripAnsi,
  type CliLoginCreateJobPayload,
  type CliLoginCreateResult,
  type CliProbeJobPayload,
  type CliProbeResult,
  type CliProbeTargetMode,
  type CliProviderName,
} from '@haive/shared';
import { getDb } from '../db.js';
import { verifyAccessToken } from '../auth/jwt.js';
import { ACCESS_COOKIE } from '../auth/cookies.js';
import { getCliExecQueue, getCliExecQueueEvents } from '../queues.js';
import { attachContainerStream } from './terminal.js';

const log = logger.child({ module: 'cli-login-banner-ws' });

const WS_PATH_PREFIX = '/cli-login-banner/';
const RAW_BUFFER_MAX = 64 * 1024;
const CLEAN_BUFFER_MAX = 32 * 1024;
const HEARTBEAT_MS = 15_000;
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;

const SUPPORTED_PROVIDERS: ReadonlySet<CliProviderName> = new Set<CliProviderName>([
  'claude-code',
  'codex',
]);

interface BannerSession {
  ws: WebSocket;
  userId: string;
  providerId: string;
  providerName: CliProviderName;
  containerRowId: string;
  dockerContainerId: string;
  stream: Duplex;
  docker: Docker;
  rawBuffer: string;
  cleanBuffer: string;
  authUrlSent: boolean;
  authSuccessSent: boolean;
  tokenSubmitted: boolean;
  tokenSubmittedAt: number | null;
  captureWatchdog: NodeJS.Timeout | null;
  probePending: boolean;
  createdAt: number;
  heartbeat: NodeJS.Timeout;
  timeout: NodeJS.Timeout;
  cleanedUp: boolean;
}

const CAPTURE_TIMEOUT_MS = 60_000;
const CLAUDE_OAUTH_PREFIX = 'sk-ant-oat01-';

// Observed constant across claude oauth tokens (95 body chars after the
// prefix, total 108). TTY wrapping inserts whitespace mid-token, so we scan
// through whitespace but only accept the capture when exactly BODY_LEN
// token-alphabet chars have been collected. Paragraph text like
// "Store this token securely" would exceed 95 contiguous non-ws chars only
// if the token itself didn't already stop us first.
const CLAUDE_OAUTH_BODY_LEN = 95;

function extractClaudeOauthToken(text: string): string | null {
  const start = text.indexOf(CLAUDE_OAUTH_PREFIX);
  if (start < 0) return null;
  let body = '';
  let i = start + CLAUDE_OAUTH_PREFIX.length;
  while (i < text.length && body.length < CLAUDE_OAUTH_BODY_LEN) {
    const c = text[i]!;
    if (/[A-Za-z0-9_-]/.test(c)) body += c;
    else if (!/\s/.test(c)) break;
    i++;
  }
  return body.length === CLAUDE_OAUTH_BODY_LEN ? CLAUDE_OAUTH_PREFIX + body : null;
}

export interface CliLoginBannerOpts {
  docker?: Docker;
  path?: string;
}

export function installCliLoginBannerWebSocket(
  server: Server,
  opts: CliLoginBannerOpts = {},
): void {
  const docker = opts.docker ?? new Docker();
  const pathPrefix = opts.path ?? WS_PATH_PREFIX;
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const rawUrl = req.url ?? '';
    if (!rawUrl.startsWith(pathPrefix)) return;

    void (async () => {
      try {
        log.info({ url: rawUrl }, 'banner ws upgrade received');
        const providerId = extractProviderId(rawUrl, pathPrefix);
        if (!providerId) {
          log.warn({ url: rawUrl }, 'banner ws reject: invalid providerId');
          rejectUpgrade(socket, 404, 'Not Found');
          return;
        }
        const auth = await authenticateUpgrade(req);
        if (!auth) {
          log.warn({ providerId }, 'banner ws reject: unauthorized');
          rejectUpgrade(socket, 401, 'Unauthorized');
          return;
        }
        const db = getDb();
        const provider = await db.query.cliProviders.findFirst({
          where: and(
            eq(schema.cliProviders.id, providerId),
            eq(schema.cliProviders.userId, auth.userId),
          ),
        });
        if (!provider) {
          log.warn({ providerId, userId: auth.userId }, 'banner ws reject: provider not found');
          rejectUpgrade(socket, 404, 'Not Found');
          return;
        }
        if (!SUPPORTED_PROVIDERS.has(provider.name)) {
          log.warn({ providerId, name: provider.name }, 'banner ws reject: unsupported');
          rejectUpgrade(socket, 400, 'Login Unsupported');
          return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
          runBannerSession({
            ws,
            userId: auth.userId,
            providerId: provider.id,
            providerName: provider.name,
            authMode: provider.authMode,
            docker,
          }).catch((err) => {
            log.error({ err, providerId }, 'banner session crashed');
            wsSend(ws, { type: 'error', message: errorMessage(err) });
            try {
              ws.close(1011, 'internal_error');
            } catch {
              // ignore
            }
          });
        });
      } catch (err) {
        log.error({ err, url: rawUrl }, 'upgrade failed');
        rejectUpgrade(socket, 500, 'Internal Server Error');
      }
    })();
  });

  log.info({ pathPrefix }, 'cli-login-banner websocket installed');
}

interface RunBannerOpts {
  ws: WebSocket;
  userId: string;
  providerId: string;
  providerName: CliProviderName;
  authMode: string;
  docker: Docker;
}

async function runBannerSession(opts: RunBannerOpts): Promise<void> {
  const { ws, userId, providerId, providerName, authMode, docker } = opts;

  wsSend(ws, { type: 'phase', phase: 'starting' });

  const createResult = await enqueueLoginCreate(providerId, userId);
  if (!createResult.ok || !createResult.containerRowId || !createResult.dockerContainerId) {
    wsSend(ws, {
      type: 'error',
      message: createResult.error ?? 'Failed to create login container',
    });
    try {
      ws.close(1011, 'create_failed');
    } catch {
      // ignore
    }
    return;
  }

  const dockerContainer = docker.getContainer(createResult.dockerContainerId);
  let stream: Duplex;
  try {
    stream = await attachContainerStream(docker, createResult.dockerContainerId);
  } catch (err) {
    log.error({ err, providerId }, 'attach failed');
    await teardownContainer(createResult.containerRowId, docker, createResult.dockerContainerId);
    wsSend(ws, { type: 'error', message: 'Failed to attach to login container' });
    try {
      ws.close(1011, 'attach_failed');
    } catch {
      // ignore
    }
    return;
  }

  try {
    await dockerContainer.start();
  } catch (err) {
    log.error({ err, providerId }, 'start failed');
    await teardownContainer(createResult.containerRowId, docker, createResult.dockerContainerId);
    wsSend(ws, { type: 'error', message: 'Failed to start login container' });
    try {
      ws.close(1011, 'start_failed');
    } catch {
      // ignore
    }
    return;
  }

  const session: BannerSession = {
    ws,
    userId,
    providerId,
    providerName,
    containerRowId: createResult.containerRowId,
    dockerContainerId: createResult.dockerContainerId,
    stream,
    docker,
    rawBuffer: '',
    cleanBuffer: '',
    authUrlSent: false,
    authSuccessSent: false,
    tokenSubmitted: false,
    tokenSubmittedAt: null,
    captureWatchdog: null,
    probePending: false,
    createdAt: Date.now(),
    heartbeat: setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
        } catch {
          // ignore
        }
      }
    }, HEARTBEAT_MS),
    timeout: setTimeout(() => {
      log.info({ providerId }, 'session timeout reached');
      void cleanupSession(session);
    }, SESSION_TIMEOUT_MS),
    cleanedUp: false,
  };

  wsSend(ws, {
    type: 'phase',
    phase: providerName === 'codex' ? 'awaiting-approval' : 'awaiting-token',
  });

  stream.on('data', (chunk: Buffer) => onStreamData(session, chunk, authMode));
  stream.on('end', () => {
    // Container exited. If a probe is in flight (token captured, waiting on
    // probe result) don't tear down yet — saveOauthTokenAndProbe's finally
    // will call cleanupSession once the probe returns.
    if (session.probePending) {
      log.info({ providerId }, 'stream ended while probe pending; deferring cleanup');
      return;
    }
    wsSend(ws, { type: 'exit' });
    void cleanupSession(session);
  });
  stream.on('error', (err: Error) => {
    log.warn({ err, providerId }, 'stream error');
    if (session.probePending) return;
    wsSend(ws, { type: 'error', message: err.message });
    void cleanupSession(session);
  });

  ws.on('message', async (raw) => {
    if (session.cleanedUp) return;
    const text = raw.toString();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const msg = parsed as { type?: string; token?: string };
    if (msg.type === 'token-input' && typeof msg.token === 'string' && msg.token.trim()) {
      const token = msg.token.trim();
      log.info(
        { providerId: session.providerId, tokenLength: token.length },
        'token received, writing to stream',
      );
      wsSend(ws, { type: 'phase', phase: 'submitting' });
      session.tokenSubmitted = true;
      session.tokenSubmittedAt = Date.now();
      session.authSuccessSent = false;
      session.rawBuffer = '';
      session.cleanBuffer = '';
      try {
        // Write the token first, then send Enter as a SEPARATE write on the
        // next tick so claude-code's Ink input registers the paste before it
        // sees the submit keystroke. Sending both in the same write is
        // interpreted as a single paste event and does not trigger submit.
        const wrote = session.stream.write(token);
        setTimeout(() => {
          try {
            session.stream.write('\r');
          } catch {
            // ignore
          }
        }, 150);
        log.info({ providerId: session.providerId, wrote }, 'token written');
      } catch (err) {
        log.warn({ err }, 'stream write failed');
      }
      if (session.providerName === 'claude-code') {
        startCaptureWatchdog(session);
      }
    } else if (msg.type === 'ping') {
      wsSend(ws, { type: 'pong' });
    }
  });

  ws.on('close', () => {
    void cleanupSession(session);
  });
  ws.on('error', () => {
    void cleanupSession(session);
  });
}

function onStreamData(session: BannerSession, chunk: Buffer, authMode: string): void {
  const text = chunk.toString('utf8');
  session.rawBuffer = appendCapped(session.rawBuffer, text, RAW_BUFFER_MAX);
  const clean = stripAnsi(text);
  session.cleanBuffer = appendCapped(session.cleanBuffer, clean, CLEAN_BUFFER_MAX);

  if (session.tokenSubmitted) {
    const snippet = clean.replace(/\s+/g, ' ').trim().slice(0, 300);
    if (snippet) {
      log.info({ providerId: session.providerId, snippet }, 'post-submit chunk');
    }
  }

  if (!session.authUrlSent) {
    const prefixes = AUTH_URL_PREFIXES[session.providerName] ?? ['https://'];
    const url = extractWrappedUrl(session.rawBuffer, prefixes);
    if (url) {
      session.authUrlSent = true;
      const deviceCode =
        session.providerName === 'codex' ? extractDeviceCode(session.rawBuffer) : undefined;
      log.info({ providerId: session.providerId, url: url.slice(0, 120) }, 'auth url extracted');
      wsSend(session.ws, { type: 'auth-url', url, deviceCode });
    }
  }

  const canDetect =
    session.authUrlSent &&
    !session.authSuccessSent &&
    (session.tokenSubmitted || !TOKEN_PASTE_PROVIDERS.has(session.providerName));
  if (!canDetect) return;

  if (session.providerName === 'claude-code') {
    // `claude setup-token` prints the long-lived OAuth token to stdout and
    // does NOT write ~/.claude/.credentials.json. We capture the token from
    // the output stream and persist it to cli_providers.envVars.
    const oauthToken = extractClaudeOauthToken(session.cleanBuffer);
    if (oauthToken) {
      session.authSuccessSent = true;
      session.probePending = true;
      stopCaptureWatchdog(session);
      log.info(
        {
          providerId: session.providerId,
          tokenLen: oauthToken.length,
          tokenHead: oauthToken.slice(0, 22),
          tokenTail: oauthToken.slice(-6),
        },
        'claude oauth token captured from stdout',
      );
      wsSend(session.ws, { type: 'auth-success' });
      void saveOauthTokenAndProbe(session, authMode, oauthToken);
      return;
    }
    // Only act on explicit error signals; success for claude-code requires
    // the token pattern above (other 'success' phrasings are misleading here).
    const signal = detectAuthResult(session.cleanBuffer);
    if (signal?.kind === 'error') {
      log.warn({ providerId: session.providerId, msg: signal.message }, 'auth error detected');
      stopCaptureWatchdog(session);
      wsSend(session.ws, { type: 'error', message: signal.message });
    }
    return;
  }

  const signal = detectAuthResult(session.cleanBuffer);
  if (signal?.kind === 'success') {
    session.authSuccessSent = true;
    log.info({ providerId: session.providerId }, 'auth success detected');
    wsSend(session.ws, { type: 'auth-success' });
    void runProbeAndSave(session, authMode);
  } else if (signal?.kind === 'error') {
    log.warn({ providerId: session.providerId, msg: signal.message }, 'auth error detected');
    wsSend(session.ws, { type: 'error', message: signal.message });
  }
}

/** Watchdog that fires if the claude oauth token never appears in stdout. */
function startCaptureWatchdog(session: BannerSession): void {
  if (session.captureWatchdog) return;
  session.captureWatchdog = setTimeout(() => {
    if (session.cleanedUp || session.authSuccessSent) return;
    const tail = session.cleanBuffer.replace(/\s+/g, ' ').trim().slice(-400);
    log.warn({ providerId: session.providerId, tail }, 'oauth token not captured before timeout');
    wsSend(session.ws, {
      type: 'error',
      message: `No OAuth token detected after ${Math.round(CAPTURE_TIMEOUT_MS / 1000)}s. Last output: ${tail || '(empty)'}`,
    });
    void cleanupSession(session);
  }, CAPTURE_TIMEOUT_MS);
}

function stopCaptureWatchdog(session: BannerSession): void {
  if (session.captureWatchdog) {
    clearTimeout(session.captureWatchdog);
    session.captureWatchdog = null;
  }
}

/** Persist the captured long-lived OAuth token into provider.envVars as
 *  CLAUDE_CODE_OAUTH_TOKEN, then re-run the probe so the UI reflects actual
 *  auth state. The probe spec already forwards provider.envVars to claude. */
async function saveOauthTokenAndProbe(
  session: BannerSession,
  authMode: string,
  oauthToken: string,
): Promise<void> {
  try {
    const db = getDb();
    const existing = await db.query.cliProviders.findFirst({
      where: eq(schema.cliProviders.id, session.providerId),
    });
    const merged: Record<string, string> = {
      ...(existing?.envVars ?? {}),
      CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
    };
    await db
      .update(schema.cliProviders)
      .set({ envVars: merged, updatedAt: new Date() })
      .where(eq(schema.cliProviders.id, session.providerId));
    log.info({ providerId: session.providerId }, 'oauth token saved to envVars');
    const result = await enqueueProbe(session.providerId, session.userId, authMode);
    log.info(
      {
        providerId: session.providerId,
        authStatus: result?.cli?.authStatus,
        wsOpen: session.ws.readyState === WebSocket.OPEN,
      },
      'probe returned, sending saved',
    );
    wsSend(session.ws, { type: 'saved', result });
  } catch (err) {
    log.error({ err, providerId: session.providerId }, 'save-token/probe failed');
    wsSend(session.ws, {
      type: 'error',
      message: err instanceof Error ? err.message : 'save-token/probe failed',
    });
  } finally {
    session.probePending = false;
    void cleanupSession(session);
  }
}

async function runProbeAndSave(session: BannerSession, authMode: string): Promise<void> {
  try {
    const result = await enqueueProbe(session.providerId, session.userId, authMode);
    wsSend(session.ws, { type: 'saved', result });
  } catch (err) {
    log.error({ err, providerId: session.providerId }, 'post-login probe failed');
    wsSend(session.ws, {
      type: 'error',
      message: err instanceof Error ? err.message : 'post-login probe failed',
    });
  } finally {
    void cleanupSession(session);
  }
}

async function enqueueLoginCreate(
  providerId: string,
  userId: string,
): Promise<CliLoginCreateResult> {
  const queue = getCliExecQueue();
  const events = getCliExecQueueEvents();
  const payload: CliLoginCreateJobPayload = { providerId, userId };
  const job = await queue.add(CLI_EXEC_JOB_NAMES.LOGIN_CREATE, payload, {
    removeOnComplete: true,
    removeOnFail: true,
  });
  return (await job.waitUntilFinished(events, 30_000)) as CliLoginCreateResult;
}

async function enqueueProbe(
  providerId: string,
  userId: string,
  authMode: string,
): Promise<CliProbeResult> {
  const queue = getCliExecQueue();
  const events = getCliExecQueueEvents();
  const targetMode: CliProbeTargetMode =
    authMode === 'subscription' ? 'cli' : authMode === 'api_key' ? 'api' : 'both';
  const payload: CliProbeJobPayload = { providerId, userId, targetMode };
  const job = await queue.add(CLI_EXEC_JOB_NAMES.PROBE, payload, {
    removeOnComplete: true,
    removeOnFail: true,
  });
  return (await job.waitUntilFinished(events, 30_000)) as CliProbeResult;
}

async function cleanupSession(session: BannerSession): Promise<void> {
  if (session.cleanedUp) return;
  session.cleanedUp = true;
  stopCaptureWatchdog(session);
  clearInterval(session.heartbeat);
  clearTimeout(session.timeout);
  try {
    session.stream.end();
  } catch {
    // ignore
  }
  await teardownContainer(session.containerRowId, session.docker, session.dockerContainerId);
  try {
    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.close(1000, 'session_ended');
    }
  } catch {
    // ignore
  }
}

async function teardownContainer(
  containerRowId: string,
  docker: Docker,
  dockerContainerId: string,
): Promise<void> {
  try {
    await docker.getContainer(dockerContainerId).remove({ force: true });
  } catch (err) {
    log.warn({ err, dockerContainerId }, 'docker remove failed');
  }
  const db = getDb();
  await db
    .update(schema.containers)
    .set({ status: 'destroyed', destroyedAt: new Date() })
    .where(eq(schema.containers.id, containerRowId))
    .catch((err) => {
      log.warn({ err, containerRowId }, 'container row update failed');
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

function extractProviderId(rawUrl: string, pathPrefix: string): string | null {
  const qIndex = rawUrl.indexOf('?');
  const pathOnly = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
  if (!pathOnly.startsWith(pathPrefix)) return null;
  const remainder = pathOnly.slice(pathPrefix.length);
  if (!remainder || remainder.includes('/')) return null;
  return remainder;
}

function parseCookieValue(header: string, name: string): string | null {
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
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

function appendCapped(prior: string, chunk: string, max: number): string {
  const combined = prior + chunk;
  return combined.length > max ? combined.slice(-max) : combined;
}

function wsSend(ws: WebSocket, data: Record<string, unknown>): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(data));
  } catch {
    // ignore
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
