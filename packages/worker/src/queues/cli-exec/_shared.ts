import { Queue } from 'bullmq';
import type { RequestUsageCapture } from '../../cli-executor/request-usage.js';
import {
  logger,
  type CleanTranscript,
  type CliTokenUsage,
  type InvocationCompaction,
  type ModelIdentity,
} from '@haive/shared';
import type { CliExecQueuePayload } from '@haive/shared';
import { QUEUE_NAMES, type InvocationToolUsage } from '@haive/shared';
import { defaultCliSpawner, type CliSpawner } from '../../cli-executor/index.js';
import type { CodexAppServerFailure } from '../../cli-executor/codex-app-server.js';
import { getBullRedis } from '../../redis.js';
import type { ProviderFatalClass } from './failure-class.js';

export const log: ReturnType<typeof logger.child> = logger.child({ module: 'cli-exec-queue' });

export type { CliExecQueuePayload } from '@haive/shared';

let cliExecQueueInstance: Queue<CliExecQueuePayload> | null = null;

export function getCliExecQueue(): Queue<CliExecQueuePayload> {
  if (!cliExecQueueInstance) {
    cliExecQueueInstance = new Queue<CliExecQueuePayload>(QUEUE_NAMES.CLI_EXEC, {
      connection: getBullRedis(),
    });
  }
  return cliExecQueueInstance;
}

export async function closeCliExecQueue(): Promise<void> {
  if (cliExecQueueInstance) {
    await cliExecQueueInstance.close();
    cliExecQueueInstance = null;
  }
}

export interface CliExecDeps {
  spawner: CliSpawner;
}

export const defaultDeps: CliExecDeps = {
  spawner: defaultCliSpawner,
};

export interface ExecutionOutcome {
  exitCode: number | null;
  rawOutput: string | null;
  parsedOutput: unknown;
  errorMessage: string | null;
  /** Token usage extracted from the CLI's structured output (see
   *  CliTokenUsage in @haive/shared). Undefined/null when the CLI reported
   *  nothing (plain-text output, legacy payloads, antigravity). */
  tokenUsage?: CliTokenUsage | null;
  /** In-memory evidence only; never persisted in token_usage or used for pricing in PR 2. */
  requestUsage?: RequestUsageCapture;
  /** Which model actually answered, parsed from the same output as tokenUsage.
   *  Persisted to cli_invocations.model_identity. Null when this execution path
   *  captures no stream, and for CLIs that name no model at all (codex, amp). */
  modelIdentity?: ModelIdentity | null;
  /** What the CLI's own context compaction did to this run, parsed from the same
   *  stream as tokenUsage. Persisted to cli_invocations.compaction. Null when this
   *  execution path captures no stream-json, and for every CLI that emits no
   *  compact_boundary event — which is all of them except the claude family. */
  compaction?: InvocationCompaction | null;
  /** Model time the CLI reported, parsed from the same stream as tokenUsage. Persisted to
   *  cli_invocations.api_duration_ms; null for every CLI that reports none. */
  apiDurationMs?: number | null;
  /** What the run USED — tool, MCP and sub-agent calls, the skill and agent files it opened —
   *  tallied from the same stream as tokenUsage. Persisted to cli_invocations.tool_usage.
   *  Undefined/null means "not examined" and leaves the column NULL; a path that captures no
   *  tool events writes a `coverage: 'none'` record instead, so the backfill can tell the two
   *  apart. */
  toolUsage?: InvocationToolUsage | null;
  /** Full live-stream transcript (header + every stdout/stderr chunk) the
   *  same bytes published to the cli-stream Redis channel. Persisted to
   *  cli_invocations.stream_log for historical replay. Null when the
   *  execution path doesn't capture a stream (e.g. agent-mining trace
   *  serialized post-hoc). */
  streamLog?: string | null;
  /** The Clean tab's ordered transcript — the model's prose turns with each mid-run steer at
   *  the position it was injected. Persisted to cli_invocations.clean_transcript.
   *
   *  Null when this execution path captures no stream, AND whenever the run produced no model
   *  prose: a transcript is the only thing the viewer renders once present, so one holding
   *  user turns alone would hide an answer that only rawOutput carries. */
  cleanTranscript?: CleanTranscript | null;
  /** CLI failure text+stderr tail (NO header/prompt) used ONLY to classify
   *  provider-fatal failures (rate-limit/auth/5xx). rawOutput is sanitized for
   *  the Clean tab and may be prose or empty, so it can no longer carry the API
   *  error the classifier needs; this carries it. Excludes the header/prompt
   *  (which streamLog includes) so a task spec mentioning "rate limit"/"401"
   *  cannot false-positive. Stream-json uses only the latest top-level reply and its result
   *  reason, excluding raw protocol, tool payloads and earlier replies. */
  providerErrorScan?: string;
  /** Exact top-level assistant error code, used for account-action guidance. */
  streamErrorCode?: string;
  /** The fatal class the CLI's own stream error code names; read before any text rule. */
  streamFailureClass?: ProviderFatalClass;
  /** antigravity only: the tail of agy's own `--log-file`, captured out of the
   *  sandbox. agy writes provider-fatal errors (quota/auth/5xx) ONLY here and exits
   *  0 with empty stdout, so this is the sole signal interpretCliFailure can classify
   *  (via classifyAntigravityDiagnostic). Kept SEPARATE from providerErrorScan so the
   *  model's answer text never enters the fatal scan. */
  providerDiagnosticLog?: string;
  /** codex app-server only: what this run learned about the transport. A `failure` means the
   *  app-server misbehaved in a way that is not the model's doing, and cli-exec records the task's
   *  verdict for this provider as `unsupported`, so no later dispatch builds app-server again.
   *  Null when it behaved, and when Haive stopped the run itself (timeout, cancel, preemption).
   *  `binaryVersion` is the codex version the app-server reported, null when it never said. */
  codexAppServer?: { failure: CodexAppServerFailure | null; binaryVersion: string | null };
}

export { CliLoginRequiredError } from '../../sandbox/cli-auth-errors.js';
