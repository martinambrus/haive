import { Queue } from 'bullmq';
import { logger, type CliTokenUsage, type StepErrorHint } from '@haive/shared';
import type {
  CliExecJobPayload,
  CliProbeJobPayload,
  SandboxImageBuildJobPayload,
  RefreshCliVersionsJobPayload,
  CliLoginCreateJobPayload,
  CliSignOutJobPayload,
  OllamaProvisionJobPayload,
} from '@haive/shared';
import { QUEUE_NAMES } from '@haive/shared';
import { defaultCliSpawner, type CliSpawner } from '../../cli-executor/index.js';
import { getBullRedis } from '../../redis.js';

export const log: ReturnType<typeof logger.child> = logger.child({ module: 'cli-exec-queue' });

export type CliExecQueuePayload =
  | CliExecJobPayload
  | CliProbeJobPayload
  | SandboxImageBuildJobPayload
  | RefreshCliVersionsJobPayload
  | CliLoginCreateJobPayload
  | CliSignOutJobPayload
  | OllamaProvisionJobPayload;

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
  /** Full live-stream transcript (header + every stdout/stderr chunk) the
   *  same bytes published to the cli-stream Redis channel. Persisted to
   *  cli_invocations.stream_log for historical replay. Null when the
   *  execution path doesn't capture a stream (e.g. agent-mining trace
   *  serialized post-hoc). */
  streamLog?: string | null;
  /** Raw CLI stdout+stderr tail (NO header/prompt) used ONLY to classify
   *  provider-fatal failures (rate-limit/auth/5xx). rawOutput is sanitized for
   *  the Clean tab and may be prose or empty, so it can no longer carry the API
   *  error the classifier needs; this carries it. Excludes the header/prompt
   *  (which streamLog includes) so a task spec mentioning "rate limit"/"401"
   *  cannot false-positive. Set on failure-capable branches only. */
  providerErrorScan?: string;
}

/**
 * Thrown by `assertUserAuthReady` when a subscription-auth CLI has no
 * populated user auth volume. Carries a structured hint so the UI can render
 * an inline "Log in to <provider>" button that triggers the Haive login flow
 * and auto-retries the step after successful login.
 */
export class CliLoginRequiredError extends Error {
  readonly hint: StepErrorHint;
  constructor(message: string, hint: StepErrorHint) {
    super(message);
    this.name = 'CliLoginRequiredError';
    this.hint = hint;
  }
}
