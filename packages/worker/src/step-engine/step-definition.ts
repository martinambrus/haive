import type {
  FormSchema,
  FormValues,
  StepCapability,
  StepMetadata,
  TaskStatus,
} from '@haive/shared';
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
  /** Fix-loop round this step row belongs to (0 = original pass). round > 0 means
   *  a fix re-run; steps branch on it to enter fix mode (e.g. 07 implement). */
  round: number;
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
  /** Loop pass index (0 = first). Lets skipIf/buildPrompt vary by iteration — e.g.
   *  09_5 skips the bulk llm call at iteration 0 (parallel agentMining does the bulk)
   *  but runs it for sequential gap-fill at iteration > 0. Optional; callers that
   *  don't track iterations omit it. */
  iteration?: number;
}

export interface LlmInvocationSpec {
  requiredCapabilities: StepCapability[];
  buildPrompt: (args: LlmBuildArgs) => string;
  parseOutput?: (raw: string, parsed: unknown) => unknown;
  /** When true, LLM runs after detect but before the form is generated.
   *  The form() function receives the parsed llmOutput as its third argument. */
  preForm?: boolean;
  /** When true, a failed or un-dispatchable LLM invocation does NOT fail the
   *  step — the runner degrades to `llmOutput = null` so downstream phases fall
   *  back to defaults. Use for a best-effort enrichment (e.g. a gate-1 config
   *  recommendation) that must never block the step. */
  optional?: boolean;
  /** Optional predicate to skip the LLM call entirely when its output isn't
   *  needed (e.g. selector phase when persona count <= dispatch cap, so all
   *  personas would be picked anyway). When skipped, llmOutput is undefined
   *  in downstream phases. */
  skipIf?: (args: LlmBuildArgs) => boolean;
  /** Sandbox timeout for the CLI invocation in milliseconds.
   *  Defaults to 2 minutes; tool_use steps that browse the repo need more. */
  timeoutMs?: number;
  /** Claude-family only: run this LLM phase with NO built-in tools (`--tools ""`)
   *  so the model answers from the prompt alone instead of browsing the repo. For
   *  enrichment/classification steps (e.g. 01-env-detect) whose full input is
   *  already embedded in the prompt — a high-effort model otherwise crawls the
   *  workspace and blows the timeout. codex/gemini ignore it. */
  disableTools?: boolean;
  /** Narrow the MCP surface this invocation is given. Unset = the full surface
   *  (rag, plus chrome-devtools when the repo does browser testing, ddev-control
   *  on a DDEV task, and the user's own servers from `.claude/mcp_settings.json`).
   *
   *  `'rag_only'` cuts it to rag_search alone — the same surface knowledge-mining
   *  already gets. For a report-only step that cannot act on a browser or a
   *  container, those servers are tool definitions the model pays for and can
   *  never usefully call. Note this drops the USER's servers too, so do not set it
   *  on a step where a user-provided tool could plausibly help.
   *
   *  Unlike `disableTools` (which removes the CLI's own built-in file tools) this
   *  only touches MCP; the step can still read the repo. */
  toolProfile?: 'rag_only';
  /** Test-only synthetic LLM output used when HAIVE_TEST_BYPASS_LLM=1.
   *  Steps whose apply() throws on null llmOutput must define this so smoke
   *  tests can exercise the full pipeline without a real CLI provider. */
  bypassStub?: (args: LlmBuildArgs) => unknown;
  /** Optional async side-effect run right before each CLI dispatch (after the
   *  form, with ctx). Use for environment setup the invocation depends on —
   *  e.g. 08a starts the runner's headed-browser desktop so the chrome-devtools
   *  MCP can connect to it. Idempotent; awaited each dispatch (incl. loop
   *  passes). Skipped under HAIVE_TEST_BYPASS_LLM. */
  prepare?: (args: LlmBuildArgs & { ctx: StepContext }) => Promise<void>;
  /** Retry the LLM phase when apply() throws — for steps whose output is a strict
   *  JSON contract a flaky model intermittently misses (emits prose, an empty turn,
   *  or unparseable JSON). On an apply throw the runner re-enqueues a FRESH cli
   *  invocation (the prior one is marked consumed) up to `maxAttempts` TOTAL attempts,
   *  then lets the error fail the step. `retryOn` decides which thrown errors are
   *  retryable (default: all). Ignored for steps that also declare loop?. */
  retry?: {
    maxAttempts: number;
    retryOn?: (err: unknown) => boolean;
  };
  /** preForm-only: re-roll the llm invocation when its output is unusable and the
   *  retry budget remains, BEFORE the form renders — so a form that surfaces the
   *  parse failure (a manual-topics / candidate-selection / recipe-prefill form) is
   *  only shown after retries are spent. Returns true when the current output
   *  warrants a re-roll. Requires llm.retry (for the maxAttempts budget) and
   *  llm.preForm; ignored under HAIVE_TEST_BYPASS_LLM. */
  shouldRetryPreForm?: (llmOutput: unknown) => boolean;
}

export interface AgentMiningDispatch {
  agentId: string;
  agentTitle: string | null;
  prompt: string;
  /** Which SEAT in the fan-out this agent occupies, for per-seat CLI selection.
   *
   *  Resolved as the `role` in `resolvePreferredCli`, against the same
   *  `user_step_cli_role_preferences` rows the loop roles use, and enumerated per step
   *  in `STEP_MINING_SEATS` (@haive/shared) so the UI can offer a picker.
   *
   *  Distinct from `agentId`, which is often content-derived and unbounded — 08c's
   *  refuters are one agent PER FINDING, so the stable seat there is the refutation
   *  lens, not the agent. Steps whose agents have no stable identity (per-repo
   *  personas, per-skill or per-draft ids) leave this unset.
   *
   *  Unset means `'default'`, which resolves exactly as the whole fan-out did before
   *  per-seat selection existed: the step's own preference, then the task provider. */
  roleKey?: string;
  /** Override `agentMining.requiredCapabilities` for THIS agent.
   *
   *  The spec's list is static, which is right for a capability the step always
   *  needs. It cannot express one that depends on the task's own inputs: the plan
   *  builder needs `vision` when a wireframe was attached and must not demand it
   *  otherwise, or every build without an image would refuse a blind model for no
   *  reason. Unset keeps the spec's list, so existing steps are unchanged. */
  capabilities?: StepCapability[];
  /** Order providers whose model is known to reject images LAST, without excluding
   *  any. For an input that has BOTH a visual and a textual form — a PDF beside its
   *  extracted text — seeing it is better and not seeing it is still workable, so
   *  the hard `vision` capability would refuse a provider that can do the job. */
  preferVision?: boolean;
}

export interface AgentMiningResult {
  agentId: string;
  agentTitle: string | null;
  /** The cli_invocation this agent ran as, so apply() can attribute what it produced to
   *  the model that produced it (review_findings.cli_invocation_id). Copied straight off
   *  the mining row, which already stores it.
   *
   *  Optional rather than required so the six test files that build this shape by hand stay
   *  valid — package tsconfigs exclude `*.test.ts`, so a required field would break them
   *  invisibly rather than at typecheck. Production has exactly one producer (the results
   *  map in step-runner) and it always sets it. */
  invocationId?: string | null;
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
  /** Narrow the MCP surface every agent in this fan-out is given, with the same
   *  meaning as `LlmInvocationSpec.toolProfile` above: `'rag_only'` cuts it to
   *  rag_search, unset keeps the full surface.
   *
   *  Declare it — do not rely on the fan-out being narrowed for you. It used to be
   *  forced for every `kind: 'agent_mining'` invocation, which silently applied a
   *  knowledge-mining decision to the review and QA fan-outs that reuse the same
   *  machinery. 08d-adversarial-qa is handed a live app URL for runtime attacks and
   *  could not reach it; 08c-code-review wanted the narrow surface and got it by
   *  accident rather than by saying so. */
  toolProfile?: 'rag_only';
  /** Sandbox timeout per agent invocation. Defaults to step-runner default. */
  timeoutMs?: number;
  /** Opt in to the soft timeout: shortly before the hard SIGKILL, steer the agent to
   *  stop investigating and emit only what it has verified. For reviewers, whose
   *  partial findings beat losing the whole run. NOT for an agent that writes code or
   *  files — ending one early would look like success. Steerable adapters only. */
  softTimeout?: boolean;
  /** Re-roll INDIVIDUAL agents, up to `maxAttempts` TOTAL invocations per agent.
   *
   *  `retryOnInvocationFailure` handles a terminal CLI failure before apply() runs;
   *  use it for transient transport errors and return false for persistent provider
   *  failures such as auth or quota. `MiningRetryError` handles output that apply()
   *  could not use — for example, a reviewer that emitted prose instead of its JSON
   *  contract. Both paths preserve the other agents' completed rows. Budget is
   *  tracked on task_step_agent_minings.attempts. Once no named agent has budget
   *  left, apply() is called with isFinalMiningAttempt=true and must degrade rather
   *  than throw. Ignored for steps that also declare loop?. */
  retry?: {
    maxAttempts: number;
    /** Return true to re-run this failed CLI invocation before apply() sees it.
     *  Called only for terminal mining rows that still have retry budget. */
    retryOnInvocationFailure?: (result: AgentMiningResult) => boolean;
  };
}

/** Per-coder context the DAG executor passes to a step's coder-prompt builder. */
export interface DagCoderContext {
  issueKey: string;
  title: string;
  description: string;
  /** The approved spec as this coder should see it: its section index plus a pointer to
   *  the copy in the coder's own worktree, or the whole document when the admin picked
   *  'full'. Empty when the run has no spec. Distinct from `specSections`, which names
   *  WHICH sections this issue owns — the view tells the coder where to read them. */
  spec: string;
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

/** Declared by a step that finishes by merging a feature branch into its base with
 *  an LLM-driven conflict-resolution loop (resolveMergePhase). Like dagExecute the
 *  orchestration (git + agent dispatch + the persisted state machine) lives in the
 *  runner; the step supplies only the per-conflict fix prompt + capabilities and the
 *  predicate that decides whether the chosen form action is a merge. The runner runs
 *  this AFTER the form (it needs the merge action + push choice) and BEFORE apply
 *  (which still removes the worktree). Mutually exclusive with dagExecute.
 *  See packages/worker/src/step-engine/merge-resolver.ts. */
export interface MergeResolveSpec {
  requiredCapabilities: StepCapability[];
  /** Build the conflict-resolution agent's prompt. `guidance` is the user's
   *  free-text answer to a prior clarification (empty string when none). */
  buildFixPrompt(args: {
    baseBranch: string;
    featureBranch: string;
    conflictFiles: string[];
    guidance: string;
  }): string;
  /** Build the form shown when the agent is uncertain and needs the user to decide
   *  how to resolve the conflict. The user's answer is fed back into buildFixPrompt's
   *  `guidance` on the next attempt. */
  buildClarificationForm(args: {
    baseBranch: string;
    featureBranch: string;
    conflictFiles: string[];
    uncertainty: string;
  }): FormSchema;
  /** True when the submitted form values selected the merge path (so the phase
   *  runs). A non-merge action makes resolveMergePhase a no-op pass-through. */
  selectedMerge(formValues: FormValues): boolean;
  /** Sandbox timeout per fix-agent invocation. Defaults to 30 minutes. */
  timeoutMs?: number;
}

export interface StepApplyArgs<TDetect = unknown> {
  detected: TDetect;
  formValues: FormValues;
  llmOutput?: unknown;
  /** The cli_invocation `llmOutput` came from, for steps that record review findings and
   *  need to attribute them durably. Undefined on the bypass-stub path and on steps whose
   *  output came from a fan-out instead — those attribute per agent via
   *  `agentMiningResults[].invocationId`. */
  llmInvocationId?: string | null;
  agentMiningResults?: AgentMiningResult[];
  /** The subset of `agentMiningResults` no previous apply() pass has folded —
   *  rows whose mining row is still unconsumed (consumed_at is stamped right
   *  before a MiningWaveError dispatches the next wave, and cleared on a
   *  re-roll). A step whose fold is NOT idempotent across re-entry (temp-ref
   *  creation — the plan builder) folds THESE and uses `agentMiningResults`
   *  only for read-only history. Identical to `agentMiningResults` on the
   *  first pass and for every step that never throws MiningWaveError, so
   *  existing steps can ignore it. */
  newAgentMiningResults?: AgentMiningResult[];
  /** Zero-based index of the current loop pass. 0 = first pass; equals the
   *  count of entries already in `previousIterations`. Always 0 for steps
   *  that don't declare a loop hook. */
  iteration: number;
  /** Outputs of every prior loop pass for this step, oldest first. Empty
   *  on the first pass and on non-loop steps. Includes both the LLM
   *  payload and the apply output of each preceding pass so the new pass
   *  can amend the spec / decide convergence. */
  previousIterations: StepLoopPassRecord[];
  /** True when this is the LAST llm.retry attempt (or the step has no retry): a
   *  generator should DEGRADE (return its stub/fallback) rather than throw a
   *  RetryableParseError. False on earlier attempts so a parse failure re-rolls.
   *  Undefined for callers that don't set it (treated as final). */
  isFinalLlmAttempt?: boolean;
  /** True when no mining agent has re-roll budget left (or the step has no
   *  agentMining.retry): apply() must DEGRADE rather than throw MiningRetryError.
   *  Undefined for callers that don't set it (treated as final). */
  isFinalMiningAttempt?: boolean;
  /** True when a MiningWaveError dispatched nothing (every named agent already had a
   *  row, or no provider was available): apply() must proceed WITHOUT the second wave's
   *  results rather than ask for it again. Undefined on the first apply of a wave. */
  miningWaveExhausted?: boolean;
}

/** Throw from apply() on an unrecoverable LLM parse failure to trigger llm.retry
 *  (re-roll a fresh invocation). Generators throw this only while
 *  args.isFinalLlmAttempt is false; on the final attempt they degrade instead. */
export class RetryableParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableParseError';
  }
}

/** Throw from apply() of an agentMining step when specific agents produced output it
 *  could not use, to re-roll just those agents. Deliberately NOT a RetryableParseError:
 *  the llm-retry arm defaults `retryOn` to "every error", so a step declaring both specs
 *  would re-enqueue its llm invocation for a mining failure. Thrown only while
 *  args.isFinalMiningAttempt is false; on the final attempt apply() degrades instead. */
export class MiningRetryError extends Error {
  readonly agentIds: string[];
  constructor(agentIds: string[], message?: string) {
    super(message ?? `agent output unusable, re-roll: ${agentIds.join(', ')}`);
    this.name = 'MiningRetryError';
    this.agentIds = agentIds;
  }
}

/**
 * Throw from apply() of an agentMining step to dispatch a SECOND wave of agents whose
 * prompts depend on what the first wave found — a refuter per blocking review finding,
 * say. The runner enqueues them as fresh rows, parks the step, and calls apply() again
 * once they finish, with the whole set (first wave + second) in `agentMiningResults`.
 *
 * The step engine offers no other way to do this. `selectAgents` runs before the first
 * dispatch, so it cannot see any findings; `loop` re-enters only the LLM phase, never
 * the mining fan-out; and resolveAgentMiningPhase short-circuits the moment any mining
 * row exists.
 *
 * apply() decides whether to throw by looking for the second wave's agents in
 * `agentMiningResults` — it must NOT throw once they are present, or the step never
 * settles. `args.miningWaveExhausted` covers the case where the runner could dispatch
 * none of them. Distinct from MiningRetryError, which re-rolls agents that already ran.
 */
export class MiningWaveError extends Error {
  readonly dispatches: AgentMiningDispatch[];
  constructor(dispatches: AgentMiningDispatch[], message?: string) {
    super(message ?? `second mining wave requested: ${dispatches.length} agent(s)`);
    this.name = 'MiningWaveError';
    this.dispatches = dispatches;
  }
}

/**
 * Throw from apply() when a bounded unit of user-approved work finished but the
 * same step still has another decision to present. The runner refreshes detect(),
 * rebuilds the form, clears the prior answer, and parks on `waiting_form` without
 * finalizing the step.
 *
 * This is intentionally different from a mining wave: MiningWaveError is an
 * automated continuation inside one approval, while this signal returns control
 * to the person before another bounded batch is dispatched.
 */
export class ReopenStepFormError extends Error {
  constructor(message = 'step has another decision to present') {
    super(message);
    this.name = 'ReopenStepFormError';
  }
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
    /** Consecutive output-truncation failures for the CURRENT iteration (0
     *  normally). When > 0 a same-iteration re-dispatch is underway after the
     *  model hit its output cap, so the builder should request a SMALLER response
     *  (fewer/shorter items) to fit. The runner re-routes iteration-0 retries
     *  through this builder too so the shrink hint reaches the first pass. */
    truncationRetries?: number;
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
  /** When this step parks on a form (waiting_form), set the TASK status to this instead
   *  of the default 'waiting_user'. Used by 13-pr-wait to surface a task waiting for its
   *  PR to merge as 'waiting_pr'. Only takes effect when the step actually parks. */
  readonly parkTaskStatus?: TaskStatus;
  /** This step brings up the task's per-task runtime (DDEV / app-runner). The orchestrator
   *  gates it on the machine-aware runtime pool BEFORE running it: when the pool is full and
   *  the task holds no runner yet, the step is parked (re-driven when a slot frees) instead of
   *  overcommitting a new runner.
   *
   *  `'ddev'` / `'app'`: the step boots that runtime itself (ensureDdevStarted /
   *  ensureAppRunnerStarted), so it is gated unconditionally.
   *
   *  `'if-serving'`: the runtime comes from ensureAppServing, which boots NOTHING when
   *  classifyRuntime reports `'none'` (no .ddev/config.yaml, no 01a-app-boot row). The gate
   *  resolves that same classification and skips admission for a task that will never spawn a
   *  runner — over-declaring is only safe for a task that HAS a runner; a task that will never
   *  have one would otherwise park behind a pool it does not use. A step that creates the
   *  runtime for the FIRST time cannot use this: 01a-app-boot classifies as `'none'` right up
   *  until it writes its own boot row. */
  readonly needsRuntime?: 'ddev' | 'app' | 'if-serving';
  shouldRun?(ctx: StepContext): Promise<boolean> | boolean;
  detect?(ctx: StepContext): Promise<TDetect>;
  form?(ctx: StepContext, detected: TDetect, llmOutput?: unknown): FormSchema | null;
  /** Optional async side-effect run AFTER the preForm llm phase and BEFORE the
   *  (synchronous) form() is built — the seam where a step writes an artifact the
   *  form's web viewer points at (e.g. 11-phase-8-learning's knowledge-diff JSON,
   *  which depends on the agent's KB edits that only exist post-llm). Awaited once,
   *  only when the form is first built; receives the parsed preForm llmOutput.
   *  No-op for steps that don't declare it. */
  prepareForm?(ctx: StepContext, detected: TDetect, llmOutput?: unknown): Promise<void>;
  /** Only for steps with `metadata.reuseLastCompletedFormValues`. The runner replays
   *  a prior completed task's answers verbatim, so they can be STALE against the repo
   *  as it stands today. This hook gets a last look at those answers, alongside this
   *  task's fresh `detect()` output, and returns the set to auto-submit. Called before
   *  validation. Only refresh a value the prior task can no longer speak for — an
   *  answer the user actually chose must survive. */
  reconcileReusedFormValues?(
    ctx: StepContext,
    detected: TDetect,
    reused: FormValues,
  ): Promise<FormValues> | FormValues;
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
  /** Marks this step as the merge-resolver. The runner drives an LLM conflict-
   *  resolution loop (resolveMergePhase) after the form/llm phases and before apply,
   *  interleaving waiting_cli (fix agent) and waiting_form (user clarification) until
   *  the merge commits or halts. Mutually exclusive with dagExecute. */
  mergeResolve?: MergeResolveSpec;
  /** Fix-loop: when this step's apply output indicates a BLOCKING defect, the runner
   *  returns `loop_back` instead of `done`, re-entering at the implementation step for
   *  a new round (the whole post-implementation chain re-runs). `evaluate` inspects the
   *  apply output and returns the diagnosis to hand the implementation agent, or null
   *  (or blocking=false) when the step passed. */
  fixLoop?: {
    evaluate(applyOutput: TApply): { blocking: boolean; diagnosis: string } | null;
  };
  /** Deterministic steps (e.g. 07c-ddev-reconcile) that THROW on a fixable failure set
   *  this so the runner routes the thrown error into the fix loop (diagnosis = error
   *  message) instead of failing the task outright.
   *
   *  A predicate narrows that to the failures the implementation agent can actually fix.
   *  07c needs it: a broken `.ddev/web-build/Dockerfile` is the agent's own work and should
   *  loop back, while a host-level failure (an unsatisfiable `ddev_version_constraint`, a
   *  reaped runner) must keep the hard-fail path — looping the implementer on those burns
   *  a round and changes nothing. A step whose every failure is fixable can still pass
   *  `true`. Note for path filtering: ANY value here (including a predicate) makes the step
   *  a loop emitter, so it needs a PATH_REQUIRED_TARGETS entry or boot fails. */
  fixLoopOnError?: boolean | ((errorMessage: string) => boolean);
  /** Review-gate revise loop: when this step's apply output asks to revise an EARLIER
   *  step, the runner returns `revise` (reset the target + its downstream and re-enter
   *  the target in the SAME round) instead of `done`. Unlike fixLoop this is
   *  human-gated — the review form re-parks every cycle — so there is no round bump and
   *  no cap. `evaluate` returns the target step id to revise, or null to finalize the
   *  step normally. Used by 03c-business-requirements-review (reject → re-mine 03b). */
  reviseLoop?: {
    evaluate(applyOutput: TApply): { targetStepId: string } | null;
  };
  /** Human-gated restart-from-implementation: when this step's apply output requests a
   *  restart (e.g. the gate-2 developer reject after browser verification), the runner
   *  returns `loop_back` UNCAPPED and suppression-immune — re-enters the implementation
   *  step at round+1 with `diagnosis` as the fix request and re-runs the whole
   *  post-implementation chain as new round rows. Unlike fixLoop the human is the bound:
   *  no max_fix_rounds cap and no stand-down on a prior Accept. `evaluate` returns the
   *  diagnosis to hand the implementer, or null to finalize the step normally. */
  restartLoop?: {
    evaluate(applyOutput: TApply): { diagnosis: string } | null;
  };
  apply(ctx: StepContext, args: StepApplyArgs<TDetect>): Promise<TApply>;
}
