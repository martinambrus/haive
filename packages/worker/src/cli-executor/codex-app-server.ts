import { APP_VERSION, type CliTokenUsage } from '@haive/shared';
import { tokenUsageFromCodexUsage } from './usage-extract.js';

/* ------------------------------------------------------------------ */
/* JSON-RPC over stdio for `codex app-server`                          */
/* ------------------------------------------------------------------ */
/* `codex exec` reads its prompt to EOF and never listens again, so the app-server is the only
 * codex interface a message can reach mid-run (`turn/steer`). It speaks JSON-RPC 2.0 over plain
 * piped stdio, one JSON object per line, and it is marked [experimental] — so this module reports
 * a transport failure instead of guessing, and the executor answers one by running the same work
 * on `codex exec`.
 *
 * MEASURED against codex-cli 0.154.0 (2026-09-13); two findings shape every rule below:
 *  - EVERY error is -32600. A request sent before `initialize`, an unknown method, a malformed
 *    request, `thread not found` and `no active turn to steer` all carry it, and only the wording
 *    differs — which is not a contract. So nothing here branches on an error's code or message:
 *    a request either returned a `result` or it did not.
 *  - Responses carry `id` plus `result` or `error` (the server omits `jsonrpc`), notifications
 *    carry `method` + `params`, and a server->client request carries `method` AND `id`.
 *
 * Settling is SYNCHRONOUS, inside line parsing. One stdout chunk can hold the `turn/start`
 * response and, a line later, that turn's `turn/completed`; a promise continuation would learn
 * the turn id only after the whole chunk was parsed, and the completion would be dropped as
 * belonging to no turn. Lives in cli-executor (no worker deps), like codex-jsonl.ts, so exec-core
 * and the protocol probe share one implementation. */

export type CodexAppServerStage =
  | 'spawn'
  | 'initialize'
  | 'thread_start'
  | 'turn_start'
  | 'handshake_timeout'
  | 'steer'
  | 'turn_started'
  | 'turn_completed'
  | 'server_request'
  | 'stream'
  | 'notifications';

export interface CodexAppServerFailure {
  stage: CodexAppServerStage;
  /** Display copy for the verdict and the log. Never branched on. */
  detail: string | null;
}

/** Stages at which no turn had been accepted: the model did no work yet, so the same invocation
 *  can be re-run on `codex exec` without repeating a side effect. */
const PRE_TURN_STAGES: ReadonlySet<CodexAppServerStage> = new Set<CodexAppServerStage>([
  'spawn',
  'initialize',
  'thread_start',
  'turn_start',
  'handshake_timeout',
]);

export function isPreTurnFailure(failure: CodexAppServerFailure | null): boolean {
  return failure !== null && PRE_TURN_STAGES.has(failure.stage);
}

export type JsonRpcOutcome = { ok: true; result: unknown } | { ok: false; detail: string };

export interface JsonRpcLineClient {
  attach(writable: NodeJS.WritableStream): void;
  onChunk(chunk: string): void;
  /** `onSettled` runs synchronously while the response line is parsed — see the module note. */
  request(method: string, params: unknown, onSettled?: (outcome: JsonRpcOutcome) => void): void;
  notify(method: string, params: unknown): void;
  respondError(id: string | number, message: string): void;
  /** End stdin, which is how the app-server is told to exit. */
  end(): void;
  /** The process is gone: parse what is left and settle every outstanding request as failed. */
  close(reason: string): void;
  isAttached(): boolean;
  getMalformedLineCount(): number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  if (isRecord(error) && typeof error.message === 'string' && error.message.trim()) {
    return error.message.trim();
  }
  return 'the request returned no result';
}

export function createJsonRpcLineClient(handlers: {
  onNotification: (method: string, params: Record<string, unknown>) => void;
  onServerRequest: (id: string | number, method: string) => void;
}): JsonRpcLineClient {
  let writable: NodeJS.WritableStream | null = null;
  let buffer = '';
  let nextId = 1;
  let closedReason: string | null = null;
  let malformed = 0;
  const pending = new Map<number, (outcome: JsonRpcOutcome) => void>();

  const write = (message: Record<string, unknown>): boolean => {
    if (!writable || !writable.writable || closedReason !== null) return false;
    try {
      writable.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
      return true;
    } catch {
      return false;
    }
  };

  const processLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      malformed++;
      return;
    }
    if (!isRecord(msg)) return;
    const { id, method } = msg;
    if (typeof method === 'string') {
      if (typeof id === 'number' || typeof id === 'string') handlers.onServerRequest(id, method);
      else handlers.onNotification(method, isRecord(msg.params) ? msg.params : {});
      return;
    }
    // Every id this client sends is a number, so anything else is not a reply to us.
    if (typeof id !== 'number') return;
    const settle = pending.get(id);
    if (!settle) return;
    pending.delete(id);
    settle(
      'result' in msg
        ? { ok: true, result: msg.result }
        : { ok: false, detail: describeError(msg.error) },
    );
  };

  return {
    attach(w: NodeJS.WritableStream): void {
      writable = w;
    },
    onChunk(chunk: string): void {
      buffer += chunk;
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        processLine(line);
      }
    },
    request(method, params, onSettled): void {
      const settle = onSettled ?? (() => undefined);
      if (closedReason !== null) {
        settle({ ok: false, detail: closedReason });
        return;
      }
      const id = nextId++;
      // Registered BEFORE the write: a reply can be parsed before write() returns.
      pending.set(id, settle);
      if (!write({ id, method, params })) {
        pending.delete(id);
        settle({ ok: false, detail: 'the app-server stdin is not writable' });
      }
    },
    notify(method, params): void {
      write({ method, params });
    },
    respondError(id, message): void {
      write({ id, error: { code: -32601, message } });
    },
    end(): void {
      const w = writable;
      if (!w || !w.writable) return;
      try {
        w.end();
      } catch {
        /* stdin already closed */
      }
    },
    close(reason: string): void {
      if (buffer.trim()) processLine(buffer);
      buffer = '';
      if (closedReason === null) closedReason = reason;
      const settles = [...pending.values()];
      pending.clear();
      for (const settle of settles) settle({ ok: false, detail: reason });
    },
    isAttached(): boolean {
      return writable !== null;
    },
    getMalformedLineCount(): number {
      return malformed;
    },
  };
}

/** Stamped on the turn's own prompt so its `userMessage` item is never taken for a steer. A web
 *  steer id is a uuid, so the two cannot collide. */
const PROMPT_CLIENT_ID = 'turn-prompt';

/** Delta streams Haive has no use for, turned off at `initialize`. Each repeats, token by token or
 *  chunk by chunk, content that arrives whole on the matching `item/completed` — the granularity
 *  `codex exec --json` has always given — so opting out only keeps the stream log small.
 *  MEASURED: `optOutNotificationMethods` is honoured (an opted-out method stopped arriving). */
export const CODEX_APP_SERVER_OPTED_OUT_NOTIFICATIONS: readonly string[] = [
  'item/agentMessage/delta',
  'item/plan/delta',
  'item/reasoning/textDelta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/commandExecution/outputDelta',
  'item/fileChange/outputDelta',
  'command/exec/outputDelta',
  'process/outputDelta',
];

export function codexAppServerInitializeParams(): Record<string, unknown> {
  return {
    clientInfo: { name: 'haive', version: APP_VERSION },
    capabilities: { optOutNotificationMethods: [...CODEX_APP_SERVER_OPTED_OUT_NOTIFICATIONS] },
  };
}

/** The approval + sandbox pair that stands in for `codex exec`'s
 *  `--dangerously-bypass-approvals-and-sandbox`: Haive's per-task container is the boundary, and
 *  codex's own bwrap sandbox cannot start inside it. The spike measured ZERO server->client
 *  requests under this pair, which is why any request that does arrive is a transport failure. */
export const CODEX_APP_SERVER_THREAD_POLICY = {
  approvalPolicy: 'never',
  sandbox: 'danger-full-access',
} as const;
export const CODEX_APP_SERVER_TURN_POLICY = {
  approvalPolicy: 'never',
  sandboxPolicy: { type: 'dangerFullAccess' },
} as const;

/** What `thread/start` told us, or null when the result lacks the one field Haive needs. */
export function readThreadStart(
  result: unknown,
): { threadId: string; model: string | null; cliVersion: string | null } | null {
  if (!isRecord(result) || !isRecord(result.thread)) return null;
  const { id, cliVersion } = result.thread;
  if (typeof id !== 'string' || !id) return null;
  return {
    threadId: id,
    model: typeof result.model === 'string' && result.model.trim() ? result.model.trim() : null,
    cliVersion: typeof cliVersion === 'string' && cliVersion.trim() ? cliVersion.trim() : null,
  };
}

export function readTurnId(result: unknown): string | null {
  if (!isRecord(result) || !isRecord(result.turn)) return null;
  return typeof result.turn.id === 'string' && result.turn.id ? result.turn.id : null;
}

export interface CodexAppServerSessionOptions {
  prompt: string;
  model: string | null;
  effort: string | null;
  /** Each completed agentMessage's text — the same granularity codex-jsonl's onText has. */
  onText?: (text: string) => void;
  /** Fired once, when OUR turn completes with any status. The steer forwarder latches on it. */
  onTurnCompleted?: () => void;
  /** A steer's `userMessage` was recorded in the turn: it reached the model's input. */
  onSteerConsumed?: (steerId: string) => void;
  /** The server refused a steer. Logged and left unconsumed; never a transport verdict, because a
   *  steer that races the turn's completion is refused with the same -32600 as a missing method. */
  onSteerRejected?: (steerId: string, detail: string) => void;
}

export interface CodexAppServerSession {
  attach(writable: NodeJS.WritableStream): void;
  onChunk(chunk: string): void;
  steer(steer: { id: string; text: string }): void;
  /** Give up on a handshake that has not finished: record `stage` and end stdin. A no-op once the
   *  turn was accepted, when the run is already doing work. */
  abortHandshake(stage: CodexAppServerStage, detail: string): void;
  /** The process has exited. */
  close(): void;
  isTurnAccepted(): boolean;
  getResult(): string | null;
  getTokenUsage(): CliTokenUsage | null;
  /** requested = the model `thread/start` resolved; served = a `model/rerouted` target, the only
   *  channel that names what answered. */
  getModelReport(): { requested: string | null; served: string | null; billed: string[] } | null;
  getTurnStatus(): string | null;
  getTurnError(): string | null;
  /** `thread.cliVersion` as this app-server reported it — the binary that actually ran, which is
   *  how a task notices its provider's image moved to another codex under a stored verdict. */
  getBinaryVersion(): string | null;
  /** The structural verdict on the transport, read after close(). Null when it behaved. */
  getTransportFailure(): CodexAppServerFailure | null;
  getMalformedLineCount(): number;
}

interface SentSteer {
  steerId: string;
  clientId: string;
  text: string;
}

export function createCodexAppServerSession(
  opts: CodexAppServerSessionOptions,
): CodexAppServerSession {
  let threadId: string | null = null;
  let turnId: string | null = null;
  let turnStarted = false;
  let turnCompleted = false;
  let turnStatus: string | null = null;
  let turnError: string | null = null;
  let handshakeFailure: CodexAppServerFailure | null = null;
  let serverRequestFailure: CodexAppServerFailure | null = null;
  let interruptWhenStarted = false;
  let requestedModel: string | null = null;
  let binaryVersion: string | null = null;
  let servedModel: string | null = null;
  let lastAgentMessage: string | null = null;
  let usage: CliTokenUsage | null = null;
  let promptSeen = false;
  let anonymousSteers = 0;
  const queued: SentSteer[] = [];
  const sent: SentSteer[] = [];
  const seenUserMessages = new Set<string>();

  const client = createJsonRpcLineClient({
    onNotification: (method, params) => onNotification(method, params),
    onServerRequest: (id, method) => {
      client.respondError(id, `Haive runs codex non-interactively and does not answer ${method}`);
      if (!serverRequestFailure) serverRequestFailure = { stage: 'server_request', detail: method };
      interrupt();
    },
  });

  const failHandshake = (stage: CodexAppServerStage, detail: string): void => {
    if (handshakeFailure || turnId) return;
    handshakeFailure = { stage, detail };
    client.end();
  };

  const interrupt = (): void => {
    if (turnCompleted) return;
    if (threadId && turnId && turnStarted) client.request('turn/interrupt', { threadId, turnId });
    else interruptWhenStarted = true;
  };

  const sendSteer = (entry: SentSteer): void => {
    sent.push(entry);
    client.request(
      'turn/steer',
      {
        threadId,
        expectedTurnId: turnId,
        clientUserMessageId: entry.clientId,
        input: [{ type: 'text', text: entry.text }],
      },
      (outcome) => {
        if (outcome.ok) return;
        const idx = sent.indexOf(entry);
        if (idx === -1) return;
        sent.splice(idx, 1);
        opts.onSteerRejected?.(entry.steerId, outcome.detail);
      },
    );
  };

  const onUserMessage = (item: Record<string, unknown>): void => {
    if (typeof item.id === 'string') {
      if (seenUserMessages.has(item.id)) return;
      seenUserMessages.add(item.id);
    }
    const clientId = typeof item.clientId === 'string' ? item.clientId : null;
    // The turn's prompt is its first user message. Recognised by its client id when the binary
    // echoes one, and by being first when it does not — so a steer is never consumed by it.
    if (clientId === PROMPT_CLIENT_ID || (clientId === null && !promptSeen)) {
      promptSeen = true;
      return;
    }
    // A matching client id is exact. Without one, user messages are recorded in the order the
    // steers were sent, so the oldest outstanding steer is the one this message carries.
    const idx =
      clientId === null
        ? sent.length > 0
          ? 0
          : -1
        : sent.findIndex((s) => s.clientId === clientId);
    if (idx === -1) return;
    const [consumed] = sent.splice(idx, 1);
    if (consumed) opts.onSteerConsumed?.(consumed.steerId);
  };

  const onNotification = (method: string, params: Record<string, unknown>): void => {
    const forOurTurn = typeof params.turnId !== 'string' || params.turnId === turnId;
    switch (method) {
      case 'item/completed': {
        const item = params.item;
        if (!forOurTurn || !isRecord(item)) return;
        if (item.type === 'agentMessage' && typeof item.text === 'string') {
          lastAgentMessage = item.text;
          opts.onText?.(item.text);
        } else if (item.type === 'userMessage') {
          onUserMessage(item);
        }
        return;
      }
      case 'thread/tokenUsage/updated': {
        if (typeof params.threadId === 'string' && params.threadId !== threadId) return;
        const total = isRecord(params.tokenUsage) ? params.tokenUsage.total : null;
        if (!isRecord(total)) return;
        // Same field meanings as `codex exec --json`'s turn.completed usage (input INCLUDES the
        // cached prefix), so one mapping keeps both transports priced identically. `total` is the
        // thread's running sum, and one invocation is one thread.
        const mapped = tokenUsageFromCodexUsage({
          input_tokens: total.inputTokens,
          cached_input_tokens: total.cachedInputTokens,
          output_tokens: total.outputTokens,
        });
        if (mapped) usage = mapped;
        return;
      }
      case 'model/rerouted': {
        if (!forOurTurn) return;
        if (typeof params.toModel === 'string' && params.toModel.trim()) {
          servedModel = params.toModel.trim();
        }
        return;
      }
      case 'turn/started': {
        const turn = params.turn;
        if (turnId === null || !isRecord(turn) || turn.id !== turnId) return;
        turnStarted = true;
        if (interruptWhenStarted) {
          interruptWhenStarted = false;
          interrupt();
        }
        return;
      }
      case 'turn/completed': {
        const turn = params.turn;
        if (turnId === null || !isRecord(turn) || turn.id !== turnId || turnCompleted) return;
        turnCompleted = true;
        turnStatus = typeof turn.status === 'string' ? turn.status : null;
        turnError =
          isRecord(turn.error) && typeof turn.error.message === 'string'
            ? turn.error.message
            : null;
        opts.onTurnCompleted?.();
        return;
      }
      default:
        return;
    }
  };

  const beginHandshake = (): void => {
    client.request('initialize', codexAppServerInitializeParams(), (init) => {
      if (!init.ok) return failHandshake('initialize', init.detail);
      client.notify('initialized', {});
      client.request(
        'thread/start',
        { ...(opts.model ? { model: opts.model } : {}), ...CODEX_APP_SERVER_THREAD_POLICY },
        (thread) => {
          const started = thread.ok ? readThreadStart(thread.result) : null;
          if (!started) {
            return failHandshake(
              'thread_start',
              thread.ok ? 'thread/start returned no thread id' : thread.detail,
            );
          }
          threadId = started.threadId;
          requestedModel = started.model;
          binaryVersion = started.cliVersion;
          client.request(
            'turn/start',
            {
              threadId,
              input: [{ type: 'text', text: opts.prompt }],
              clientUserMessageId: PROMPT_CLIENT_ID,
              ...CODEX_APP_SERVER_TURN_POLICY,
              ...(opts.model ? { model: opts.model } : {}),
              ...(opts.effort ? { effort: opts.effort } : {}),
            },
            (turn) => {
              const id = turn.ok ? readTurnId(turn.result) : null;
              if (!id) {
                return failHandshake(
                  'turn_start',
                  turn.ok ? 'turn/start returned no turn id' : turn.detail,
                );
              }
              turnId = id;
              for (const steer of queued.splice(0)) sendSteer(steer);
            },
          );
        },
      );
    });
  };

  return {
    attach(writable: NodeJS.WritableStream): void {
      if (client.isAttached()) return;
      client.attach(writable);
      beginHandshake();
    },
    onChunk(chunk: string): void {
      client.onChunk(chunk);
    },
    steer(steer: { id: string; text: string }): void {
      const entry: SentSteer = {
        steerId: steer.id,
        clientId: steer.id || `anonymous-steer-${++anonymousSteers}`,
        text: steer.text,
      };
      if (turnId === null) queued.push(entry);
      else sendSteer(entry);
    },
    abortHandshake(stage: CodexAppServerStage, detail: string): void {
      failHandshake(stage, detail);
    },
    close(): void {
      client.close('the app-server exited');
    },
    isTurnAccepted(): boolean {
      return turnId !== null;
    },
    getResult(): string | null {
      return lastAgentMessage;
    },
    getTokenUsage(): CliTokenUsage | null {
      return usage;
    },
    getModelReport() {
      if (requestedModel === null && servedModel === null) return null;
      return { requested: requestedModel, served: servedModel, billed: [] };
    },
    getTurnStatus(): string | null {
      return turnStatus;
    },
    getTurnError(): string | null {
      return turnError;
    },
    getBinaryVersion(): string | null {
      return binaryVersion;
    },
    getTransportFailure(): CodexAppServerFailure | null {
      if (handshakeFailure) return handshakeFailure;
      if (turnId === null) {
        return client.isAttached()
          ? { stage: 'initialize', detail: 'the app-server ended before the turn was accepted' }
          : { stage: 'spawn', detail: 'the app-server never opened stdin' };
      }
      if (serverRequestFailure) return serverRequestFailure;
      if (!turnCompleted) {
        return { stage: 'stream', detail: 'the app-server ended without completing the turn' };
      }
      // A turn that sampled always reports usage. A completed one that reported neither usage nor
      // a message means the notifications Haive parses did not arrive in the shape it reads.
      if (turnStatus === 'completed' && usage === null && lastAgentMessage === null) {
        return {
          stage: 'notifications',
          detail: 'the turn completed with no usage report and no agent message',
        };
      }
      return null;
    },
    getMalformedLineCount(): number {
      return client.getMalformedLineCount();
    },
  };
}
