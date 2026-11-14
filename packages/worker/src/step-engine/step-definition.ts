// Compatibility entry: constructors must stay identical to the public module seam.
export {
  TaskCancelledError,
  AdvisedStepError,
  RetryableParseError,
  MiningRetryError,
  MiningWaveError,
  ReopenStepFormError,
  PromptBudgetExceededError,
} from '@haive/shared/step';
export type {
  StepContext,
  LlmBuildArgs,
  LlmInvocationSpec,
  AgentMiningDispatch,
  AgentMiningResult,
  AgentMiningSelectArgs,
  AgentMiningSpec,
  DagCoderContext,
  DagExecuteSpec,
  MergeResolveSpec,
  StepApplyArgs,
  StepLoopPassRecord,
  StepLoopShouldContinueArgs,
  StepLoopSpec,
  StepDefinition,
} from '@haive/shared/step';
