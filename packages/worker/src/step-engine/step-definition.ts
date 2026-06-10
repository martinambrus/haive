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
  /** Optional predicate to skip the LLM call entirely when its output isn't
   *  needed (e.g. selector phase when persona count <= dispatch cap, so all
   *  personas would be picked anyway). When skipped, llmOutput is undefined
   *  in downstream phases. */
  skipIf?: (args: LlmBuildArgs) => boolean;
  /** Sandbox timeout for the CLI invocation in milliseconds.
   *  Defaults to 2 minutes; tool_use steps that browse the repo need more. */
  timeoutMs?: number;
  /** Test-only synthetic LLM output used when HAIVE_TEST_BYPASS_LLM=1.
   *  Steps whose apply() throws on null llmOutput must define this so smoke
   *  tests can exercise the full pipeline without a real CLI provider. */
  bypassStub?: (args: LlmBuildArgs) => unknown;
}

export interface AgentMiningDispatch {
  agentId: string;
  agentTitle: string | null;
  prompt: string;
}

export interface AgentMiningResult {
  agentId: string;
  agentTitle: string | null;
  status: 'done' | 'failed';
  output: unknown;
  rawOutput: string | null;
  errorMessage: string | null;
}

export interface AgentMiningSelectArgs {
  ctx: StepContext;
  detected: unknown;
  formValues: FormValues;
  llmOutput: unknown;
}

export interface AgentMiningSpec {
  /** Picks the agents to dispatch and builds each agent's prompt. Runs once
   *  per step run, after the selector llm output is available. Return [] to
   *  skip mining entirely (apply runs with empty agentMiningResults). */
  selectAgents(args: AgentMiningSelectArgs): Promise<AgentMiningDispatch[]>;
  requiredCapabilities: StepCapability[];
  /** Sandbox timeout per agent invocation. Defaults to step-runner default. */
  timeoutMs?: number;
}

/** Per-coder context the DAG executor passes to a step's coder-prompt builder. */
export interface DagCoderContext {
  issueKey: string;
  title: string;
  description: string;
  specSections: string[];
  acceptanceCriteria: string[];
  provides: string;
  /** The coder's cwd inside the sandbox (its own git worktree). */
  sandboxWorktreePath: string;
}

/** Declared by the DAG-executor step. The runner drives the persisted DAG one
 *  dependency level per ADVANCE_STEP re-entry (resolveDagPhase): create N
 *  worktrees, fan out one coder per issue (bounded by the cli-exec queue), wait
 *  for the level (a waiting_cli barrier), merge, checkpoint, advance. The step
 *  only supplies the coder prompt + capabilities; the orchestration lives in the
 *  runner so it has the dispatcher + provider list. */
export interface DagExecuteSpec {
  requiredCapabilities: StepCapability[];
  /** Build one coder's prompt. `upstreamDebt` is a pre-formatted block of notes
   *  from completed lower-level issues (empty string when none). */
  buildCoderPrompt(issue: DagCoderContext, upstreamDebt: string): string;
  /** Sandbox timeout per coder invocation. Defaults to the step-runner default. */
  timeoutMs?: number;
}

export interface StepApplyArgs<TDetect = unknown> {
  detected: TDetect;
  formValues: FormValues;
  llmOutput?: unknown;
  agentMiningResults?: AgentMiningResult[];
  /** Zero-based index of the current loop pass. 0 = first pass; equals the
   *  count of entries already in `previousIterations`. Always 0 for steps
   *  that don't declare a loop hook. */
  iteration: number;
  /** Outputs of every prior loop pass for this step, oldest first. Empty
   *  on the first pass and on non-loop steps. Includes both the LLM
   *  payload and the apply output of each preceding pass so the new pass
   *  can amend the spec / decide convergence. */
  previousIterations: StepLoopPassRecord[];
}

export interface StepLoopPassRecord {
  iteration: number;
  llmOutput: unknown;
  applyOutput: unknown;
  continueRequested: boolean;
}

export interface StepLoopShouldContinueArgs<TApply = unknown> {
  ctx: StepContext;
  applyOutput: TApply;
  llmOutput: unknown;
  iteration: number;
  previousIterations: StepLoopPassRecord[];
}

export interface StepLoopSpec<TApply = unknown> {
  /** Hard cap on loop passes for the step. Per-task overrides via
   *  tasks.step_loop_limits[stepId] win when present. */
  maxIterations: number;
  /** Returns true when another LLM pass should be attempted. Called after
   *  each apply phase. The runner enforces maxIterations regardless of
   *  what this returns. */
  shouldContinue(args: StepLoopShouldContinueArgs<TApply>): boolean | Promise<boolean>;
  /** Optional. Build the prompt for iteration > 0. Receives previous
   *  iteration outputs so the next pass can amend rather than restart.
   *  Falls back to llm.buildPrompt when omitted (the standard buildPrompt
   *  also has access to previousIterations via the apply args path). */
  buildIterationPrompt?(args: {
    detected: unknown;
    formValues: FormValues;
    iteration: number;
    previousIterations: StepLoopPassRecord[];
  }): string;
  /** Optional. Returns the CLI role to use for the given iteration so the runner
   *  resolves a per-role provider (e.g. spec-quality: even iterations review,
   *  odd iterations correct). Null/omitted uses the step's single 'default'
   *  provider. Must match a role id in `metadata.cliRoles`. */
  resolveRole?(iteration: number): string | null;
  /** Number of LLM passes that make up one user-facing "round" for budgeting and
   *  display — e.g. spec-quality runs 2 passes per round (review + correct). The
   *  form budget (maxIterations) and the UI counter are expressed in ROUNDS; the
   *  runner multiplies by this to get the actual pass cap. Default 1. */
  passesPerRound?: number;
}

export interface StepDefinition<TDetect = unknown, TApply = unknown> {
  readonly metadata: StepMetadata;
  shouldRun?(ctx: StepContext): Promise<boolean> | boolean;
  detect?(ctx: StepContext): Promise<TDetect>;
  form?(ctx: StepContext, detected: TDetect, llmOutput?: unknown): FormSchema | null;
  llm?: LlmInvocationSpec;
  agentMining?: AgentMiningSpec;
  /** Re-run the LLM phase up to N times until shouldContinue is false.
   *  Each pass produces its own cli_invocations row so the inline terminal
   *  shows the full progression. Without a loop hook the step runs apply
   *  once and finalizes. Mutually compatible with agentMining? — agent
   *  mining still runs once at the start of each pass. */
  loop?: StepLoopSpec<TApply>;
  /** Marks this step as the DAG executor. The runner drives the persisted DAG
   *  (resolveDagPhase) after the form/llm phases and before apply — parking the
   *  step in waiting_cli per level until every level checkpoints, then apply
   *  finalizes. See packages/worker/src/step-engine/dag-executor.ts. */
  dagExecute?: DagExecuteSpec;
  apply(ctx: StepContext, args: StepApplyArgs<TDetect>): Promise<TApply>;
}
