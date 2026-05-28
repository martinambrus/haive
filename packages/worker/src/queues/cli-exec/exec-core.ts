import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  type CliExecInvocationKind,
  type CliExecJobPayload,
  type CliNetworkPolicy,
  type CliProviderName,
} from '@haive/shared';
import type { DockerVolumeMount } from '../../sandbox/docker-runner.js';
import { SANDBOX_WORKDIR, type SandboxExtraFile } from '../../sandbox/sandbox-runner.js';
import { cliAdapterRegistry } from '../../cli-adapters/registry.js';
import type { CliCommandSpec } from '../../cli-adapters/types.js';
import {
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
  gemini: 'gemini auth login',
  amp: 'amp login',
  zai: 'zai login',
};

export function interpretCliFailure(
  result: ExecutionOutcome,
  providerName: string | null,
): string | null {
  const existing = result.errorMessage ?? null;
  if (result.exitCode === 0) return existing;

  const haystack = [existing ?? '', result.rawOutput ?? ''].join('\n');
  const looksLikeAuth = AUTH_FAILURE_PATTERNS.some((p) => p.test(haystack));
  if (!looksLikeAuth) return existing;

  const loginCmd = providerName ? PROVIDER_LOGIN_HINTS[providerName] : null;
  const hint = loginCmd
    ? `run \`${loginCmd}\` in your terminal and then retry this step`
    : 're-authenticate your CLI in your terminal and then retry this step';
  const detail = existing && existing.trim().length > 0 ? ` (${existing.trim()})` : '';
  return `CLI authentication failed — ${hint}.${detail}`;
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
  switch (payload.kind) {
    case 'cli':
    case 'agent_mining': {
      const { wrapperContent, sandboxImage, networkPolicy } = await loadProviderRuntimeConfig(
        db,
        payload.cliProviderId,
        payload.taskId,
      );
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
          )
        : { files: [], extraArgs: [] };
      const statusUpdater = payload.taskStepId
        ? createStepStatusUpdater(db, payload.taskStepId)
        : undefined;
      return executeCliSpec(
        payload.spec as CliCommandSpec,
        deps,
        payload.timeoutMs,
        secrets,
        wrapperContent,
        sandboxImage,
        repoMount,
        sandboxWorkdir,
        networkPolicy,
        mcp.files,
        authMounts,
        statusUpdater,
        payload.taskId ?? null,
        payload.invocationId ?? null,
        mcp.extraArgs,
      );
    }
    case 'subagent_sequential':
      return executeSubAgentSequential(db, payload, secrets, repoMount, sandboxWorkdir);
    case 'subagent_native':
      return executeSubAgentNative(db, payload, deps, secrets, repoMount, sandboxWorkdir);
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
  extraFiles: SandboxExtraFile[] = [],
  authMounts: DockerVolumeMount[] = [],
  statusCallback?: (message: string) => void,
  taskId: string | null = null,
  invocationId: string | null = null,
  mcpExtraArgs: string[] = [],
): Promise<ExecutionOutcome> {
  const mergedSpec: CliCommandSpec = {
    ...spec,
    args: mcpExtraArgs.length > 0 ? [...spec.args, ...mcpExtraArgs] : spec.args,
    env: { ...spec.env, ...secrets },
  };
  const spawner: CliSpawner = createSandboxSpawner(
    wrapperContent,
    sandboxImage,
    repoMount,
    sandboxWorkdir,
    networkPolicy,
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

  // Hook stdout for NDJSON stream-json parsing (Claude Code / Zai)
  const collector = createStreamJsonCollector(statusCallback);
  const result = await spawner(mergedSpec, {
    timeoutMs,
    onStdoutChunk: (chunk: string) => {
      streamBuf.push(chunk);
      collector.onChunk(chunk);
    },
    onStderrChunk: (chunk: string) => {
      streamBuf.push(chunk);
    },
  });
  const streamLog = streamBuf.join('');
  void deps;

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
      streamLog,
    };
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
  const stderrTail = stderr.trim();
  if (stderrTail.length > 0) return stderrTail.slice(-2000);
  const stdoutTail = stdout.trim();
  if (stdoutTail.length > 0) return stdoutTail.slice(-2000);
  return `cli exited with code ${exitCode ?? 'unknown'}`;
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
