import type { Database } from '@haive/database';
import { logger, type CliNetworkPolicy } from '@haive/shared';
import { defaultDockerRunner } from '../sandbox/docker-runner.js';
import { resolveImageTag } from '../sandbox/image-cache.js';
import { runInSandbox } from '../sandbox/sandbox-runner.js';
import {
  CODEX_APP_SERVER_THREAD_POLICY,
  CODEX_APP_SERVER_TURN_POLICY,
  codexAppServerInitializeParams,
  createJsonRpcLineClient,
  isRecord,
  readThreadStart,
  readTurnId,
  type CodexAppServerStage,
} from '../cli-executor/codex-app-server.js';
import type { BaseCliAdapter } from './base-adapter.js';
import {
  codexAppServerVerdict,
  currentCodexAppServerVerdict,
  loadCodexAppServerVerdicts,
  recordCodexAppServerVerdict,
  type CodexAppServerVerdict,
} from './codex-app-server-verdict.js';
import type { CliProviderRecord } from './types.js';

const log = logger.child({ module: 'codex-app-server-probe' });

/* ------------------------------------------------------------------ */
/* Does this codex binary speak the app-server requests Haive sends?    */
/* ------------------------------------------------------------------ */
/* Answered once per provider per task, on the first steerable codex dispatch, and at ZERO tokens:
 * the probe runs with no credentials and no network, so the model is never reached.
 *
 * MEASURED on codex-cli 0.154.0 (2026-09-13): with no auth, `turn/start` still answers
 * `inProgress` and the turn stays active for over 20 s while codex retries its connection. Inside
 * that window `turn/steer` is accepted, `turn/interrupt` works once `turn/started` has arrived, and
 * `turn/completed` follows with status `interrupted` in ~50 ms. So every request a real steerable
 * run depends on can be exercised without a model call.
 *
 * Only SUCCESS responses count. codex answers every failure with -32600, a missing method and a
 * turn that already ended alike, so an error can never be read as "which kind of failure".
 *
 * Assumed, and stated in AGENTS.md: a future codex that refuses to start a turn without a login
 * would read here as `unsupported`. That fails toward `codex exec`, which is the safe direction. */

const PROBE_TIMEOUT_MS = 30_000;
/** After the probe has its answer it ends stdin; this is how long the binary gets to exit on its
 *  own before the container is stopped. MEASURED on 0.154.0: codex exits ~0.12 s after EOF when no
 *  turn ran, but ~5.1 s after an interrupted one, with the image's entrypoint and without it alike
 *  — so a 5 s grace raced its own shutdown. */
const PROBE_EXIT_GRACE_MS = 15_000;
const PROBE_PROMPT = 'Haive app-server probe. This turn is interrupted before it runs.';
const PROBE_STEER_CLIENT_ID = 'app-server-probe-steer';
/** `docker run`'s own exit code when the CONTAINER could not be created or started (daemon
 *  error, missing image) — a statement about Docker, not about codex. */
const DOCKER_RUN_FAILED_EXIT = 125;
const DETAIL_MAX_CHARS = 300;

export type CodexAppServerProbeOutcome =
  | { kind: 'supported'; binaryVersion: string | null }
  | {
      kind: 'unsupported';
      stage: CodexAppServerStage;
      detail: string;
      binaryVersion: string | null;
    }
  /** Nothing was learned about codex: record no verdict and let the next dispatch probe again. */
  | { kind: 'inconclusive'; detail: string };

export interface ProbeProcessResult {
  exitCode: number | null;
  stderr: string;
  error?: string;
  timedOut: boolean;
}

/** Starts the app-server. Must hand over stdin once it is open, feed every stdout chunk, and
 *  resolve when the process has exited. Injected so the protocol logic is testable without Docker. */
export type ProbeSpawn = (io: {
  onStdinWritable: (writable: NodeJS.WritableStream) => void;
  onStdout: (chunk: string) => void;
  signal: AbortSignal;
  timeoutMs: number;
}) => Promise<ProbeProcessResult>;

/** The tail of a process's stderr as display copy: codex logs with ANSI colour. */
function tailDetail(text: string): string {
  const clean = text.replace(/\u001b\[[0-9;]*m/g, '').trim();
  return clean.length > DETAIL_MAX_CHARS ? `…${clean.slice(-DETAIL_MAX_CHARS)}` : clean;
}

export async function runCodexAppServerProbe(
  spawn: ProbeSpawn,
  params: { model: string | null; effort: string | null; timeoutMs?: number },
): Promise<CodexAppServerProbeOutcome> {
  const timeoutMs = params.timeoutMs ?? PROBE_TIMEOUT_MS;
  const abort = new AbortController();
  // On an object rather than in `let`s: both are written inside the JSON-RPC callbacks and read
  // after `await spawn(...)`, and TypeScript keeps a `let`'s narrowing across writes made in a
  // callback, so it would type the checks below against the initial values.
  const state: { outcome: CodexAppServerProbeOutcome | null; stage: CodexAppServerStage } = {
    outcome: null,
    stage: 'spawn',
  };
  let binaryVersion: string | null = null;
  let threadId: string | null = null;
  let turnId: string | null = null;
  let steerAccepted = false;
  let turnStarted = false;
  let turnCompleted = false;
  let interruptSent = false;
  let exitGrace: ReturnType<typeof setTimeout> | null = null;

  const client = createJsonRpcLineClient({
    onNotification: (method, p) => {
      if (turnId === null || !isRecord(p.turn) || p.turn.id !== turnId) return;
      if (method === 'turn/started') {
        turnStarted = true;
        maybeInterrupt();
      } else if (method === 'turn/completed') {
        turnCompleted = true;
        if (steerAccepted) finish({ kind: 'supported', binaryVersion });
      }
    },
    onServerRequest: (id, method) => {
      client.respondError(id, `Haive's app-server probe does not answer ${method}`);
      fail('server_request', method);
    },
  });

  function finish(result: CodexAppServerProbeOutcome): void {
    if (state.outcome) return;
    state.outcome = result;
    client.end();
    exitGrace = setTimeout(() => abort.abort(), PROBE_EXIT_GRACE_MS);
  }

  function fail(at: CodexAppServerStage, detail: string): void {
    finish({ kind: 'unsupported', stage: at, detail, binaryVersion });
  }

  function maybeInterrupt(): void {
    if (!steerAccepted || !turnStarted || interruptSent || turnCompleted || state.outcome) return;
    interruptSent = true;
    state.stage = 'turn_completed';
    // Its result is not required: a turn that completes on its own proves the same thing.
    client.request('turn/interrupt', { threadId, turnId });
  }

  const onSteerAnswered = (
    steer: { ok: true; result: unknown } | { ok: false; detail: string },
  ) => {
    const answeredFor = steer.ok && isRecord(steer.result) ? steer.result.turnId : undefined;
    if (steer.ok && answeredFor === turnId) {
      steerAccepted = true;
      state.stage = 'turn_started';
      if (turnCompleted) return finish({ kind: 'supported', binaryVersion });
      return maybeInterrupt();
    }
    // A turn that ended before its steer was answered says nothing about whether steering exists:
    // the refusal reads identically either way.
    if (turnCompleted) {
      return finish({
        kind: 'inconclusive',
        detail: 'the probe turn ended before its steer was answered',
      });
    }
    fail('steer', steer.ok ? 'answered for a different turn' : steer.detail);
  };

  const onStdinWritable = (writable: NodeJS.WritableStream): void => {
    client.attach(writable);
    state.stage = 'initialize';
    client.request('initialize', codexAppServerInitializeParams(), (init) => {
      if (!init.ok) return fail('initialize', init.detail);
      client.notify('initialized', {});
      state.stage = 'thread_start';
      client.request(
        'thread/start',
        { ...(params.model ? { model: params.model } : {}), ...CODEX_APP_SERVER_THREAD_POLICY },
        (thread) => {
          const started = thread.ok ? readThreadStart(thread.result) : null;
          if (!started) {
            return fail('thread_start', thread.ok ? 'no thread id in the result' : thread.detail);
          }
          threadId = started.threadId;
          binaryVersion = started.cliVersion;
          state.stage = 'turn_start';
          client.request(
            'turn/start',
            {
              threadId,
              input: [{ type: 'text', text: PROBE_PROMPT }],
              ...CODEX_APP_SERVER_TURN_POLICY,
              ...(params.model ? { model: params.model } : {}),
              ...(params.effort ? { effort: params.effort } : {}),
            },
            (turn) => {
              const id = turn.ok ? readTurnId(turn.result) : null;
              if (!id) {
                return fail('turn_start', turn.ok ? 'no turn id in the result' : turn.detail);
              }
              turnId = id;
              state.stage = 'steer';
              client.request(
                'turn/steer',
                {
                  threadId,
                  expectedTurnId: turnId,
                  clientUserMessageId: PROBE_STEER_CLIENT_ID,
                  input: [{ type: 'text', text: 'Haive app-server probe steer.' }],
                },
                onSteerAnswered,
              );
            },
          );
        },
      );
    });
  };

  const deadline = setTimeout(() => {
    fail(state.stage, `no answer within ${Math.round(timeoutMs / 1000)} s`);
    abort.abort();
  }, timeoutMs);

  let processResult: ProbeProcessResult;
  try {
    processResult = await spawn({
      onStdinWritable,
      onStdout: (chunk) => client.onChunk(chunk),
      signal: abort.signal,
      timeoutMs: timeoutMs + PROBE_EXIT_GRACE_MS,
    });
  } finally {
    clearTimeout(deadline);
    if (exitGrace) clearTimeout(exitGrace);
  }

  if (!state.outcome) {
    if (processResult.error !== undefined || processResult.exitCode === DOCKER_RUN_FAILED_EXIT) {
      state.outcome = {
        kind: 'inconclusive',
        detail:
          processResult.error ??
          (tailDetail(processResult.stderr) || 'docker could not start the probe container'),
      };
    } else if (state.stage === 'spawn' || state.stage === 'initialize') {
      // The binary exited without answering `initialize`. A codex that has no app-server
      // subcommand exits with a usage error exactly here.
      state.outcome = {
        kind: 'unsupported',
        stage: 'spawn',
        detail:
          tailDetail(processResult.stderr) ||
          `exited with code ${processResult.exitCode ?? 'unknown'}`,
        binaryVersion: null,
      };
    }
  }
  // Settles any request still outstanding, which records the stage it was stuck at.
  client.close('the app-server exited');
  return (
    state.outcome ?? {
      kind: 'unsupported',
      stage: state.stage,
      detail: 'the app-server exited before the probe finished',
      binaryVersion,
    }
  );
}

const inFlight = new Map<string, Promise<CodexAppServerVerdict | null>>();

/** The verdict for this provider's binary in this task, probing it when there is none. Returns
 *  null when no verdict could be reached — the caller dispatches `codex exec` and the next
 *  steerable dispatch tries again. Never throws. */
export function ensureCodexAppServerVerdict(
  db: Database,
  taskId: string,
  provider: CliProviderRecord,
  adapter: BaseCliAdapter,
): Promise<CodexAppServerVerdict | null> {
  const key = `${taskId}:${provider.id}:${provider.cliVersion?.trim() ?? ''}`;
  const running = inFlight.get(key);
  if (running) return running;
  const run = probeAndRecord(db, taskId, provider, adapter).finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

const PROBE_NETWORK_POLICY: CliNetworkPolicy = { mode: 'none', domains: [], ips: [] };

async function probeAndRecord(
  db: Database,
  taskId: string,
  provider: CliProviderRecord,
  adapter: BaseCliAdapter,
): Promise<CodexAppServerVerdict | null> {
  try {
    // Another dispatch may have recorded one while this one decided to probe.
    const recorded = currentCodexAppServerVerdict(
      await loadCodexAppServerVerdicts(db, taskId),
      provider,
    );
    if (recorded) return recorded;

    // The provider's own image, resolved WITHOUT building: a probe must never hold a task advance
    // for a multi-minute build. The run itself installs the same CLI version, so the binary matches.
    const image = resolveImageTag({
      name: provider.name,
      cliVersion: provider.cliVersion?.trim() || null,
      providerId: provider.id,
      sandboxDockerfileExtra: provider.sandboxDockerfileExtra,
    });
    if (!image || !(await defaultDockerRunner.inspect(image.tag)).exists) {
      log.info(
        { taskId, providerId: provider.id },
        'codex app-server probe skipped: sandbox image not built yet',
      );
      return null;
    }

    // Exactly the argv, wrapper, model and effort a steerable run sends.
    const spec = adapter.buildCliInvocation(provider, PROBE_PROMPT, { steeringMode: true });
    const turn = spec.codexAppServer;
    if (!turn) return null;
    const outcome = await runCodexAppServerProbe(
      (io) =>
        runInSandbox(
          {
            command: spec.command,
            args: spec.args,
            env: spec.env,
            wrapperContent: provider.wrapperContent,
            interactive: true,
            onStdinWritable: io.onStdinWritable,
            onStdoutChunk: io.onStdout,
            signal: io.signal,
            timeoutMs: io.timeoutMs,
          },
          { image: image.tag, networkPolicy: PROBE_NETWORK_POLICY, egressDomains: [], taskId },
        ),
      { model: turn.model, effort: turn.effort },
    );

    if (outcome.kind === 'inconclusive') {
      log.warn(
        { taskId, providerId: provider.id, detail: outcome.detail },
        'codex app-server probe inconclusive; dispatching codex exec',
      );
      return null;
    }
    const verdict = codexAppServerVerdict(provider, {
      status: outcome.kind,
      binaryVersion: outcome.binaryVersion,
      stage: outcome.kind === 'unsupported' ? outcome.stage : null,
      detail: outcome.kind === 'unsupported' ? outcome.detail : null,
      source: 'probe',
    });
    await recordCodexAppServerVerdict(db, taskId, provider.id, verdict);
    log.info(
      { taskId, providerId: provider.id, verdict },
      'codex app-server probe recorded a verdict',
    );
    return verdict;
  } catch (err) {
    log.warn(
      { err, taskId, providerId: provider.id },
      'codex app-server probe could not run; dispatching codex exec',
    );
    return null;
  }
}
