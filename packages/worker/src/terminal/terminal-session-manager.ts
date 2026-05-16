import { randomUUID } from 'node:crypto';
import { Duplex } from 'node:stream';
import Docker from 'dockerode';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  TERMINAL_CTL_CHANNEL_PREFIX,
  TERMINAL_IN_CHANNEL_PREFIX,
  TERMINAL_OUT_CHANNEL_PREFIX,
  TERMINAL_REPLY_CHANNEL_PREFIX,
  TERMINAL_REQUEST_CHANNEL,
  TERMINAL_SESSION_PREFIX,
  logger,
  type TerminalControlFrame,
  type TerminalOpenResult,
  type TerminalRequest,
} from '@haive/shared';
import type { Redis } from 'ioredis';
import { createRedisConnection } from '@haive/shared';
import { ensureShellContainer } from './terminal-container.js';
import { resolveTaskRepoMount } from '../queues/cli-exec-queue.js';
import { SANDBOX_WORKDIR } from '../sandbox/sandbox-runner.js';
import type { McpServerSpec } from '../sandbox/mcp-config.js';
import { buildDefaultMcpServers } from '../sandbox/mcp-config.js';
import { cliAdapterRegistry } from '../cli-adapters/registry.js';
import { resolveProviderSecrets } from '../secrets/provider-secrets.js';
import { resolveUserGitEnv } from '../secrets/user-git-identity.js';

const log = logger.child({ module: 'terminal-session-manager' });

interface SessionState {
  sessionId: string;
  userId: string;
  taskId: string;
  providerId: string;
  containerName: string;
  shell: 'bash' | 'sh';
  // dockerode exec stream is bidirectional Duplex when Tty=true. Writes send
  // PTY stdin; reads emit PTY stdout/stderr (raw, not multiplexed).
  ptyStream: Duplex;
  ptyHandle: Docker.Exec;
  inChannel: string;
  ctlChannel: string;
  outChannel: string;
}

export interface TerminalSessionManagerOptions {
  db: Database;
  redis: Redis;
  subscriberRedis?: Redis;
  docker?: Docker;
  buildMcpServers?: (userId: string, taskId: string) => Promise<McpServerSpec[]>;
}

// Owns per-(user,task,provider) shell containers and the PTY plumbing that
// links them to the API WebSocket. Subscribes to the global open/close
// request channel and per-session in/ctl channels.
export class TerminalSessionManager {
  private readonly db: Database;
  private readonly redis: Redis;
  private readonly subscriber: Redis;
  private readonly ownsSubscriber: boolean;
  private readonly docker: Docker;
  private readonly buildMcpServers: (userId: string, taskId: string) => Promise<McpServerSpec[]>;
  private readonly sessions = new Map<string, SessionState>();
  /** Per-(user,task,provider) in-flight ensureShellContainer call. Two
   *  near-simultaneous opens (React StrictMode double-mount, or two browser
   *  tabs racing) would otherwise both call createContainer and one would
   *  hit a 409. This map collapses concurrent ensures into a single call.
   *  Cleared after the promise settles. */
  private readonly ensureInFlight = new Map<
    string,
    Promise<Awaited<ReturnType<typeof ensureShellContainer>>>
  >();
  private started = false;

  constructor(opts: TerminalSessionManagerOptions) {
    this.db = opts.db;
    this.redis = opts.redis;
    this.docker = opts.docker ?? new Docker();
    this.buildMcpServers = opts.buildMcpServers ?? defaultBuildMcpServers;
    if (opts.subscriberRedis) {
      this.subscriber = opts.subscriberRedis;
      this.ownsSubscriber = false;
    } else {
      const url = process.env.REDIS_URL;
      if (!url) throw new Error('REDIS_URL not set; cannot create subscriber connection');
      this.subscriber = createRedisConnection(url);
      this.ownsSubscriber = true;
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.subscriber.subscribe(TERMINAL_REQUEST_CHANNEL);
    this.subscriber.on('message', (channel, raw) => {
      this.handleSubscriberMessage(channel, raw).catch((err) => {
        log.error({ err, channel }, 'subscriber handler threw');
      });
    });
    log.info({ channel: TERMINAL_REQUEST_CHANNEL }, 'terminal session manager started');
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    for (const session of this.sessions.values()) {
      await this.teardownSession(session, 'manager-stop').catch(() => undefined);
    }
    this.sessions.clear();
    await this.subscriber.unsubscribe(TERMINAL_REQUEST_CHANNEL).catch(() => undefined);
    if (this.ownsSubscriber) {
      await this.subscriber.quit().catch(() => undefined);
    }
  }

  private async handleSubscriberMessage(channel: string, raw: string): Promise<void> {
    if (channel === TERMINAL_REQUEST_CHANNEL) {
      const req = parseRequest(raw);
      if (!req) return;
      if (req.op === 'open') {
        const reply = await this.openSession(req).catch(
          (err): TerminalOpenResult => ({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        const replyChannel = `${TERMINAL_REPLY_CHANNEL_PREFIX}${req.correlationId}`;
        await this.redis.publish(replyChannel, JSON.stringify(reply));
        return;
      }
      if (req.op === 'close') {
        const session = this.sessions.get(req.sessionId);
        if (session) await this.teardownSession(session, 'api-close').catch(() => undefined);
        return;
      }
      return;
    }
    if (channel.startsWith(TERMINAL_IN_CHANNEL_PREFIX)) {
      const sid = channel.slice(TERMINAL_IN_CHANNEL_PREFIX.length);
      const session = this.sessions.get(sid);
      if (!session) return;
      session.ptyStream.write(raw);
      return;
    }
    if (channel.startsWith(TERMINAL_CTL_CHANNEL_PREFIX)) {
      const sid = channel.slice(TERMINAL_CTL_CHANNEL_PREFIX.length);
      const session = this.sessions.get(sid);
      if (!session) return;
      const frame = parseControlFrame(raw);
      if (!frame) return;
      if (frame.type === 'resize') {
        await session.ptyHandle
          .resize({ h: frame.rows, w: frame.cols })
          .catch((err) => log.warn({ err, sid }, 'pty resize failed'));
      }
    }
  }

  /** Resolve the env an interactive shell should see for this provider:
   *  decrypted secrets + provider.envVars + git identity, run through the
   *  adapter's `buildShellEnv` so per-CLI aliases (e.g. zai's
   *  ANTHROPIC_AUTH_TOKEN) land. Empty object on missing provider. */
  private async resolveProviderShellEnv(
    userId: string,
    providerId: string,
  ): Promise<Record<string, string>> {
    const provider = await this.db.query.cliProviders.findFirst({
      where: eq(schema.cliProviders.id, providerId),
    });
    if (!provider || provider.userId !== userId) return {};
    const [secrets, gitEnv] = await Promise.all([
      resolveProviderSecrets(this.db, providerId),
      resolveUserGitEnv(this.db, userId),
    ]);
    const adapter = cliAdapterRegistry.has(provider.name)
      ? cliAdapterRegistry.get(provider.name)
      : null;
    if (!adapter) {
      return { ...(provider.envVars ?? {}), ...secrets, ...gitEnv };
    }
    return adapter.buildShellEnv(provider, secrets, gitEnv);
  }

  private async openSession(req: {
    correlationId: string;
    userId: string;
    taskId: string;
    cliProviderId: string;
  }): Promise<TerminalOpenResult> {
    const task = await this.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, req.taskId),
    });
    if (!task) return { ok: false, error: 'task not found' };
    if (task.userId !== req.userId) return { ok: false, error: 'task not owned by user' };
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
      return { ok: false, error: `task is ${task.status} - terminal disabled` };
    }

    const repoMount = await resolveTaskRepoMount(this.db, req.taskId).catch(() => null);
    const mcpServers = await this.buildMcpServers(req.userId, req.taskId);
    const providerEnv = await this.resolveProviderShellEnv(req.userId, req.cliProviderId).catch(
      (err) => {
        log.warn({ err, providerId: req.cliProviderId }, 'resolveProviderShellEnv failed');
        return {};
      },
    );

    const ensureKey = `${req.userId}:${req.taskId}:${req.cliProviderId}`;
    let ensurePromise = this.ensureInFlight.get(ensureKey);
    if (!ensurePromise) {
      ensurePromise = ensureShellContainer({
        db: this.db,
        docker: this.docker,
        userId: req.userId,
        taskId: req.taskId,
        providerId: req.cliProviderId,
        repoMount,
        mcpServers,
        providerEnv,
      }).finally(() => {
        this.ensureInFlight.delete(ensureKey);
      });
      this.ensureInFlight.set(ensureKey, ensurePromise);
    }
    const ensured = await ensurePromise;

    // Each WS gets its own PTY exec, but the exec attaches to a single
    // long-lived tmux session ("haive-task") shared across all WSs against
    // the same container. That's what makes the bash session, env vars,
    // cwd, and pane buffer survive WS reconnects (tab switch, navigate
    // away and back, browser reload). Without tmux, every reconnect would
    // spawn a fresh `bash -l` and lose all in-shell state.
    //
    // `new-session -A -s haive-task` attaches if a session named
    // "haive-task" exists, else creates it. Two simultaneous WSs see the
    // same pane (mirror mode) — that's the standard tmux multi-client
    // behaviour and matches the project's "one shell per task" spec.
    //
    // tmux client (this exec) detaches cleanly on WS close (PTY end →
    // SIGHUP). The tmux server keeps running inside the container until
    // the container itself is reaped, giving the user the full grace
    // window to reconnect.
    const sessionId = randomUUID();
    // No -x/-y: let tmux size the pane from the controlling PTY. The xterm
    // sends a resize control frame on first connect (and on every window
    // resize), which the worker forwards to the docker exec PTY via
    // `ptyHandle.resize`; tmux picks up the new size through SIGWINCH.
    // Hard-coding -x/-y instead leaves the pane stuck at that size and the
    // rest of the xterm renders the empty background pattern.
    const tmuxCommand = ['tmux', 'new-session', '-A', '-s', 'haive-task', ensured.shell, '-l'];
    // tmux server inherits env from the docker-exec that starts it. On
    // first attach this list seeds the server; later reconnects attach to
    // the existing server and inherit its original env (so provider env
    // changes mid-task don't propagate until container reap). HOME is
    // left to the container default.
    const execEnv = ['TERM=xterm-256color'];
    for (const [k, v] of Object.entries(providerEnv)) {
      if (k === 'HOME' || k === 'TERM') continue;
      if (typeof v !== 'string') continue;
      execEnv.push(`${k}=${v}`);
    }
    const ptyHandle = await this.docker.getContainer(ensured.containerName).exec({
      Cmd: tmuxCommand,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      WorkingDir: '/haive/workdir',
      Env: execEnv,
    });
    const ptyStream = (await ptyHandle.start({
      hijack: true,
      stdin: true,
      Tty: true,
    })) as Duplex;

    const inChannel = `${TERMINAL_IN_CHANNEL_PREFIX}${sessionId}`;
    const ctlChannel = `${TERMINAL_CTL_CHANNEL_PREFIX}${sessionId}`;
    const outChannel = `${TERMINAL_OUT_CHANNEL_PREFIX}${sessionId}`;

    const session: SessionState = {
      sessionId,
      userId: req.userId,
      taskId: req.taskId,
      providerId: req.cliProviderId,
      containerName: ensured.containerName,
      shell: ensured.shell,
      ptyHandle,
      ptyStream,
      inChannel,
      ctlChannel,
      outChannel,
    };
    this.sessions.set(sessionId, session);

    // Pipe PTY output -> out channel. Tty:true gives a raw stream (no
    // multiplexing header) so chunks pass straight through.
    ptyStream.on('data', (chunk: Buffer) => {
      void this.redis.publish(outChannel, chunk.toString('utf8'));
    });
    ptyStream.on('end', () => {
      void this.redis.publish(outChannel, JSON.stringify({ type: 'exit' })).catch(() => undefined);
      void this.teardownSession(session, 'pty-end').catch(() => undefined);
    });
    ptyStream.on('error', (err) => {
      log.warn({ err, sessionId }, 'pty stream error');
    });

    await this.subscriber.subscribe(inChannel, ctlChannel);

    // Registry entry: worker writes container metadata only (HSETNX-style for
    // startedAt so reuses don't overwrite). API alone owns `refcount` via
    // HINCRBY +/-1 on WS attach/detach, and updates `lastSeenAt` on detach
    // so the reaper's idle clock starts when the last tab disconnects. The
    // worker does NOT touch refcount because openSession is called per-WS
    // and overwriting would clobber sibling tab counts.
    const key = `${TERMINAL_SESSION_PREFIX}${req.userId}:${req.taskId}:${req.cliProviderId}`;
    const now = Date.now();
    await this.redis.hset(key, {
      containerName: ensured.containerName,
      shell: ensured.shell,
    });
    await this.redis.hsetnx(key, 'startedAt', String(now));
    await this.redis.hsetnx(key, 'lastSeenAt', String(now));
    await this.redis.hsetnx(key, 'refcount', '0');

    return {
      ok: true,
      sessionId,
      containerName: ensured.containerName,
      shell: ensured.shell,
    };
  }

  private async teardownSession(session: SessionState, reason: string): Promise<void> {
    if (!this.sessions.has(session.sessionId)) return;
    this.sessions.delete(session.sessionId);
    log.info(
      { sessionId: session.sessionId, containerName: session.containerName, reason },
      'tearing down terminal session',
    );
    try {
      session.ptyStream.end();
      session.ptyStream.destroy();
    } catch {
      /* ignore */
    }
    await this.subscriber.unsubscribe(session.inChannel, session.ctlChannel).catch(() => undefined);
    // Container stays alive for the reaper. Refcount/lastSeenAt are managed
    // by the API on WS close, not here, since one container can have many
    // PTY sessions (browser-tab fan-out).
  }
}

function parseRequest(raw: string): TerminalRequest | null {
  try {
    const obj = JSON.parse(raw) as Partial<TerminalRequest>;
    if (obj.op === 'open' && obj.correlationId && obj.userId && obj.taskId && obj.cliProviderId) {
      return obj as TerminalRequest;
    }
    if (obj.op === 'close' && (obj as { sessionId?: string }).sessionId) {
      return obj as TerminalRequest;
    }
    return null;
  } catch {
    return null;
  }
}

function parseControlFrame(raw: string): TerminalControlFrame | null {
  try {
    const obj = JSON.parse(raw) as Partial<TerminalControlFrame>;
    if (
      obj.type === 'resize' &&
      typeof (obj as { cols?: unknown }).cols === 'number' &&
      typeof (obj as { rows?: unknown }).rows === 'number'
    ) {
      return obj as TerminalControlFrame;
    }
    return null;
  } catch {
    return null;
  }
}

async function defaultBuildMcpServers(_userId: string, _taskId: string): Promise<McpServerSpec[]> {
  // Default server set keyed off the sandbox workdir. Production wiring can
  // swap in a richer builder via TerminalSessionManager options to honour
  // user MCP settings + repo bundle servers.
  return buildDefaultMcpServers({ repoPath: SANDBOX_WORKDIR });
}
