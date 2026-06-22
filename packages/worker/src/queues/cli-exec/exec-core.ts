import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  CONFIG_KEYS,
  configService,
  type CliExecInvocationKind,
  type CliExecJobPayload,
  type CliNetworkPolicy,
  type CliProviderName,
  type CliTokenUsage,
} from '@haive/shared';
import type { DockerVolumeMount } from '../../sandbox/docker-runner.js';
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
import { publishCliChunk, wrapStreamCallback } from '../cli-stream-publisher.js';
import { log, type CliExecDeps, type ExecutionOutcome } from './_shared.js';
import { createStreamJsonCollector } from './stream.js';
import {
  createStepStatusUpdater,
  ensureRepoMountWritable,
  loadProviderRuntimeConfig,
  resolveAuthMounts,
  resolveMcpExtraFiles,
  resolveTaskRepoMount,
  resolveTaskSandboxWorkdir,
  tryJsonParse,
} from './resolvers.js';
import { executeSubAgentNative, executeSubAgentSequential } from './sub-agent.js';
import { resolveSecretMasks } from './secret-mask.js';
import { makeUsageSnapshotPersister } from './running-usage.js';

/** Throttle for persisting running token-usage snapshots during a CLI stream.
 *  ~40 writes/min/invocation at most — cheap, safe under the 7-task cap. */
const RUNNING_USAGE_INTERVAL_MS = 1500;

const AUTH_FAILURE_PATTERNS: RegExp[] = [
  /\b401\b/,
  /authentication_error/i,
  /invalid authentication credentials/i,
  /\bunauthorized\b/i,
  /\bunauthenticated\b/i,
  /please log.?in/i,
  /not authenticated/i,
  /token.*(expired|invalid)/i,
];

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
  if (result.exitCode === 0) return existing;
  if (result.exitCode === null || TERMINATION_EXIT_CODES.has(result.exitCode)) {
    return 'CLI process was stopped before it finished (cancelled or timed out).';
  }

  const haystack = [existing ?? '', result.rawOutput ?? ''].join('\n');
  const looksLikeAuth = AUTH_FAILURE_PATTERNS.some((p) => p.test(haystack));
  if (!looksLikeAuth) return existing;

  const apiKeyName = providerName ? PROVIDER_API_KEY_HINTS[providerName] : null;
  const loginCmd = providerName ? PROVIDER_LOGIN_HINTS[providerName] : null;
  const hint = apiKeyName
    ? `check or replace the \`${apiKeyName}\` secret for this provider in Haive settings and then retry this step`
    : providerName && PROVIDER_HAIVE_LOGIN.has(providerName)
      ? `log in to ${providerName} from the Haive providers page (Test connection then Log in) and then retry this step`
      : loginCmd
        ? `run \`${loginCmd}\` in your terminal and then retry this step`
        : 're-authenticate your CLI in your terminal and then retry this step';
  const detail = formatAuthDetail(existing);
  return `CLI authentication failed — ${hint}.${detail}`;
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

export async function executeByKind(
  db: Database,
  payload: CliExecJobPayload,
  deps: CliExecDeps,
  secrets: Record<string, string>,
): Promise<ExecutionOutcome> {
  const repoMount = await resolveTaskRepoMount(db, payload.taskId);
  await ensureRepoMountWritable(repoMount);
  const sandboxWorkdir = await resolveTaskSandboxWorkdir(db, payload.taskId);
  // Empty-file masks hiding deny-listed secret files from the agent (Tier 1,
  // untracked-only). Applied to every cli-exec kind; the app runtime mounts the
  // same repo volume WITHOUT these masks, so the running app still sees them.
  const maskFiles = await resolveSecretMasks(db, payload.taskId);
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
      const mcp = providerRow
        ? await resolveMcpExtraFiles(
            db,
            payload.taskId,
            providerRow.name as CliProviderName,
            sandboxWorkdir,
            // Knowledge-mining invocations get a rag-only MCP surface.
            payload.kind === 'agent_mining',
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
  const collector = createStreamJsonCollector(statusCallback, onProseText);
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
    });
  } finally {
    if (usageTimer) clearInterval(usageTimer);
  }
  const streamLog = streamBuf.join('');
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
    return {
      exitCode: result.exitCode,
      rawOutput: result.stdout,
      parsedOutput: null,
      errorMessage:
        result.error ??
        formatCliErrorMessage(result.exitCode, result.stderr, result.stdout, undefined) ??
        codexCollector.getNoResultReason() ??
        'codex emitted no agent message',
      tokenUsage,
      streamLog,
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
    return {
      exitCode: result.exitCode,
      rawOutput: result.stdout,
      parsedOutput: null,
      errorMessage:
        result.error ??
        formatCliErrorMessage(result.exitCode, result.stderr, result.stdout, undefined) ??
        reason,
      // Tokens were burned even without a result event (e.g. error_max_turns).
      tokenUsage: collector.getTokenUsage(),
      streamLog,
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
  }

  return {
    exitCode: result.exitCode,
    rawOutput: result.stdout,
    parsedOutput: tryJsonParse(result.stdout),
    errorMessage: formatCliErrorMessage(
      result.exitCode,
      result.stderr,
      result.stdout,
      result.error,
    ),
    tokenUsage: collector.getTokenUsage(),
    streamLog,
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
  const stderrTail = stripBenignConfigNoise(stderr);
  if (stderrTail.length > 0) return stderrTail.slice(-2000);
  const stdoutTail = stdout.trim();
  if (stdoutTail.length > 0) return stdoutTail.slice(-2000);
  return `cli exited with code ${exitCode ?? 'unknown'}`;
}

// claude-code prints a benign advisory to STDERR when its `.claude.json` seed is
// absent ("Claude configuration file not found … A backup file exists … restore
// by running: cp …"). It then continues with a fallback, so this is noise, not a
// failure cause. On a real failure the genuine error (e.g. "API Error: Unable to
// connect to API (ConnectionRefused)") lands on STDOUT, but this advisory was the
// stderr tail and masked it. Strip the advisory lines so the real error — or the
// stdout fallback below — surfaces. The full text stays in rawOutput/streamLog.
const CONFIG_NOISE_LINE =
  /^(Claude configuration file not found at:|A backup file exists at:|You can manually restore it by running:)/;

function stripBenignConfigNoise(stderr: string): string {
  if (!stderr.includes('Claude configuration file not found')) return stderr.trim();
  return stderr
    .split('\n')
    .filter((line) => !CONFIG_NOISE_LINE.test(line.trim()))
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
  return `\x1b[2m# workdir: ${workdir}\x1b[0m\r\n` + `\x1b[36m$\x1b[0m ${cmdLine}\r\n`;
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
    };
  };
}
