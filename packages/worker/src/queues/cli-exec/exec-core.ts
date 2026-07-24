import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  CLI_SOFT_TIMEOUT_WIND_DOWN,
  CONFIG_KEYS,
  STEER_IN_CHANNEL_PREFIX,
  configService,
  type CliExecInvocationKind,
  type CliExecJobPayload,
  type CliNetworkPolicy,
  type CliProviderName,
  type CliTokenUsage,
} from '@haive/shared';
import { DEFAULT_RUN_TIMEOUT_MS, type DockerVolumeMount } from '../../sandbox/docker-runner.js';
import { SANDBOX_WORKDIR, type SandboxExtraFile } from '../../sandbox/sandbox-runner.js';
import { cliAdapterRegistry } from '../../cli-adapters/registry.js';
import type { CliCommandSpec } from '../../cli-adapters/types.js';
import {
  createCodexJsonlCollector,
  extractGeminiJsonOutput,
  type CliExecutionResult,
  type CliSpawner,
  type SpawnOptions,
} from '../../cli-executor/index.js';
import { runInSandbox } from '../../sandbox/sandbox-runner.js';
import {
  publishCliChunk,
  publishCliSteerConsumed,
  wrapStreamCallback,
} from '../cli-stream-publisher.js';
import { log, type CliExecDeps, type ExecutionOutcome } from './_shared.js';
import { createStreamJsonCollector } from './stream.js';
import { looksLikeJson, proseForClean } from './clean-output.js';
import { createSteerForwarder, type SteerForwarder } from './steer-forwarder.js';
import { createSteerTracker } from './steer-tracker.js';
import { getRedis } from '../../redis.js';
import type { Redis } from 'ioredis';
import {
  createStepStatusUpdater,
  ensureRepoMountWritable,
  loadProviderRuntimeConfig,
  resolveAuthMounts,
  resolveMcpExtraFiles,
  resolveInvocationRepoMount,
  tryJsonParse,
  WORKER_REPO_STORAGE_ROOT,
} from './resolvers.js';
import { executeSubAgentNative, executeSubAgentSequential } from './sub-agent.js';
import { resolveSecretMasks } from './secret-mask.js';
import { worktreeGitfileMask } from './gitfile-mask.js';
import { makeUsageSnapshotPersister } from './running-usage.js';
import {
  classifyAntigravityDiagnostic,
  classifyProviderFatal,
  PROVIDER_FATAL_HEADLINES,
  type ProviderFatalClass,
} from './failure-class.js';

/** Throttle for persisting running token-usage snapshots during a CLI stream.
 *  ~40 writes/min/invocation at most — cheap, safe under the 7-task cap. */
const RUNNING_USAGE_INTERVAL_MS = 1500;

const PROVIDER_LOGIN_HINTS: Record<string, string> = {
  'claude-code': 'claude /login',
  codex: 'codex login',
  amp: 'amp login',
  zai: 'zai login',
};

// Providers authenticated by an API-key secret rather than an interactive CLI
// login. On auth failure the hint points at the Haive-stored secret, since
// there is no login command to run. Gemini is BYOK-only after its subscription
// login path was removed.
const PROVIDER_API_KEY_HINTS: Record<string, string> = {
  gemini: 'GEMINI_API_KEY',
};

// Providers whose login happens inside Haive (interactive OAuth on the providers
// page), not via a terminal command. On auth failure, point users there.
const PROVIDER_HAIVE_LOGIN: ReadonlySet<string> = new Set(['antigravity']);

// Exit codes that mean the process was terminated rather than exiting on its
// own: 130 (SIGINT), 137 (SIGKILL — task cancel and step stop-&-retry force-
// remove the container, which surfaces as 137), 143 (SIGTERM). Together with a
// null exit code (the spawn killing the client on timeout/abort) these are the
// "we stopped it" signals. A terminated run is never an auth failure, and its
// partial output — often the model mid-analysis of the repo — must not reach
// the auth heuristic below, which false-matches any codebase that discusses
// login / tokens / 401 / unauthorized.
const TERMINATION_EXIT_CODES: ReadonlySet<number> = new Set([130, 137, 143]);

export function interpretCliFailure(
  result: ExecutionOutcome,
  providerName: string | null,
): string | null {
  const existing = result.errorMessage ?? null;
  // agy (antigravity) swallows provider-fatal errors to its own log file and ALWAYS
  // exits 0 with empty output, so the exit-code gate below can't see them. Classify
  // from the captured agy diagnostic log — anchored on agy's gRPC error structure and
  // gated on EMPTY output so a transient-429-then-success run (non-empty output whose
  // log still mentions 429) is never misclassified. Above the exit-0/termination
  // returns so it also catches a hypothetical future agy that exits non-zero.
  if (
    providerName === 'antigravity' &&
    result.parsedOutput == null &&
    (result.rawOutput ?? '').trim().length === 0
  ) {
    const agy = classifyAntigravityDiagnostic(result.providerDiagnosticLog ?? null);
    if (agy) {
      return buildProviderFatalMessage(agy.class, providerName, formatAuthDetail(agy.detail));
    }
  }
  if (result.exitCode === 0) return existing;
  if (result.exitCode === null || TERMINATION_EXIT_CODES.has(result.exitCode)) {
    return 'CLI process was stopped before it finished (cancelled or timed out).';
  }

  // Persistent provider failures (rate-limit/quota, bad/expired auth, 5xx outage)
  // will not recover within this run. Headline them with a stable internal prefix
  // so looping consumers (isFatalProviderFailure → DAG escalation, merge-fix retry)
  // fail the task fast instead of re-dispatching agents against a dead provider.
  const fatalClass = classifyProviderFatal(
    result.exitCode,
    existing,
    result.providerErrorScan ?? result.rawOutput,
  );
  if (!fatalClass) return existing;
  return buildProviderFatalMessage(fatalClass, providerName, formatAuthDetail(existing));
}

/** Build the headlined provider-fatal errorMessage for a class + detail. Shared by the
 *  exit-code path (interpretCliFailure) and the antigravity exit-0 diagnostic-log path.
 *  `detail` is the parenthesized excerpt already formatted by formatAuthDetail. */
function buildProviderFatalMessage(
  fatalClass: ProviderFatalClass,
  providerName: string | null,
  detail: string,
): string {
  if (fatalClass === 'auth') {
    const apiKeyName = providerName ? PROVIDER_API_KEY_HINTS[providerName] : null;
    const loginCmd = providerName ? PROVIDER_LOGIN_HINTS[providerName] : null;
    const hint = apiKeyName
      ? `check or replace the \`${apiKeyName}\` secret for this provider in Haive settings and then retry this step`
      : providerName && PROVIDER_HAIVE_LOGIN.has(providerName)
        ? `log in to ${providerName} from the Haive providers page (Test connection then Log in) and then retry this step`
        : loginCmd
          ? `run \`${loginCmd}\` in your terminal and then retry this step`
          : 're-authenticate your CLI in your terminal and then retry this step';
    return `${PROVIDER_FATAL_HEADLINES.auth} — ${hint}.${detail}`;
  }
  const hint =
    fatalClass === 'rate_limit'
      ? "the provider's usage limit or quota is exhausted; retry this task once it resets"
      : 'the provider returned a server error (service unavailable); retry this task when it recovers';
  return `${PROVIDER_FATAL_HEADLINES[fatalClass]} — ${hint}.${detail}`;
}

// Keep the auth headline readable: the full CLI output stays on the
// invocation's rawOutput / stream_log for the terminal viewer, so the message
// only needs a short excerpt, not a multi-KB stdout dump.
function formatAuthDetail(existing: string | null): string {
  const trimmed = existing?.trim();
  if (!trimmed) return '';
  const capped = trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
  return ` (${capped})`;
}

/** Ollama inference (especially local, on weak hardware) can take many minutes
 *  per turn. Floor the invocation timeout for Ollama providers so a slow
 *  response isn't SIGKILLed mid-generation; non-Ollama providers keep their
 *  per-step timeout unchanged. */
async function resolveInvocationTimeoutMs(
  requested: number | undefined,
  provider: { name: CliProviderName } | null | undefined,
): Promise<number | undefined> {
  if (provider?.name !== 'ollama') return requested;
  const floor = await configService.getNumber(CONFIG_KEYS.OLLAMA_CLI_TIMEOUT_MS, 7_200_000);
  return Math.max(requested ?? 0, floor);
}

/** A read-only bind of the task's OWN uploads dir into the sandbox, at the path the
 *  attachment prompt points to (`<SANDBOX_WORKDIR>/.haive/task-uploads/<taskId>`). Uploads
 *  live at the repo root under `.haive/` (git-excluded), so the worktree-only mount hides
 *  them — bind just this task's dir back in (never sibling tasks' uploads). Volume-mounted
 *  repos only: a bind (local) repo keeps its repo-root mount so uploads are already visible,
 *  and a repo-less task has none. Returns null when the task has no attachments (matching
 *  augmentPromptWithAttachments' gate) or the dir isn't present (skip rather than fail the
 *  docker mount). */
async function resolveTaskUploadsMount(
  db: Database,
  taskId: string,
  repoMount: DockerVolumeMount | null,
): Promise<DockerVolumeMount | null> {
  if (!repoMount?.subpath) return null;
  const rows = await db.query.taskAttachments.findMany({
    where: eq(schema.taskAttachments.taskId, taskId),
    columns: { id: true },
    limit: 1,
  });
  if (rows.length === 0) return null;
  const repoBase = repoMount.subpath.split('/').slice(0, 2).join('/');
  const uploadsSubpath = `${repoBase}/.haive/task-uploads/${taskId}`;
  const present = await stat(join(WORKER_REPO_STORAGE_ROOT, uploadsSubpath))
    .then((s) => s.isDirectory())
    .catch(() => false);
  if (!present) return null;
  return {
    source: repoMount.source,
    target: `${SANDBOX_WORKDIR}/.haive/task-uploads/${taskId}`,
    subpath: uploadsSubpath,
    readOnly: true,
  };
}

export async function executeByKind(
  db: Database,
  payload: CliExecJobPayload,
  deps: CliExecDeps,
  secrets: Record<string, string>,
): Promise<ExecutionOutcome> {
  // Isolate this invocation to ONE git worktree: mount it ALONE at the workdir root
  // (payload.worktreeSubpath for a DAG/merge sibling, else the task's feature worktree)
  // so the agent cannot reach the repo-root checkout or any sibling worktree. The
  // worktree IS the mount root, so the container workdir is SANDBOX_WORKDIR.
  const { repoMount, hasWorktree } = await resolveInvocationRepoMount(
    db,
    payload.taskId,
    payload.worktreeRel,
  );
  await ensureRepoMountWritable(repoMount);
  const sandboxWorkdir = SANDBOX_WORKDIR;
  // Empty-file masks hiding deny-listed secret files from the agent (Tier 1,
  // untracked-only). Applied to every cli-exec kind; the app runtime mounts the
  // same repo volume WITHOUT these masks, so the running app still sees them.
  // The worktree gitfile mask rides the same mechanism but is an integrity control,
  // not a secrecy one — it is never gated by the secret-mask kill-switch.
  const maskFiles = [
    ...(await resolveSecretMasks(db, payload.taskId, repoMount)),
    ...worktreeGitfileMask(hasWorktree),
  ];
  switch (payload.kind) {
    case 'cli':
    case 'agent_mining': {
      const { wrapperContent, sandboxImage, networkPolicy, egressDomains } =
        await loadProviderRuntimeConfig(db, payload.cliProviderId, payload.taskId);
      const providerRow = payload.cliProviderId
        ? await db.query.cliProviders.findFirst({
            where: eq(schema.cliProviders.id, payload.cliProviderId),
          })
        : null;
      let authMounts: DockerVolumeMount[] = [];
      if (providerRow && cliAdapterRegistry.has(providerRow.name)) {
        authMounts = await resolveAuthMounts(db, providerRow, payload.taskId);
      }
      // The task's own uploads dir (read-only) so the agent can read attachments the
      // prompt references — the worktree-only mount hides the repo-root .haive/ otherwise.
      const uploadsMount = await resolveTaskUploadsMount(db, payload.taskId, repoMount);
      if (uploadsMount) authMounts.push(uploadsMount);
      const mcp = providerRow
        ? await resolveMcpExtraFiles(
            db,
            payload.taskId,
            providerRow.name as CliProviderName,
            sandboxWorkdir,
            // Knowledge-mining invocations get a rag-only MCP surface, as does any
            // step that declared toolProfile='rag_only' (report-only steps that
            // cannot act on a browser or a container).
            payload.kind === 'agent_mining' || payload.toolProfile === 'rag_only',
          )
        : { files: [], extraArgs: [] };
      const statusUpdater = payload.taskStepId
        ? createStepStatusUpdater(db, payload.taskStepId, payload.invocationId)
        : undefined;
      const timeoutMs = await resolveInvocationTimeoutMs(payload.timeoutMs, providerRow);
      return executeCliSpec(
        payload.spec as CliCommandSpec,
        deps,
        timeoutMs,
        secrets,
        wrapperContent,
        sandboxImage,
        repoMount,
        sandboxWorkdir,
        networkPolicy,
        egressDomains,
        [...mcp.files, ...maskFiles],
        authMounts,
        statusUpdater,
        payload.taskId ?? null,
        payload.invocationId ?? null,
        mcp.extraArgs,
        makeUsageSnapshotPersister(db, payload.invocationId),
        payload.softTimeout === true,
      );
    }
    case 'subagent_sequential':
      return executeSubAgentSequential(db, payload, secrets, repoMount, sandboxWorkdir, maskFiles);
    case 'subagent_native':
      return executeSubAgentNative(
        db,
        payload,
        deps,
        secrets,
        repoMount,
        sandboxWorkdir,
        maskFiles,
      );
    default:
      throw new Error(
        `unknown cli exec kind: ${(payload as { kind: CliExecInvocationKind }).kind}`,
      );
  }
}

export async function executeCliSpec(
  spec: CliCommandSpec,
  deps: CliExecDeps,
  timeoutMs?: number,
  secrets: Record<string, string> = {},
  wrapperContent: string | null = null,
  sandboxImage: string | null = null,
  repoMount: DockerVolumeMount | null = null,
  sandboxWorkdir: string = SANDBOX_WORKDIR,
  networkPolicy: CliNetworkPolicy | null = null,
  egressDomains: string[] = [],
  extraFiles: SandboxExtraFile[] = [],
  authMounts: DockerVolumeMount[] = [],
  statusCallback?: (message: string) => void,
  taskId: string | null = null,
  invocationId: string | null = null,
  mcpExtraArgs: string[] = [],
  onUsageSnapshot?: (usage: CliTokenUsage | null) => void,
  softTimeout = false,
): Promise<ExecutionOutcome> {
  const mergedSpec: CliCommandSpec = {
    ...spec,
    args: mcpExtraArgs.length > 0 ? [...spec.args, ...mcpExtraArgs] : spec.args,
    env: { ...spec.env, ...secrets },
  };
  // Ollama's key is intuitively named OLLAMA_API_KEY, but the claude binary
  // authenticates with ANTHROPIC_AUTH_TOKEN. A key stored as a secret merges in
  // above (post-build, so the adapter couldn't see it); map it onto the token
  // here unless an explicit Anthropic token was set (the adapter's 'ollama'
  // placeholder counts as unset). Harmless for non-Ollama providers.
  if (
    mergedSpec.env.OLLAMA_API_KEY &&
    (!mergedSpec.env.ANTHROPIC_AUTH_TOKEN || mergedSpec.env.ANTHROPIC_AUTH_TOKEN === 'ollama')
  ) {
    mergedSpec.env.ANTHROPIC_AUTH_TOKEN = mergedSpec.env.OLLAMA_API_KEY;
    mergedSpec.env.ANTHROPIC_API_KEY = mergedSpec.env.OLLAMA_API_KEY;
  }
  // Global opt-in: when prompt-caching-1h is ON, ask the claude binary to use the
  // 1-hour cache TTL (default 5-min on API-key/Bedrock; subscription is already 1h).
  // Gated on the claude-family stream-json output so codex/gemini are untouched;
  // harmless on non-Anthropic claude-family backends (zai/ollama ignore the flag).
  if (
    mergedSpec.outputFormat === 'claude-stream-json' &&
    (await configService.getBoolean(CONFIG_KEYS.PROMPT_CACHING_1H, false))
  ) {
    mergedSpec.env.ENABLE_PROMPT_CACHING_1H = '1';
  }
  const spawner: CliSpawner = createSandboxSpawner(
    wrapperContent,
    sandboxImage,
    repoMount,
    sandboxWorkdir,
    networkPolicy,
    egressDomains,
    extraFiles,
    authMounts,
    taskId,
    invocationId,
  );

  // Capture exactly what the live WS viewer sees (header + every stdout/
  // stderr chunk) into a buffer so we can persist it to cli_invocations.
  // stream_log for historical replay. The spawner's wrapStreamCallback
  // publishes to Redis AND invokes our tees here, so the buffer matches
  // the bytes the user saw.
  const streamBuf: string[] = [];
  const headerText = formatCliHeader(mergedSpec, sandboxWorkdir);
  if (invocationId) {
    await publishCliChunk(invocationId, 'stdout', headerText);
  }
  streamBuf.push(headerText);

  // Hook stdout for structured-output parsing. Codex's JSONL events carry
  // string `type` fields that would satisfy the claude collector's event
  // heuristic while never producing a result event — so the codex collector
  // REPLACES the claude collector (mutually exclusive), it does not run
  // alongside it.
  const outputFormat = mergedSpec.outputFormat;
  // Publish the model's prose text (assistant text blocks / codex agent_message)
  // as a dedicated `text` frame so the terminal viewer's Clean tab can render
  // readable output instead of the raw NDJSON. Live runs only (needs an
  // invocation stream); replay reuses the persisted rawOutput.
  const onProseText = invocationId
    ? (text: string) => {
        void publishCliChunk(invocationId, 'text', text);
      }
    : undefined;
  // Mid-run steering: for a steerable invocation, subscribe a dedicated Redis
  // connection to this invocation's steer channel and forward each message to
  // the CLI's stdin. The collector's onResult latches the forwarder closed (end
  // stdin so the CLI exits after its turn). See steer-forwarder.ts.
  const steerable = mergedSpec.steerable === true && !!invocationId;
  let steer: SteerForwarder | null = null;
  // Drains the tracker at each tool-call boundary and publishes a consumed frame
  // per steer. Defined only for a steerable invocation; passed to the collector.
  let onSteerBoundary: (() => void) | undefined;
  if (steerable && invocationId) {
    const channel = `${STEER_IN_CHANNEL_PREFIX}${invocationId}`;
    // A subscriber connection is mode-locked — duplicate the shared client
    // rather than reuse it (Hole E). Subscribe BEFORE the spawner starts so an
    // instantly-published steer isn't missed.
    const sub: Redis = getRedis().duplicate();
    // The forwarder records each written steer; the boundary callback (fed to
    // the collector below) reports them consumed when Claude drains the queue.
    const tracker = createSteerTracker();
    steer = createSteerForwarder({
      subscriber: sub,
      onWritten: (s) => tracker.recordWritten(s),
    });
    onSteerBoundary = () => {
      for (const s of tracker.drainConsumed()) {
        void publishCliSteerConsumed(invocationId, s.id);
      }
    };
    await sub.subscribe(channel);
  }
  // Soft timeout: the hard one is a zero-grace SIGKILL, so a reviewer that runs its full
  // budget loses every finding it made. Well before that, ask it to bank the verified
  // ones. Opt-in per invocation, because for a step that WRITES (code, files, skills) an
  // early "emit now" turns a loud timeout into a silent partial success — strictly worse
  // than the kill. Published to the SAME steer channel rather than written straight to
  // the captured stdin: that reuses the forwarder's sawResult latch, its
  // writable.writable guard and its EPIPE swallow. It also stays out of the api's steer
  // route, which would write a `steering.nudge` task_event — _task-history-digest reads
  // those as a human-friction signal, and an automated wind-down is not friction.
  const softTimeoutTimer =
    steerable && invocationId && softTimeout
      ? await scheduleSoftTimeout(invocationId, timeoutMs)
      : null;

  const collector = createStreamJsonCollector(
    statusCallback,
    onProseText,
    steer ? steer.onResult : undefined,
    onSteerBoundary,
  );
  const codexCollector =
    outputFormat === 'codex-jsonl' ? createCodexJsonlCollector(onProseText) : null;

  // While the CLI streams, persist a running token-usage snapshot on a throttle
  // so the task page + terminal polls show a live, growing count before the
  // invocation completes. getTokenUsage() returns the running total mid-stream;
  // we skip when it hasn't changed. Cleared before returning (incl. on throw);
  // the final authoritative tokenUsage is written on completion (handlers.ts).
  let usageTimer: ReturnType<typeof setInterval> | null = null;
  if (onUsageSnapshot) {
    let lastUsageJson = '';
    usageTimer = setInterval(() => {
      const usage = (codexCollector ?? collector).getTokenUsage();
      if (!usage) return;
      const json = JSON.stringify(usage);
      if (json === lastUsageJson) return;
      lastUsageJson = json;
      onUsageSnapshot(usage);
    }, RUNNING_USAGE_INTERVAL_MS);
  }

  let result: CliExecutionResult;
  try {
    result = await spawner(mergedSpec, {
      timeoutMs,
      onStdoutChunk: (chunk: string) => {
        streamBuf.push(chunk);
        if (codexCollector) codexCollector.onChunk(chunk);
        else collector.onChunk(chunk);
      },
      onStderrChunk: (chunk: string) => {
        streamBuf.push(chunk);
      },
      onStdinWritable: steer ? steer.captureWritable : undefined,
    });
  } finally {
    if (usageTimer) clearInterval(usageTimer);
    if (softTimeoutTimer) clearTimeout(softTimeoutTimer);
    if (steer) steer.teardown();
  }
  const streamLog = streamBuf.join('');
  // Raw CLI stdout+stderr tail for provider-fatal classification. rawOutput is
  // now sanitized for the Clean tab (prose or empty), so it can no longer carry
  // an API error the classifier needs. Excludes the header/prompt (which
  // streamLog includes) so a task spec mentioning "rate limit"/"401" cannot
  // false-positive. See interpretCliFailure / classifyProviderFatal.
  const providerErrorScan = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.slice(-4000);
  void deps;

  if (codexCollector && codexCollector.isJsonl()) {
    const codexText = codexCollector.getResult();
    const tokenUsage = codexCollector.getTokenUsage();
    if (codexText !== null) {
      // rawOutput = the model's answer text — the step parsers' fenced-JSON
      // contract (parsedOutput ?? rawOutput) is preserved.
      return {
        exitCode: result.exitCode,
        rawOutput: codexText,
        parsedOutput: tryJsonParse(codexText),
        errorMessage: formatCliErrorMessage(
          result.exitCode,
          result.stderr,
          codexText,
          result.error,
        ),
        tokenUsage,
        streamLog,
      };
    }
    // JSONL stream without an agent message — partial usage is still recorded.
    // No prose to recover; keep the raw codex JSONL out of the Clean tab.
    return {
      exitCode: result.exitCode,
      rawOutput: proseForClean('', result.stdout),
      parsedOutput: null,
      errorMessage:
        result.error ??
        formatCliErrorMessage(result.exitCode, result.stderr, result.stdout, undefined) ??
        codexCollector.getNoResultReason() ??
        'codex emitted no agent message',
      tokenUsage,
      streamLog,
      providerErrorScan,
    };
  }
  // codexCollector with zero events: old binary ignored --json — fall through
  // to the plain path below, byte-for-byte legacy behavior (usage null).

  const streamResult = collector.getResult();
  if (collector.isStreamJson() && streamResult !== null) {
    const malformedLines = collector.getMalformedLineCount();
    const assistantText = collector.getAssistantText();
    // Cross-check: does the result event's payload match the concatenation of
    // assistant text deltas? Divergence implies claude-code's result-event
    // synthesis is dropping/duplicating content (a binary bug). Identical
    // payloads mean the model itself produced what we got.
    if (assistantText.length > 0 && assistantText !== streamResult) {
      const sameLength = streamResult.length === assistantText.length;
      let firstDivergeIdx = -1;
      const minLen = Math.min(streamResult.length, assistantText.length);
      for (let i = 0; i < minLen; i++) {
        if (streamResult[i] !== assistantText[i]) {
          firstDivergeIdx = i;
          break;
        }
      }
      if (firstDivergeIdx === -1) firstDivergeIdx = minLen;
      log.warn(
        {
          command: spec.command,
          resultLen: streamResult.length,
          assistantTextLen: assistantText.length,
          sameLength,
          firstDivergeIdx,
          malformedLines,
          resultSnippet: streamResult.slice(
            Math.max(0, firstDivergeIdx - 40),
            firstDivergeIdx + 40,
          ),
          assistantSnippet: assistantText.slice(
            Math.max(0, firstDivergeIdx - 40),
            firstDivergeIdx + 40,
          ),
        },
        'stream-json result event diverges from concatenated assistant deltas',
      );
    } else if (malformedLines > 0) {
      log.warn({ command: spec.command, malformedLines }, 'stream-json had malformed lines');
    }
    return {
      exitCode: result.exitCode,
      rawOutput: streamResult,
      parsedOutput: tryJsonParse(streamResult),
      errorMessage: formatCliErrorMessage(
        result.exitCode,
        result.stderr,
        streamResult,
        result.error,
      ),
      tokenUsage: collector.getTokenUsage(),
      streamLog,
    };
  }

  if (collector.isStreamJson() && streamResult === null) {
    const reason = collector.getNoResultReason() ?? 'LLM emitted no result event';
    // No `result` event (run killed/timed-out/aborted, e.g. exit 137). Store the
    // assistant prose that DID stream — NOT result.stdout, which is the full raw
    // NDJSON: it becomes the Clean tab's replay source (raw_output ->
    // staticCleanOutput) and would render as raw protocol, ballooning Clean to MBs.
    // The full raw stream stays in streamLog (the Raw tab). Falls back to
    // result.stdout only when no prose streamed at all — preserving prior behavior
    // and the provider-fatal rawOutput tail scan for that case.
    const partialProse = proseForClean(collector.getAssistantText(), result.stdout);
    return {
      exitCode: result.exitCode,
      rawOutput: partialProse,
      parsedOutput: null,
      errorMessage:
        result.error ??
        formatCliErrorMessage(result.exitCode, result.stderr, result.stdout, undefined) ??
        reason,
      // Tokens were burned even without a result event (e.g. error_max_turns).
      tokenUsage: collector.getTokenUsage(),
      streamLog,
      providerErrorScan,
    };
  }

  if (outputFormat === 'gemini-json') {
    // Gemini JSON mode wraps the answer: {response, stats}. Unwrap so the
    // step parsers see the model's text; extraction failure (older binary,
    // ignored flag, crash output) falls through to the legacy plain return.
    const extracted = extractGeminiJsonOutput(result.stdout);
    if (extracted) {
      return {
        exitCode: result.exitCode,
        rawOutput: extracted.responseText,
        parsedOutput: tryJsonParse(extracted.responseText),
        errorMessage: formatCliErrorMessage(
          result.exitCode,
          result.stderr,
          extracted.responseText,
          result.error,
        ),
        tokenUsage: extracted.tokenUsage,
        streamLog,
      };
    }
    // Extraction failed. A JSON envelope here (the wrapper we could not unwrap,
    // or crash output) must not reach Clean — empty raw_output instead of raw
    // JSON. Plain text (an older binary that ignored --output-format json) is
    // genuine prose and falls through to the plain return below.
    if (looksLikeJson(result.stdout)) {
      return {
        exitCode: result.exitCode,
        rawOutput: '',
        parsedOutput: null,
        errorMessage: formatCliErrorMessage(
          result.exitCode,
          result.stderr,
          result.stdout,
          result.error,
        ),
        tokenUsage: null,
        streamLog,
        providerErrorScan,
      };
    }
  }

  // Plain/last-resort path (no structured format, or a collector that saw zero
  // events). Keep stdout as prose unless it is actually machine protocol. antigravity
  // lands here (no outputFormat); its captured agy log rides providerDiagnosticLog for
  // the exit-0 fatal classification in interpretCliFailure.
  return {
    exitCode: result.exitCode,
    rawOutput: proseForClean('', result.stdout),
    parsedOutput: tryJsonParse(result.stdout),
    errorMessage: formatCliErrorMessage(
      result.exitCode,
      result.stderr,
      result.stdout,
      result.error,
    ),
    tokenUsage: collector.getTokenUsage(),
    streamLog,
    providerErrorScan,
    providerDiagnosticLog: result.capturedLog ?? undefined,
  };
}

/**
 * Build a user-facing error message for a CLI invocation.
 *
 * Surfaces content in priority order: spawn error (timeout, crash) → stderr tail
 * → stdout tail. Stdout fallback catches cases where CLIs like Claude Code or
 * Z.AI emit the API error on stdout (e.g. "API Error: {...code:500}") and exit
 * non-zero with empty stderr.
 */
export function formatCliErrorMessage(
  exitCode: number | null,
  stderr: string,
  stdout: string,
  spawnError: string | undefined,
): string | null {
  if (spawnError) return spawnError;
  if (exitCode === 0) return null;
  const stderrTail = stripBenignCliNoise(stderr);
  if (stderrTail.length > 0) return stderrTail.slice(-2000);
  const stdoutTail = stripBenignCliNoise(stdout);
  if (stdoutTail.length > 0) return stdoutTail.slice(-2000);
  return `cli exited with code ${exitCode ?? 'unknown'}`;
}

// CLIs print benign advisories that are NOT failure causes but were becoming the
// surfaced error (each was the stderr/stdout tail and masked the real message):
//  - claude-code, when its `.claude.json` seed is absent ("Claude configuration
//    file not found … A backup file exists … restore by running: cp …"); it then
//    continues with a fallback.
//  - codex, "Reading additional input from stdin..." — printed while it keeps
//    stdin open for steering; the real error (e.g. "You've hit your usage limit")
//    lands on the other stream / later in the same one.
// Strip these lines so the genuine error — or the stdout fallback — surfaces. The
// full text stays in rawOutput/streamLog. The advisory strings are volatile
// upstream wording: if reworded we simply stop stripping (show it), never crash.
const BENIGN_CLI_NOISE_LINE =
  /^(Claude configuration file not found at:|A backup file exists at:|You can manually restore it by running:|Reading additional input from stdin)/;

function stripBenignCliNoise(text: string): string {
  return text
    .split('\n')
    .filter((line) => !BENIGN_CLI_NOISE_LINE.test(line.trim()))
    .join('\n')
    .trim();
}

export function quoteArg(arg: string): string {
  // Pretty-print quoting for the terminal viewer. Output stays a valid
  // shell-quoted token (copy-paste works) but prefers whichever quote style
  // keeps the body readable:
  //   - no special chars     -> bare
  //   - has `'` only         -> double-quoted (apostrophe doesn't need escape)
  //   - everything else      -> single-quoted (no inner escaping needed at all)
  // The previous version always used POSIX `'\''` close-reopen escapes which
  // are technically correct but visually noisy when the prompt body has
  // English contractions ("don't", "it's").
  if (arg === '' || /[\s"'`$\\!<>|&;()[\]*?#~]/.test(arg)) {
    if (arg.includes("'") && !/[`$\\]/.test(arg)) {
      // Safe to use double quotes: only `"`, `\`, `$`, backtick require
      // escaping inside `"..."`, and we just confirmed none of `$ \\ \``
      // appear. Escape any literal `"` so the wrapping quotes stay matched.
      return `"${arg.replace(/"/g, '\\"')}"`;
    }
    // Single-quoted form. If the arg ALSO contains `'`, fall back to the
    // POSIX close-escape-reopen idiom — uglier but still copy-pasteable.
    return `'${arg.replace(/'/g, `'\\''`)}'`;
  }
  return arg;
}

export function formatCliHeader(spec: CliCommandSpec, workdir: string): string {
  // Echo the full untruncated invocation. Long prompts (a couple of KB
  // including system-prompt payloads) wrap in xterm but stay in scrollback,
  // which is the observability win — being able to copy-paste the exact
  // command is more valuable than keeping the header to a single line.
  const parts = [spec.command, ...spec.args.map(quoteArg)];
  const cmdLine = parts.join(' ');
  // ANSI: dim grey for metadata, cyan `$` prompt, default for the command.
  // \r\n keeps xterm aligned across line endings.
  let header = `\x1b[2m# workdir: ${workdir}\x1b[0m\r\n` + `\x1b[36m$\x1b[0m ${cmdLine}\r\n`;
  // Steering mode feeds the prompt on stdin (NDJSON), so the command line above
  // omits it — surface it on its own line so the viewer still shows what was
  // asked.
  if (spec.stdinInitial) {
    const promptText = extractStdinPromptText(spec.stdinInitial);
    if (promptText) header += `\x1b[2m# stdin prompt: ${promptText}\x1b[0m\r\n`;
  }
  return header;
}

/** Pull the human prompt text out of a steering stdinInitial NDJSON line for the
 *  terminal header. Returns '' if it isn't the expected user-message shape. */
function extractStdinPromptText(stdinInitial: string): string {
  try {
    const obj = JSON.parse(stdinInitial.trim()) as {
      message?: { content?: Array<{ type?: string; text?: string }> };
    };
    const blocks = obj.message?.content ?? [];
    return blocks.map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('');
  } catch {
    return '';
  }
}

/** Delay before the wind-down fires, or null when it must not fire at all.
 *
 *  Null at percent <= 0 (the wind-down would land before the CLI has read anything)
 *  and at percent >= 100 (it would land after the SIGKILL). A non-integer or NaN
 *  percent cannot reach here: configService.getNumber parses with parseInt and falls
 *  back to the default. A zero or negative budget has no room for a wind-down. */
export function softTimeoutDelayMs(timeoutMs: number, percent: number): number | null {
  if (percent <= 0 || percent >= 100 || timeoutMs <= 0) return null;
  const delay = Math.floor((timeoutMs * percent) / 100);
  return delay > 0 ? delay : null;
}

/** Arm the wind-down for a steerable invocation. Returns the timer so the caller can
 *  clear it once the CLI exits, or null when the soft timeout is off / mistuned.
 *  Best-effort: a config or publish failure must never fail the invocation. */
async function scheduleSoftTimeout(
  invocationId: string,
  timeoutMs: number | undefined,
): Promise<ReturnType<typeof setTimeout> | null> {
  let enabled: boolean;
  let percent: number;
  try {
    enabled = await configService.getBoolean(CONFIG_KEYS.CLI_SOFT_TIMEOUT_ENABLED, true);
    percent = await configService.getNumber(CONFIG_KEYS.CLI_SOFT_TIMEOUT_PERCENT, 80);
  } catch {
    return null;
  }
  if (!enabled) return null;
  // An invocation that named no timeout still gets one: the runner's default, which it
  // will SIGKILL on. Wind down against that, not against a step's absent number.
  const budgetMs = timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const delayMs = softTimeoutDelayMs(budgetMs, percent);
  if (delayMs === null) {
    log.warn({ invocationId, percent, budgetMs }, 'soft timeout skipped: percent out of range');
    return null;
  }
  return setTimeout(() => {
    // Whole body guarded: getRedis() THROWS when redis is uninitialized, and it throws
    // synchronously, before .publish() can attach a .catch(). An uncaught throw inside
    // a timer callback takes down the worker process, and a missed wind-down is a lost
    // review, not a lost worker.
    try {
      // id '' marks it as not a user steer. publishCliSteerConsumed drops an empty
      // steerId, so the wind-down never ticks a row in the user's steer list.
      const payload = JSON.stringify({ id: '', text: CLI_SOFT_TIMEOUT_WIND_DOWN });
      void getRedis()
        .publish(`${STEER_IN_CHANNEL_PREFIX}${invocationId}`, payload)
        .then(() => log.info({ invocationId, delayMs, percent }, 'soft timeout: wind-down sent'))
        .catch((err: unknown) => log.warn({ err, invocationId }, 'soft timeout publish failed'));
    } catch (err) {
      log.warn({ err, invocationId }, 'soft timeout publish failed');
    }
  }, delayMs);
}

export function createSandboxSpawner(
  wrapperContent: string | null | undefined,
  sandboxImage: string | null = null,
  repoMount: DockerVolumeMount | null = null,
  sandboxWorkdir: string = SANDBOX_WORKDIR,
  networkPolicy: CliNetworkPolicy | null = null,
  egressDomains: string[] = [],
  extraFiles: SandboxExtraFile[] = [],
  authMounts: DockerVolumeMount[] = [],
  taskId: string | null = null,
  invocationId: string | null = null,
  mcpExtraArgs: string[] = [],
): CliSpawner {
  return async (spec, opts: SpawnOptions = {}): Promise<CliExecutionResult> => {
    const allMounts: DockerVolumeMount[] = [...authMounts];
    if (repoMount) allMounts.push(repoMount);
    const runnerOptions: Parameters<typeof runInSandbox>[1] = { workdir: sandboxWorkdir };
    if (sandboxImage) runnerOptions.image = sandboxImage;
    if (allMounts.length > 0) runnerOptions.extraMounts = allMounts;
    if (networkPolicy) runnerOptions.networkPolicy = networkPolicy;
    if (egressDomains.length > 0) runnerOptions.egressDomains = egressDomains;
    if (taskId) runnerOptions.taskId = taskId;
    const finalArgs = mcpExtraArgs.length > 0 ? [...spec.args, ...mcpExtraArgs] : spec.args;
    const result = await runInSandbox(
      {
        command: spec.command,
        args: finalArgs,
        env: spec.env,
        wrapperContent: wrapperContent ?? undefined,
        extraFiles: extraFiles.length > 0 ? extraFiles : undefined,
        timeoutMs: opts.timeoutMs,
        onStdoutChunk: wrapStreamCallback(invocationId, 'stdout', opts.onStdoutChunk),
        onStderrChunk: wrapStreamCallback(invocationId, 'stderr', opts.onStderrChunk),
        signal: opts.signal,
        interactive: spec.steerable === true,
        stdinInitial: spec.stdinInitial,
        onStdinWritable: opts.onStdinWritable,
        // Set only by the antigravity adapter — recover agy's own log file (where it
        // reports provider-fatal errors while exiting 0) out of the --rm sandbox.
        captureDir: spec.captureFile,
      },
      runnerOptions,
    );
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      error: result.error,
      capturedLog: result.capturedLog,
    };
  };
}
