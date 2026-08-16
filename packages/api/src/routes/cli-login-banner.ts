import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { Job } from 'bullmq';
import Docker from 'dockerode';
import { and, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  AUTH_URL_PREFIXES,
  CLI_EXEC_JOB_NAMES,
  TOKEN_PASTE_PROVIDERS,
  computeKeyFingerprint,
  detectAuthResult,
  envelopeEncrypt,
  extractDeviceCode,
  extractGeminiAuthUrl,
  extractWrappedUrl,
  logger,
  secretsService,
  stripAnsi,
  type CliLoginCreateJobPayload,
  type CliLoginCreateResult,
  type CliProbeJobPayload,
  type CliProbeResult,
  type CliProviderName,
} from '@haive/shared';
import { getDb } from '../db.js';
import { verifyAccessToken } from '../auth/jwt.js';
import { ACCESS_COOKIE } from '../auth/cookies.js';
import { getCliExecQueue, getCliExecQueueEvents, getUsagePollQueue } from '../queues.js';
import { attachContainerStream } from './terminal.js';
import { execInContainer } from './docker-exec.js';

const log = logger.child({ module: 'cli-login-banner-ws' });

const WS_PATH_PREFIX = '/cli-login-banner/';
const RAW_BUFFER_MAX = 64 * 1024;
const CLEAN_BUFFER_MAX = 32 * 1024;
const HEARTBEAT_MS = 15_000;
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;
// How often the queued dialog is told what it is waiting for. Two queue reads per tick, both
// O(queue length) against Redis, so keep it lazy — the numbers move on the scale of a CLI run
// finishing, not of a spinner.
const QUEUE_REPORT_MS = 2_000;
// Bound on the post-cancel drain only. Reached only when the worker had already picked the job
// up, so it is waiting on a container create that is seconds away, not on a queue.
const CANCEL_DRAIN_MS = 2 * 60 * 1000;

/** Raised when the user closes the dialog while a cli-exec job is still queued. Distinct from a
 *  failure so the caller can tear down quietly instead of reporting an error to a dead socket. */
class LoginCancelled extends Error {
  constructor() {
    super('login cancelled');
    this.name = 'LoginCancelled';
  }
}

/** Lets an await race the socket closing. `signal` never resolves — it only rejects — so
 *  `Promise.race([work, abort.signal])` yields the work result or throws LoginCancelled. */
interface AbortHandle {
  aborted: boolean;
  signal: Promise<never>;
  fire: () => void;
}

function createAbortHandle(): AbortHandle {
  let reject!: (err: Error) => void;
  const signal = new Promise<never>((_, rej) => {
    reject = rej;
  });
  // Marks the rejection handled at creation time: nothing awaits `signal` until a race starts,
  // and an unobserved rejection in between would surface as an unhandled rejection warning.
  signal.catch(() => {});
  const handle: AbortHandle = {
    aborted: false,
    signal,
    fire: () => {
      if (handle.aborted) return;
      handle.aborted = true;
      reject(new LoginCancelled());
    },
  };
  return handle;
}

/** How many queued cli-exec jobs are served before `jobId`.
 *
 *  BullMQ pushes a new job onto the HEAD of the wait list (`addStandardJob-9.lua`: LPUSH unless
 *  lifo) and the worker takes from the TAIL (`fetchNextJob.lua`: RPOPLPUSH), so the list is
 *  FIFO with the oldest job last. `getWaiting` hands back LRANGE order, head first, which means
 *  the number of jobs ahead of ours is its distance from the END of that array — the opposite
 *  of the index it is tempting to read. Returns null when the job is not waiting any more.
 *
 *  Prioritized jobs are deliberately not counted: moveToActive drains the plain wait list before
 *  it looks at the prioritized set, so an agent invocation never delays a login. */
export function waitAheadCount(waitingJobIds: readonly string[], jobId: string): number | null {
  const idx = waitingJobIds.indexOf(jobId);
  return idx === -1 ? null : waitingJobIds.length - 1 - idx;
}

const SUPPORTED_PROVIDERS: ReadonlySet<CliProviderName> = new Set<CliProviderName>([
  'claude-code',
  'codex',
  'amp',
  'antigravity',
  // grok: device-code flow, the same shape as codex — it prints a URL plus a
  // short code and polls for approval, so it needs neither a paste-back nor a
  // creds-file poller. Deliberately absent from TOKEN_PASTE_PROVIDERS and from
  // TERMINAL_LOGIN_PROVIDERS for that reason.
  'grok',
]);

// Providers whose login is driven by the user inside an interactive terminal
// (the login modal renders the CLI's TUI in xterm) rather than URL-extraction +
// paste. For these we stream raw container output to the client, forward
// keystrokes to stdin, and detect success purely via the creds-file poller.
// agy's auth is a full-screen TUI whose URL can't be machine-extracted and its
// -p mode caps the auth wait at ~30s, so the user must drive it directly.
const TERMINAL_LOGIN_PROVIDERS: ReadonlySet<CliProviderName> = new Set<CliProviderName>([
  'antigravity',
]);

// Providers whose login is an OAuth DEVICE-CODE flow: the CLI prints an
// authorization URL plus a short user code, the user approves in a browser, and
// the CLI polls for the grant. Nothing is pasted back, so the modal shows the
// code and reports 'awaiting-approval', and success is read from the CLI's own
// stdout rather than from a creds-file poller.
//   - codex: `codex login --device-auth`
//   - grok:  `grok login --device-auth`  ->
//     https://accounts.x.ai/oauth2/device?user_code=XXXX-XXXX, then "Signed in as ..."
//     (both verified against the shipped binary; the code matches the shared
//     DEVICE_CODE_PATTERN and the success line matches detectAuthResult).
const DEVICE_CODE_PROVIDERS: ReadonlySet<CliProviderName> = new Set<CliProviderName>([
  'codex',
  'grok',
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
  /** Carried so the post-login probe can be awaited and cancelled on the same terms as the
   *  container create — it queues for the same slots and can wait just as long. */
  abort: AbortHandle;
  pending: { job: Job | null };
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
  credsPoller: NodeJS.Timeout | null;
  // Content signature (md5) of agy's OAuth token file captured on the poller's
  // first read, so a pre-existing token isn't mistaken for a fresh sign-in.
  credsBaseline: string | null;
  urlDebugged: boolean;
  firstChunkLogged: boolean;
  menuAdvanceTimer: NodeJS.Timeout | null;
  menuAdvanceCount: number;
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
            docker,
          }).catch((err) => {
            // The user closing the dialog unwinds the session through the same throw path as a
            // real failure. It is not one, and the socket it would report to is already gone.
            if (err instanceof LoginCancelled) {
              log.info({ providerId }, 'login dialog closed by the user');
              return;
            }
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
  docker: Docker;
}

async function runBannerSession(opts: RunBannerOpts): Promise<void> {
  const { ws, userId, providerId, providerName, docker } = opts;

  // Registered BEFORE the first await, not with the session's other listeners further down: the
  // session object does not exist until the container is attached, so until now a dialog closed
  // mid-queue was simply unobserved. The 30s ttl used to bound the damage; without it a job the
  // user gave up on would go on to build a container nobody is attached to.
  const abort = createAbortHandle();
  const pending: { job: Job | null } = { job: null };
  ws.on('close', () => {
    abort.fire();
    void discardPendingLogin(pending, docker);
  });

  wsSend(ws, { type: 'phase', phase: 'starting' });

  const createResult = await enqueueLoginCreate(providerId, userId, abort, ws, pending);
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
    abort,
    pending,
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
    credsPoller: null,
    credsBaseline: null,
    urlDebugged: false,
    firstChunkLogged: false,
    menuAdvanceTimer: null,
    menuAdvanceCount: 0,
  };

  wsSend(ws, {
    type: 'phase',
    // Device-code providers wait on a browser approval; everything else waits on
    // a token/code the user pastes back into the modal.
    phase: DEVICE_CODE_PROVIDERS.has(providerName) ? 'awaiting-approval' : 'awaiting-token',
  });

  if (TERMINAL_LOGIN_PROVIDERS.has(providerName)) {
    // Start polling for the creds file now — success is the token write, not
    // anything parsed from the stream.
    startAntigravityCredsPoller(session);
    // agy's TUI only renders (and prints the OAuth URL) once its PTY has a real
    // winsize. The container is created Tty:true with NO size, so until a resize
    // arrives agy sits at a 0x0 PTY and emits nothing — which is exactly why the
    // field-only flow hung at "Waiting for sign-in URL...". Push a fixed sane
    // size right after start, and once more after agy has opened the PTY, so the
    // hidden flow works without any client xterm attached. (When the debug xterm
    // IS shown it will also send its own resize frames; these are harmless.)
    const sizeTerminalPty = () => {
      session.docker
        .getContainer(session.dockerContainerId)
        .resize({ h: 40, w: 120 })
        .catch((err: unknown) => {
          log.warn({ err, providerId: session.providerId }, 'initial pty resize failed');
        });
    };
    setTimeout(sizeTerminalPty, 250);
    setTimeout(sizeTerminalPty, 1200);
  }

  stream.on('data', (chunk: Buffer) => onStreamData(session, chunk));
  stream.on('end', () => {
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
    const msg = parsed as {
      type?: string;
      token?: string;
      data?: string;
      rows?: number;
      cols?: number;
    };
    if (msg.type === 'input' && typeof msg.data === 'string') {
      // Terminal-login keystrokes (incl. the pasted auth code + Enter) -> stdin.
      try {
        session.stream.write(msg.data);
      } catch (err) {
        log.warn({ err, providerId: session.providerId }, 'terminal input write failed');
      }
      return;
    }
    if (msg.type === 'resize' && typeof msg.rows === 'number' && typeof msg.cols === 'number') {
      try {
        await session.docker.getContainer(session.dockerContainerId).resize({
          h: msg.rows,
          w: msg.cols,
        });
      } catch (err) {
        log.warn({ err, providerId: session.providerId }, 'terminal resize failed');
      }
      return;
    }
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
      } else if (session.providerName === 'gemini') {
        // Gemini reads the authorization code from stdin via readline; after
        // the write, poll the container filesystem for the creds file it
        // writes on success (either legacy oauth_creds.json or the current
        // encrypted gemini-credentials.json).
        startGeminiCredsPoller(session);
      } else if (session.providerName === 'amp') {
        // Amp reads the paste-back code from stdin and, on success, writes
        // the API key into $HOME/.config/amp/settings.json. Poll for that
        // file — the REPL's post-paste stdout is unreliable.
        startAmpCredsPoller(session);
      } else if (session.providerName === 'antigravity') {
        // agy reads the pasted authorization code on stdin and writes its OAuth
        // token to ~/.gemini/antigravity-cli/antigravity-oauth-token on success.
        // Poll for that file — the post-paste agy TUI output is unreliable.
        startAntigravityCredsPoller(session);
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

function onStreamData(session: BannerSession, chunk: Buffer): void {
  const text = chunk.toString('utf8');

  if (TERMINAL_LOGIN_PROVIDERS.has(session.providerName)) {
    // Interactive login (agy). DEBUG: raw output is forwarded so the modal can
    // render agy's TUI in an xterm (visibility into the auth-method menu / URL).
    // In parallel we still try to extract the OAuth URL (clickable link + field
    // UX) and auto-advance the menu. We skip detectAuthResult (agy's TUI text
    // would false-positive); success is the creds-file poller.
    if (!session.firstChunkLogged) {
      session.firstChunkLogged = true;
      log.info(
        { providerId: session.providerId, len: text.length },
        'antigravity first stream chunk',
      );
    }
    wsSend(session.ws, { type: 'output', data: text });
    if (!session.authUrlSent) {
      session.rawBuffer = appendCapped(session.rawBuffer, text, RAW_BUFFER_MAX);
      const prefixes = AUTH_URL_PREFIXES[session.providerName] ?? ['https://'];
      const url = extractWrappedUrl(session.rawBuffer, prefixes);
      if (url && url.length > (prefixes[0]?.length ?? 0) + 8) {
        session.authUrlSent = true;
        log.info(
          { providerId: session.providerId, urlLen: url.length, urlHead: url.slice(0, 80) },
          'antigravity auth url extracted',
        );
        wsSend(session.ws, { type: 'auth-url', url });
      } else {
        if (!session.urlDebugged && session.rawBuffer.includes('oauth2')) {
          // Could not extract despite the URL being on screen — log how it renders
          // so the extractor can be refined (one-shot per session).
          session.urlDebugged = true;
          const clean = stripAnsi(session.rawBuffer).replace(/\s+/g, ' ');
          const idx = clean.indexOf('oauth2');
          log.info(
            {
              providerId: session.providerId,
              sample: clean.slice(Math.max(0, idx - 30), idx + 220),
            },
            'antigravity oauth2 present but URL not extracted (debug sample)',
          );
        }
        // agy's first-run TUI shows an auth-method menu (Google Account
        // highlighted) that needs a single Enter before it prints the OAuth URL.
        // The login modal is field-based — it sends no keystrokes — so without
        // this the session sits forever at "Waiting for sign-in URL...". When
        // agy's output pauses (it is idle at a prompt) and no URL has appeared
        // yet, auto-send Enter to advance. Debouncing means we only press Enter
        // while agy is waiting, never mid-render; and we stop the moment the URL
        // shows (authUrlSent / oauth2 in buffer), so we never submit an empty
        // line at the later "paste code" prompt. Capped to avoid runaway.
        if (session.menuAdvanceTimer) clearTimeout(session.menuAdvanceTimer);
        if (session.menuAdvanceCount < 6) {
          session.menuAdvanceTimer = setTimeout(() => {
            if (session.cleanedUp || session.authUrlSent || session.rawBuffer.includes('oauth2')) {
              return;
            }
            session.menuAdvanceCount += 1;
            try {
              session.stream.write('\r');
            } catch {
              // stream may have closed mid-tick; ignore
            }
          }, 1500);
        }
      }
    }
    return;
  }

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
    let url: string | null = null;
    if (session.providerName === 'gemini') {
      url = extractGeminiAuthUrl(session.rawBuffer);
    } else {
      const prefixes = AUTH_URL_PREFIXES[session.providerName] ?? ['https://'];
      url = extractWrappedUrl(session.rawBuffer, prefixes);
    }
    if (url) {
      session.authUrlSent = true;
      const deviceCode = DEVICE_CODE_PROVIDERS.has(session.providerName)
        ? extractDeviceCode(session.rawBuffer)
        : undefined;
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
      void saveOauthTokenAndProbe(session, oauthToken);
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

  // Gemini and Antigravity success arrives via the creds-file poller started
  // after the user pastes the authorization code. The post-paste stdout (gemini
  // REPL / agy TUI) is unreliable, so we deliberately skip detectAuthResult here.
  if (session.providerName === 'gemini' || session.providerName === 'antigravity') return;

  // Amp prints "Login successful!" to stdout and exits within ~200ms of the
  // paste. That's faster than our 500ms creds-file poll cadence, so if we
  // relied on the poller alone the stream-end would fire first and the UI
  // would flip to a blank error state. Let detectAuthResult catch the
  // stdout signal; the creds poller below is kept as a belt-and-suspenders
  // fallback and is idempotent against authSuccessSent.

  const signal = detectAuthResult(session.cleanBuffer);
  if (signal?.kind === 'success') {
    session.authSuccessSent = true;
    session.probePending = true;
    log.info({ providerId: session.providerId }, 'auth success detected');
    wsSend(session.ws, { type: 'auth-success' });
    void runProbeAndSave(session);
  } else if (signal?.kind === 'error') {
    log.warn({ providerId: session.providerId, msg: signal.message }, 'auth error detected');
    wsSend(session.ws, { type: 'error', message: signal.message });
  }
}

const GEMINI_POLL_INTERVAL_MS = 500;
const GEMINI_POLL_MAX_TRIES = 20;
const GEMINI_CREDS_CHECK = [
  'sh',
  '-c',
  'test -s "$HOME/.gemini/oauth_creds.json" ' +
    '|| test -s "$HOME/.gemini/gemini-credentials.json" ' +
    '|| test -s "$HOME/.gemini/tokens.json"',
];

const AMP_POLL_INTERVAL_MS = 500;
const AMP_POLL_MAX_TRIES = 20;
// amp stores the login-derived apiKey in the file-based secretStorage at
// $XDG_DATA_HOME/amp/secrets.json (defaults to $HOME/.local/share/amp/secrets.json).
// settings.json under ~/.config/amp is for MCP/CLI prefs and is NOT populated
// by `amp login` — checking it waited 10s then always timed out.
const AMP_CREDS_CHECK = ['sh', '-c', 'test -s "$HOME/.local/share/amp/secrets.json"'];

const ANTIGRAVITY_POLL_INTERVAL_MS = 1000;
// Interactive login: the user reads the URL and completes the whole OAuth (incl.
// 2FA / consent) at their own pace AFTER the poller starts, so poll for most of
// the session rather than the ~20s used for paste-back flows. 540 x 1000ms = 9
// min; the 10-min SESSION_TIMEOUT_MS is the hard backstop that tears the session
// (and poller) down.
const ANTIGRAVITY_POLL_MAX_TRIES = 540;
// Content signature (md5) of agy's OAuth token file (path verified on agy 1.0.5),
// or empty stdout when the file is missing. The poller baselines this on its
// first read and fires only when the signature CHANGES, so a token already
// present on the persistent auth volume is never mistaken for a fresh sign-in.
const ANTIGRAVITY_CREDS_SIGNATURE = [
  'sh',
  '-c',
  'md5sum "$HOME/.gemini/antigravity-cli/antigravity-oauth-token" 2>/dev/null | cut -d" " -f1',
];

/** Polls the login container for gemini's creds file after the user pastes
 *  the authorization code. Fires auth-success + runProbeAndSave when the
 *  file appears; errors out after GEMINI_POLL_MAX_TRIES × interval.
 *  Idempotent: repeated calls while the poller is running are no-ops.
 */
function startGeminiCredsPoller(session: BannerSession): void {
  if (session.cleanedUp) return;
  if (session.credsPoller) return;
  if (session.authSuccessSent) return;
  let tries = 0;
  const poller = setInterval(() => {
    tries += 1;
    if (session.cleanedUp) {
      clearInterval(poller);
      return;
    }
    void execInContainer(session.docker, session.dockerContainerId, GEMINI_CREDS_CHECK)
      .then((result) => {
        if (session.cleanedUp || session.authSuccessSent) {
          clearInterval(poller);
          session.credsPoller = null;
          return;
        }
        if (result.exitCode === 0) {
          clearInterval(poller);
          session.credsPoller = null;
          session.authSuccessSent = true;
          session.probePending = true;
          log.info({ providerId: session.providerId }, 'gemini creds file detected');
          wsSend(session.ws, { type: 'auth-success' });
          void runProbeAndSave(session);
          return;
        }
        if (tries >= GEMINI_POLL_MAX_TRIES) {
          clearInterval(poller);
          session.credsPoller = null;
          log.warn(
            { providerId: session.providerId, tries },
            'gemini creds file not found before poll timeout',
          );
          wsSend(session.ws, {
            type: 'error',
            message:
              'Gemini did not write credentials after the code paste. The code may be wrong or expired — retry the login.',
          });
        }
      })
      .catch((err) => {
        log.warn({ err, providerId: session.providerId }, 'gemini creds poll exec failed');
      });
  }, GEMINI_POLL_INTERVAL_MS);
  session.credsPoller = poller;
  log.info({ providerId: session.providerId }, 'gemini creds poller started');
}

/** Polls the login container for amp's settings.json after the user pastes
 *  the code. Fires auth-success + runProbeAndSave when the file appears;
 *  errors out after AMP_POLL_MAX_TRIES × interval. Idempotent.
 */
function startAmpCredsPoller(session: BannerSession): void {
  if (session.cleanedUp) return;
  if (session.credsPoller) return;
  if (session.authSuccessSent) return;
  let tries = 0;
  const poller = setInterval(() => {
    tries += 1;
    if (session.cleanedUp) {
      clearInterval(poller);
      return;
    }
    void execInContainer(session.docker, session.dockerContainerId, AMP_CREDS_CHECK)
      .then((result) => {
        if (session.cleanedUp || session.authSuccessSent) {
          clearInterval(poller);
          session.credsPoller = null;
          return;
        }
        if (result.exitCode === 0) {
          clearInterval(poller);
          session.credsPoller = null;
          session.authSuccessSent = true;
          session.probePending = true;
          log.info({ providerId: session.providerId }, 'amp settings file detected');
          wsSend(session.ws, { type: 'auth-success' });
          void runProbeAndSave(session);
          return;
        }
        if (tries >= AMP_POLL_MAX_TRIES) {
          clearInterval(poller);
          session.credsPoller = null;
          log.warn(
            { providerId: session.providerId, tries },
            'amp settings file not found before poll timeout',
          );
          wsSend(session.ws, {
            type: 'error',
            message:
              'Amp did not write credentials after the code paste. The code may be wrong or expired — retry the login.',
          });
        }
      })
      .catch((err) => {
        log.warn({ err, providerId: session.providerId }, 'amp creds poll exec failed');
      });
  }, AMP_POLL_INTERVAL_MS);
  session.credsPoller = poller;
  log.info({ providerId: session.providerId }, 'amp creds poller started');
}

/** Polls the login container for agy's OAuth token file after the user pastes
 *  the authorization code. Fires auth-success + runProbeAndSave when the file
 *  appears; errors out after ANTIGRAVITY_POLL_MAX_TRIES × interval. Idempotent. */
function startAntigravityCredsPoller(session: BannerSession): void {
  if (session.cleanedUp) return;
  if (session.credsPoller) return;
  if (session.authSuccessSent) return;
  let tries = 0;
  const poller = setInterval(() => {
    tries += 1;
    if (session.cleanedUp) {
      clearInterval(poller);
      return;
    }
    void execInContainer(session.docker, session.dockerContainerId, ANTIGRAVITY_CREDS_SIGNATURE)
      .then((result) => {
        if (session.cleanedUp || session.authSuccessSent) {
          clearInterval(poller);
          session.credsPoller = null;
          return;
        }
        const signature = result.stdout.trim() || 'ABSENT';
        if (session.credsBaseline === null) {
          // First read establishes the baseline. A token already present at
          // session start (already-authenticated provider on the persistent auth
          // volume, or a stale/expired token still on disk) must NOT be read as a
          // fresh sign-in — otherwise the modal fires a false "auth-success"
          // before any OAuth URL, and re-login after expiry can never complete.
          session.credsBaseline = signature;
          log.info(
            { providerId: session.providerId, present: signature !== 'ABSENT' },
            'antigravity creds baseline captured',
          );
        } else if (signature !== 'ABSENT' && signature !== session.credsBaseline) {
          // Token file (re)written during this session = a genuine sign-in.
          clearInterval(poller);
          session.credsPoller = null;
          session.authSuccessSent = true;
          session.probePending = true;
          log.info(
            { providerId: session.providerId },
            'antigravity creds file written (new sign-in)',
          );
          wsSend(session.ws, { type: 'auth-success' });
          void runProbeAndSave(session);
          return;
        }
        if (tries >= ANTIGRAVITY_POLL_MAX_TRIES) {
          clearInterval(poller);
          session.credsPoller = null;
          log.warn(
            { providerId: session.providerId, tries },
            'antigravity token file not written before poll timeout',
          );
          wsSend(session.ws, {
            type: 'error',
            message:
              'Antigravity did not write credentials after the code paste. The code may be wrong or expired — retry the login.',
          });
        }
      })
      .catch((err) => {
        log.warn({ err, providerId: session.providerId }, 'antigravity creds poll exec failed');
      });
  }, ANTIGRAVITY_POLL_INTERVAL_MS);
  session.credsPoller = poller;
  log.info({ providerId: session.providerId }, 'antigravity creds poller started');
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
async function saveOauthTokenAndProbe(session: BannerSession, oauthToken: string): Promise<void> {
  try {
    await upsertProviderSecret(session.providerId, 'CLAUDE_CODE_OAUTH_TOKEN', oauthToken);
    // If a stale copy was ever written to envVars (pre-secrets migration),
    // scrub it so it doesn't shadow the canonical encrypted secret.
    const db = getDb();
    const existing = await db.query.cliProviders.findFirst({
      where: eq(schema.cliProviders.id, session.providerId),
    });
    if (existing?.envVars && 'CLAUDE_CODE_OAUTH_TOKEN' in existing.envVars) {
      const { CLAUDE_CODE_OAUTH_TOKEN: _drop, ...rest } = existing.envVars;
      await db
        .update(schema.cliProviders)
        .set({ envVars: rest, updatedAt: new Date() })
        .where(eq(schema.cliProviders.id, session.providerId));
    }
    log.info({ providerId: session.providerId }, 'oauth token saved to encrypted secret');
    const result = await enqueueProbe(
      session.providerId,
      session.userId,
      session.abort,
      session.ws,
      session.pending,
    );
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
    // The token is already saved by this point; a cancel here only abandons the verification
    // probe, so it is not a failure and there is no socket left to tell.
    if (err instanceof LoginCancelled) {
      log.info({ providerId: session.providerId }, 'login dialog closed while verifying');
      return; // the finally below still clears probePending and tears the session down
    }
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

async function runProbeAndSave(session: BannerSession): Promise<void> {
  try {
    const result = await enqueueProbe(
      session.providerId,
      session.userId,
      session.abort,
      session.ws,
      session.pending,
    );
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
    // Same as saveOauthTokenAndProbe: the login itself already landed, so a cancel during
    // verification is the user leaving, not a failure to report.
    if (err instanceof LoginCancelled) {
      log.info({ providerId: session.providerId }, 'login dialog closed while verifying');
      return; // the finally below still clears probePending and tears the session down
    }
    log.error({ err, providerId: session.providerId }, 'post-login probe failed');
    wsSend(session.ws, {
      type: 'error',
      message: err instanceof Error ? err.message : 'post-login probe failed',
    });
  } finally {
    session.probePending = false;
    void cleanupSession(session);
  }
}

async function upsertProviderSecret(
  providerId: string,
  secretName: string,
  value: string,
): Promise<void> {
  const db = getDb();
  const masterKek = await secretsService.getMasterKek();
  const envelope = envelopeEncrypt(value, masterKek);
  const fingerprint = computeKeyFingerprint(value);
  const existing = await db.query.cliProviderSecrets.findFirst({
    where: and(
      eq(schema.cliProviderSecrets.providerId, providerId),
      eq(schema.cliProviderSecrets.secretName, secretName),
    ),
    columns: { id: true },
  });
  if (existing) {
    await db
      .update(schema.cliProviderSecrets)
      .set({
        encryptedValue: envelope.encryptedValue,
        encryptedDek: envelope.encryptedDek,
        fingerprint,
        updatedAt: new Date(),
      })
      .where(eq(schema.cliProviderSecrets.id, existing.id));
    return;
  }
  await db.insert(schema.cliProviderSecrets).values({
    providerId,
    secretName,
    encryptedValue: envelope.encryptedValue,
    encryptedDek: envelope.encryptedDek,
    fingerprint,
  });
}

/** Await a cli-exec job with no deadline, telling the dialog what it is waiting for and giving
 *  up the moment the user closes it.
 *
 *  Replaces a 30s ttl that was wrong by orders of magnitude: these jobs share the cli-exec
 *  worker's concurrency with agent invocations that hold a slot for minutes, so a busy machine
 *  was reported to the user as a broken provider. There is deliberately no replacement
 *  deadline — the dialog shows the queue state and the user decides how long to wait — and
 *  SESSION_TIMEOUT_MS still bounds everything from the moment a container exists.
 */
async function awaitQueuedJob<T>(job: Job, abort: AbortHandle, ws: WebSocket): Promise<T> {
  const queue = getCliExecQueue();
  let announced = false;
  const report = async (): Promise<void> => {
    try {
      const state = await job.getState();
      if (state !== 'waiting' && state !== 'delayed' && state !== 'prioritized') return;
      const [running, waiting] = await Promise.all([
        queue.getActiveCount(),
        queue.getWaiting(0, -1),
      ]);
      const ahead = waitAheadCount(
        waiting.map((j) => j.id ?? ''),
        job.id ?? '',
      );
      // Gone from the wait list between the two reads — it is starting, so say nothing rather
      // than publish a position that no longer exists.
      if (ahead === null) return;
      announced = true;
      wsSend(ws, { type: 'queue', running, ahead });
    } catch (err) {
      log.debug({ err, jobId: job.id }, 'queue position read failed');
    }
  };
  void report();
  const ticker = setInterval(() => void report(), QUEUE_REPORT_MS);
  try {
    return (await Promise.race([
      job.waitUntilFinished(getCliExecQueueEvents()),
      abort.signal,
    ])) as T;
  } finally {
    clearInterval(ticker);
    // Only if we ever said "queued": an unmatched clear would blank a panel the dialog never
    // showed, and on the idle path the dialog must look exactly as it did before.
    if (announced) wsSend(ws, { type: 'queue-cleared' });
  }
}

/** Undo whatever a closed dialog left behind.
 *
 *  Order matters: a job still in the wait list can simply be removed, but one the worker has
 *  already picked up will go on to build a container that nobody is attached to, and removing
 *  its record first would lose the only handle on that container. So a running job is allowed
 *  to finish and its container is destroyed instead. Best-effort throughout — this runs on a
 *  socket that is already gone, and there is nobody left to report a failure to. */
async function discardPendingLogin(pending: { job: Job | null }, docker: Docker): Promise<void> {
  const job = pending.job;
  if (!job) return;
  try {
    const state = await job.getState();
    if (state === 'waiting' || state === 'delayed' || state === 'prioritized') {
      await job.remove();
      log.info({ jobId: job.id }, 'login cancelled while queued; job removed');
      return;
    }
  } catch (err) {
    log.debug({ err, jobId: job.id }, 'queued-job removal skipped');
  }
  try {
    const result = (await job.waitUntilFinished(
      getCliExecQueueEvents(),
      CANCEL_DRAIN_MS,
    )) as CliLoginCreateResult;
    if (result?.containerRowId && result.dockerContainerId) {
      await teardownContainer(result.containerRowId, docker, result.dockerContainerId);
      log.info({ jobId: job.id }, 'login cancelled after start; container destroyed');
    }
  } catch (err) {
    log.debug({ err, jobId: job.id }, 'cancelled login produced no container to destroy');
  }
}

async function enqueueLoginCreate(
  providerId: string,
  userId: string,
  abort: AbortHandle,
  ws: WebSocket,
  pending: { job: Job | null },
): Promise<CliLoginCreateResult> {
  const queue = getCliExecQueue();
  const payload: CliLoginCreateJobPayload = { providerId, userId };
  const job = await queue.add(CLI_EXEC_JOB_NAMES.LOGIN_CREATE, payload, {
    removeOnComplete: true,
    removeOnFail: true,
  });
  pending.job = job;
  return awaitQueuedJob<CliLoginCreateResult>(job, abort, ws);
}

async function enqueueProbe(
  providerId: string,
  userId: string,
  abort: AbortHandle,
  ws: WebSocket,
  pending: { job: Job | null },
): Promise<CliProbeResult> {
  const queue = getCliExecQueue();
  const payload: CliProbeJobPayload = { providerId, userId, targetMode: 'cli' };
  const job = await queue.add(CLI_EXEC_JOB_NAMES.PROBE, payload, {
    removeOnComplete: true,
    removeOnFail: true,
  });
  pending.job = job;
  const result = await awaitQueuedJob<CliProbeResult>(job, abort, ws);
  // A login just rewrote this provider's credential, which for the volumeJson CLIs is the
  // very file the usage poller reads — so kick a tick and let the meter come back in seconds
  // instead of leaving a "reconnect" prompt up for a whole ~5-min repeatable interval after
  // the user already fixed it. The claude usage-OAuth callback has done this for a while;
  // this is the interactive-login path catching up. Both post-login paths funnel through
  // here, so one enqueue covers them.
  void getUsagePollQueue()
    .add('usage-poll-tick', {}, { removeOnComplete: true, removeOnFail: 10 })
    .catch(() => {});
  return result;
}

async function cleanupSession(session: BannerSession): Promise<void> {
  if (session.cleanedUp) return;
  session.cleanedUp = true;
  stopCaptureWatchdog(session);
  if (session.credsPoller) {
    clearInterval(session.credsPoller);
    session.credsPoller = null;
  }
  if (session.menuAdvanceTimer) {
    clearTimeout(session.menuAdvanceTimer);
    session.menuAdvanceTimer = null;
  }
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
