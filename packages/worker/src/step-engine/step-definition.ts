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
  signal?: AbortSignal;
}

export interface LlmBuildArgs {
  detected: unknown;
  formValues: FormValues;
}

export interface LlmInvocationSpec {
  requiredCapabilities: StepCapability[];
  buildPrompt: (args: LlmBuildArgs) => string;
  parseOutput?: (raw: string, parsed: unknown) => unknown;
  optional?: boolean;
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
  form?(ctx: StepContext, detected: TDetect): FormSchema | null;
  llm?: LlmInvocationSpec;
  apply(ctx: StepContext, args: StepApplyArgs<TDetect>): Promise<TApply>;
}
