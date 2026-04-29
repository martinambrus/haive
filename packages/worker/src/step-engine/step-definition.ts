import type { FormSchema, FormValues, StepCapability, StepMetadata } from '@haive/shared';
import { logger } from '@haive/shared';
import type { Database } from '@haive/database';

type Logger = ReturnType<typeof logger.child>;

export interface StepContext {
  taskId: string;
  taskStepId: string;
  userId: string;
  repoPath: string;
  workspacePath: string;
  sandboxWorkdir: string;
  cliProviderId: string | null;
  db: Database;
  logger: Logger;
  signal: AbortSignal;
  /** Update the step's status_message column (shown in UI during running state). */
  emitProgress(message: string): Promise<void>;
  /** Throws TaskCancelledError when the task has been cancelled. Call inside long loops. */
  throwIfCancelled(): void;
}

export class TaskCancelledError extends Error {
  constructor(message = 'task cancelled') {
    super(message);
    this.name = 'TaskCancelledError';
  }
}

export interface LlmBuildArgs {
  detected: unknown;
  formValues: FormValues;
}

export interface LlmInvocationSpec {
  requiredCapabilities: StepCapability[];
  buildPrompt: (args: LlmBuildArgs) => string;
  parseOutput?: (raw: string, parsed: unknown) => unknown;
  /** When true, LLM runs after detect but before the form is generated.
   *  The form() function receives the parsed llmOutput as its third argument. */
  preForm?: boolean;
  /** Sandbox timeout for the CLI invocation in milliseconds.
   *  Defaults to 2 minutes; tool_use steps that browse the repo need more. */
  timeoutMs?: number;
  /** Test-only synthetic LLM output used when HAIVE_TEST_BYPASS_LLM=1.
   *  Steps whose apply() throws on null llmOutput must define this so smoke
   *  tests can exercise the full pipeline without a real CLI provider. */
  bypassStub?: (args: LlmBuildArgs) => unknown;
}

export interface StepApplyArgs<TDetect = unknown> {
  detected: TDetect;
  formValues: FormValues;
  llmOutput?: unknown;
}

export interface StepDefinition<TDetect = unknown, TApply = unknown> {
  readonly metadata: StepMetadata;
  shouldRun?(ctx: StepContext): Promise<boolean> | boolean;
  detect?(ctx: StepContext): Promise<TDetect>;
  form?(ctx: StepContext, detected: TDetect, llmOutput?: unknown): FormSchema | null;
  llm?: LlmInvocationSpec;
  apply(ctx: StepContext, args: StepApplyArgs<TDetect>): Promise<TApply>;
}
