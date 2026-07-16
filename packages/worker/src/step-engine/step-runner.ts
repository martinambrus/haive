import { and, asc, desc, eq, isNotNull, isNull, ne } from 'drizzle-orm';
import type { Database } from '@haive/database';
import { schema, type StepIterationEntry } from '@haive/database';
import {
  CONFIG_KEYS,
  configService,
  extractFormDefaults,
  isOllamaCloudModel,
  logger,
  validateFormValues,
} from '@haive/shared';
import type {
  CliExecInvocationKind,
  CliExecJobPayload,
  FormField,
  FormSchema,
  FormValues,
  LeafFormField,
  StepStatus,
} from '@haive/shared';
import type { CliProviderRecord } from '../cli-adapters/types.js';
import { resolveTaskDispatch, type DispatchPlan } from '../orchestrator/dispatcher.js';
import { SANDBOX_WORKDIR } from '../sandbox/sandbox-runner.js';
import { isOutputTruncationMessage } from '../queues/cli-exec/failure-class.js';
import { enqueueUsagePollTick } from '../queues/usage-poll-queue.js';
import {
  TaskCancelledError,
  MiningRetryError,
  MiningWaveError,
  type AgentMiningDispatch,
  type AgentMiningResult,
  type StepContext,
  type StepDefinition,
  type StepLoopPassRecord,
} from './step-definition.js';
import { resolveDagPhase } from './dag-executor.js';
import { resolveMergePhase } from './merge-resolver.js';
import { isFixLoopSuppressed } from './steps/workflow/_fix-loop.js';
import { resolveCuratedSummary } from './_step-summary.js';
import { augmentPromptWithAttachments } from './attachments-context.js';
import { augmentPromptWithTerseness } from './terseness-context.js';
import { writeStepContextUsage } from './step-context-usage.js';

const log = logger.child({ module: 'step-runner' });

export type TaskStepRow = typeof schema.taskSteps.$inferSelect;

/** Onboarding mining/analysis steps whose agents must NOT spawn their own Claude
 *  Code sub-agents (the `Agent` tool). Haive already fans these out
 *  deterministically (09_5's agentMining batch + skill-gen loop; the rest are
 *  single agents), so letting each agent recursively spawn more sub-agents just
 *  multiplies token spend with no orchestration control. Covers the KB/skills
 *  mining steps (08, 09-qa, 09_5, 09_5b) AND the agent-discovery + QA-resolve
 *  flow (06_5, 09_1, 09_2), which also read the codebase via the CLI. Only
 *  claude-family honors this arg; codex/gemini/amp are disabled globally at the
 *  adapter/image layer, and antigravity relies on the prompt-level block.
 *  Workflow steps that rely on native Task()/Agent sub-agent emulation are
 *  intentionally NOT listed here. */
const SUBAGENT_DISALLOWED_STEP_IDS = new Set<string>([
  '06_5-agent-discovery',
  '08-knowledge-acquisition',
  '09-qa',
  '09_1-qa-suggestions',
  '09_2-qa-resolve',
  '09_5-skill-generation',
  '09_5b-skill-repair',
  '11d-skill-sync',
]);

/** `['Agent']` for a mining step (blocks native sub-agent spawning), else undefined. */
function miningDisallowedTools(stepId: string): string[] | undefined {
  return SUBAGENT_DISALLOWED_STEP_IDS.has(stepId) ? ['Agent'] : undefined;
}

/** Loads the submitted `formValues` from the most recent successfully completed
 *  task (same repository, same user, same workflow type) whose row for this step
 *  id finished (status 'done') with non-null form values. Returns undefined when
 *  no such task exists. Used by the runner to auto-submit a step from a prior
 *  task's exact answers when the step opts in via metadata.reuseLastCompletedFormValues.
 *  The runner validates the result against the current schema, so a stale shape
 *  fails validation there and the step falls back to waiting_form. */
async function loadLastCompletedFormValues(
  db: Database,
  params: {
    repositoryId: string;
    userId: string;
    type: (typeof schema.tasks.$inferSelect)['type'];
    stepId: string;
  },
): Promise<FormValues | undefined> {
  const rows = await db
    .select({ formValues: schema.taskSteps.formValues })
    .from(schema.taskSteps)
    .innerJoin(schema.tasks, eq(schema.taskSteps.taskId, schema.tasks.id))
    .where(
      and(
        eq(schema.tasks.repositoryId, params.repositoryId),
        eq(schema.tasks.userId, params.userId),
        eq(schema.tasks.type, params.type),
        eq(schema.tasks.status, 'completed'),
        eq(schema.taskSteps.stepId, params.stepId),
        eq(schema.taskSteps.status, 'done'),
        isNotNull(schema.taskSteps.formValues),
      ),
    )
    .orderBy(desc(schema.tasks.completedAt))
    .limit(1);
  return rows[0]?.formValues ?? undefined;
}

/** Returns the user's explicit per-step CLI override (set via the task UI),
 *  validated as enabled, plus the effort/reasoning override stored beside it on
 *  the same preference row (null when none). Falls back to the task default CLI
 *  (and null effort) when no explicit override exists or the override's provider
 *  is disabled/deleted. Legacy auto-recorded rows (explicit=false) are ignored so
 *  the task provider wins. */
export async function resolvePreferredCli(
  db: Database,
  userId: string,
  stepId: string,
  fallback: string | null,
  providers: { id: string; enabled: boolean }[],
  role: string = 'default',
  taskId?: string,
  ignoreSaved = false,
): Promise<{ cliProviderId: string | null; effortLevel: string | null }> {
  // When the task set ignore_saved_step_clis, a saved pref is honored only where
  // the user explicitly (re)set it WITHIN this task (a task_step_cli_touched
  // marker for that exact role); otherwise the step falls back to the task
  // provider. ignoreSaved=false (the default) makes every check below a no-op,
  // preserving the original resolution behavior.
  const isTouched = async (r: string): Promise<boolean> => {
    if (!taskId) return false;
    const m = await db.query.taskStepCliTouched.findFirst({
      where: and(
        eq(schema.taskStepCliTouched.taskId, taskId),
        eq(schema.taskStepCliTouched.stepId, stepId),
        eq(schema.taskStepCliTouched.role, r),
      ),
    });
    return !!m;
  };
  // Named roles (e.g. reviewer/corrector) first consult the per-role table; an
  // unset/disabled role falls through to the step's single 'default' pref, then
  // to the task provider, so partially-configured multi-CLI steps still run.
  if (role !== 'default') {
    const roleRow = await db.query.userStepCliRolePreferences.findFirst({
      where: and(
        eq(schema.userStepCliRolePreferences.userId, userId),
        eq(schema.userStepCliRolePreferences.stepId, stepId),
        eq(schema.userStepCliRolePreferences.role, role),
        eq(schema.userStepCliRolePreferences.explicit, true),
      ),
    });
    if (roleRow) {
      const p = providers.find((p) => p.id === roleRow.cliProviderId);
      if (p && p.enabled && (!ignoreSaved || (await isTouched(role)))) {
        return { cliProviderId: roleRow.cliProviderId, effortLevel: roleRow.effortLevel };
      }
    }
  }
  const row = await db.query.userStepCliPreferences.findFirst({
    where: and(
      eq(schema.userStepCliPreferences.userId, userId),
      eq(schema.userStepCliPreferences.stepId, stepId),
      eq(schema.userStepCliPreferences.explicit, true),
    ),
  });
  if (!row) return { cliProviderId: fallback, effortLevel: null };
  const provider = providers.find((p) => p.id === row.cliProviderId);
  if (!provider || !provider.enabled) return { cliProviderId: fallback, effortLevel: null };
  // Gate the 'default' read by its own marker so a flagged multi-role step can't
  // leak a pre-existing default pref via the role->default fallthrough above.
  if (ignoreSaved && !(await isTouched('default')))
    return { cliProviderId: fallback, effortLevel: null };
  return { cliProviderId: row.cliProviderId, effortLevel: row.effortLevel };
}

export interface WorkerDeps {
  enqueueCliInvocation(payload: CliExecJobPayload): Promise<void>;
}

export interface AdvanceStepParams {
  db: Database;
  taskId: string;
  userId: string;
  repoPath: string;
  workspacePath: string;
  cliProviderId: string | null;
  /** Per-task "ignore saved per-step CLIs" toggle (tasks.ignore_saved_step_clis).
   *  Threaded into resolvePreferredCli so a flagged task defaults each step to
   *  cliProviderId unless the user touched that step within the task. */
  ignoreSavedStepClis?: boolean;
  stepDef: StepDefinition;
  /** Fix-loop round to materialize/run the step at (default 0 = original pass). */
  round?: number;
  /** The step's position in the task's run list (buildRunList index), stamped onto
   *  task_steps.run_seq for run-order display. Undefined leaves run_seq null (the row
   *  then falls back to created_at ordering until a boot backfill fills it in). */
  runSeq?: number;
  formValues?: FormValues;
  providers?: CliProviderRecord[];
  deps?: WorkerDeps;
}

export type AdvanceStepResult =
  | { status: 'done'; row: TaskStepRow; output: unknown }
  | { status: 'waiting_form'; row: TaskStepRow; formSchema: FormSchema }
  | { status: 'waiting_cli'; row: TaskStepRow }
  | { status: 'skipped'; row: TaskStepRow }
  | {
      status: 'loop_back';
      row: TaskStepRow;
      diagnosis: string;
      sourceStepId: string;
      /** When true the loop_back skips the max_fix_rounds cap + escalation gate (a
       *  human-driven restart, e.g. gate-2 developer reject). Omitted = capped. */
      uncapped?: boolean;
    }
  | { status: 'revise'; row: TaskStepRow; targetStepId: string; sourceStepId: string }
  | { status: 'failed'; row: TaskStepRow; error: string };

type UpdatePatch = Partial<{
  status: StepStatus;
  detectOutput: unknown;
  formSchema: unknown;
  formValues: Record<string, unknown> | null;
  output: unknown;
  iterations: StepIterationEntry[];
  iterationCount: number;
  statusMessage: string | null;
  summary: string | null;
  errorMessage: string | null;
  errorHint: TaskStepRow['errorHint'];
  degradedNote: string | null;
  aiFixContext: { priorError: string; priorOutput: string } | null;
  pauseFormOnRetry: boolean;
  startedAt: Date;
  endedAt: Date;
}>;

type LlmResolved =
  | { resolved: true; llmOutput: unknown; current: TaskStepRow }
  | { resolved: false; result: AdvanceStepResult };

const IN_STACK_OLLAMA_HOSTS = new Set(['ollama', 'haive-ollama', 'localhost', '127.0.0.1']);

/** True when the resolved provider is an in-stack (local) Ollama model. Cloud
 *  models (tag suffix -cloud/:cloud) run on ollama.com via the local daemon as a
 *  proxy — they are strong models, so they are NOT "local" and never blocked,
 *  regardless of base URL. External remote Ollama (custom ANTHROPIC_BASE_URL host)
 *  and every non-Ollama provider are likewise not "local". */
function isLocalOllama(provider: CliProviderRecord | null): boolean {
  if (!provider || provider.name !== 'ollama') return false;
  // Cloud is tagged in the model name, NOT the base URL: the provider record
  // stores no ANTHROPIC_BASE_URL for cloud models (the daemon proxies them), so a
  // base-URL check alone defaults to the in-stack host and misclassifies every
  // cloud model as local. Key on the stable tag suffix instead.
  if (isOllamaCloudModel(provider.model ?? '')) return false;
  const baseUrl = provider.envVars?.ANTHROPIC_BASE_URL ?? 'http://ollama:11434';
  try {
    return IN_STACK_OLLAMA_HOSTS.has(new URL(baseUrl).hostname);
  } catch {
    return true; // unset/malformed → the adapter default is the in-stack daemon
  }
}

/** Guard a step flagged `unsafeForLocalModels` against a local Ollama model (it
 *  rewrites long-lived files where weak models are dangerous). Returns a failed
 *  AdvanceStepResult to short-circuit when blocked; null to proceed. The
 *  ALLOW_LOCAL_MODEL_DESTRUCTIVE_STEPS config flag downgrades the block to a
 *  warning. Cloud/remote Ollama and all other providers always pass. */
async function enforceLocalModelGuard(
  db: Database,
  stepDef: StepDefinition,
  current: TaskStepRow,
  ctx: StepContext,
  plan: DispatchPlan,
): Promise<AdvanceStepResult | null> {
  if (!stepDef.metadata.unsafeForLocalModels || !isLocalOllama(plan.provider)) return null;
  // Per-step manual override from the "Override and run" UI button (a retry that
  // sets task_steps.local_model_override). Lets a user without server shell access
  // run the step on a local model without the global config/env flag below.
  if (current.localModelOverride) {
    ctx.logger.warn(
      { stepId: stepDef.metadata.id, providerId: plan.providerId },
      'local Ollama model running a destructive step (per-step "Override and run")',
    );
    return null;
  }
  let allow = false;
  try {
    allow = await configService.getBoolean(CONFIG_KEYS.ALLOW_LOCAL_MODEL_DESTRUCTIVE_STEPS, false);
  } catch {
    // Config store unavailable (e.g. not initialized) → safe default: block.
    allow = false;
  }
  if (allow) {
    ctx.logger.warn(
      { stepId: stepDef.metadata.id, providerId: plan.providerId },
      'local Ollama model running a destructive step (ALLOW_LOCAL_MODEL_DESTRUCTIVE_STEPS override)',
    );
    return null;
  }
  const msg =
    `Step "${stepDef.metadata.id}" rewrites long-lived project files and is blocked for ` +
    `local Ollama models (low reliability for this work). Pick a commercial provider — or ` +
    `cloud/remote Ollama — for this step, use "Override and run" to proceed on this model ` +
    `anyway, or set ALLOW_LOCAL_MODEL_DESTRUCTIVE_STEPS=true to override globally.`;
  const failed = await updateRow(db, current.id, {
    status: 'failed',
    errorMessage: msg,
    errorHint: {
      type: 'local_model_destructive',
      stepId: stepDef.metadata.id,
      providerName: plan.provider?.name ?? 'ollama',
    },
    endedAt: new Date(),
  });
  return { status: 'failed', row: failed, error: msg };
}

/** Source provenance values a step sets on its apply output when it could not parse
 *  the model's response and fell back to a deterministic result. */
const DEGRADED_SOURCES = new Set(['stub', 'salvage', 'fallback']);

/** Non-fatal advisory text when a step ran its model but the output was unparseable
 *  and it degraded to a stub; null otherwise. Keys on the step's own `source`
 *  provenance (already emitted by most LLM steps) and requires the model to have
 *  actually produced output, so a legitimately skipped/absent LLM is never flagged. */
function computeDegradedNote(
  stepDef: StepDefinition,
  llmOutput: unknown,
  agentMiningResults: AgentMiningResult[] | undefined,
  output: unknown,
): string | null {
  if (!stepDef.llm && !stepDef.agentMining) return null;
  const llmProduced =
    llmOutput !== undefined &&
    llmOutput !== null &&
    !(typeof llmOutput === 'string' && llmOutput.trim() === '');
  const miningProduced =
    Array.isArray(agentMiningResults) &&
    agentMiningResults.some((r) => typeof r.rawOutput === 'string' && r.rawOutput.trim() !== '');
  if (!llmProduced && !miningProduced) return null;
  if (typeof output !== 'object' || output === null) return null;
  const o = output as { source?: unknown; degraded?: unknown };
  const bySource = typeof o.source === 'string' && DEGRADED_SOURCES.has(o.source);
  const byFlag = o.degraded === true;
  if (!bySource && !byFlag) return null;
  const detail = bySource ? ` (source: ${o.source as string})` : '';
  return (
    'The AI output could not be fully parsed, so this step used a deterministic fallback' +
    `${detail}. The result may be incomplete — consider a more capable model.`
  );
}

/** Mid-run steering is on by default for every Claude-family cli step; the global
 *  STEERING_ENABLED config is a kill-switch (default true). The dispatcher further
 *  ANDs this with adapter.supportsSteering, so non-Claude providers ignore it.
 *  Fail-safe: any config-read error → off (never fail dispatch). */
async function resolveSteeringEnabled(): Promise<boolean> {
  try {
    return await configService.getBoolean(CONFIG_KEYS.STEERING_ENABLED, true);
  } catch {
    return false;
  }
}

async function resolveLlmPhase(
  db: Database,
  stepDef: StepDefinition,
  current: TaskStepRow,
  ctx: StepContext,
  detected: unknown,
  formValues: FormValues | null,
  params: AdvanceStepParams,
): Promise<LlmResolved> {
  if (process.env.HAIVE_TEST_BYPASS_LLM === '1') {
    const stub = stepDef.llm?.bypassStub;
    const llmOutput = stub ? stub({ detected, formValues: formValues ?? {} }) : null;
    ctx.logger.warn(
      { hasStub: Boolean(stub) },
      'HAIVE_TEST_BYPASS_LLM=1, skipping llm with bypass stub',
    );
    return { resolved: true, llmOutput, current };
  }

  const llmSpec = stepDef.llm!;

  // Filter out CONSUMED invocations as well as superseded ones. A
  // consumed row is one whose output the runner has already incorporated
  // into a prior apply pass — only relevant when the step has a loop hook
  // (the runner sets consumed_at when it iterates). Without this filter
  // resolveLlmPhase would forever return iteration N's output instead of
  // enqueuing iteration N+1.
  const latest = await db
    .select()
    .from(schema.cliInvocations)
    .where(
      and(
        eq(schema.cliInvocations.taskStepId, current.id),
        isNull(schema.cliInvocations.supersededAt),
        isNull(schema.cliInvocations.consumedAt),
        ne(schema.cliInvocations.mode, 'agent_mining'),
      ),
    )
    .orderBy(desc(schema.cliInvocations.createdAt))
    .limit(1);
  const invocation = latest[0];

  if (invocation && invocation.endedAt !== null) {
    // An invocation failed if the CLI exited non-zero, exited abnormally
    // (null exit code = killed/timeout), or emitted an explicit errorMessage
    // (e.g. stream-json without a success result — rate-limit / early abort).
    const exitedBad = invocation.exitCode === null || invocation.exitCode !== 0;
    const errTrimmed = invocation.errorMessage?.trim() ?? '';
    const contentBad = errTrimmed.length > 0;
    if (exitedBad || contentBad) {
      // Best-effort LLM (e.g. gate-1 config recommendation): a failed invocation
      // must not fail the step. Degrade to null output and reuse this failed row
      // on re-entry (no re-dispatch) so downstream phases fall back to defaults.
      if (llmSpec.optional) {
        ctx.logger.warn({ phase: 'llm' }, 'optional llm invocation failed; degrading to null');
        return { resolved: true, llmOutput: null, current };
      }
      const rawTail = invocation.rawOutput?.trim().slice(-1000) ?? '';
      const message =
        errTrimmed || rawTail || `cli exited with code ${invocation.exitCode ?? 'unknown'}`;
      // Output-truncation retry: a response that hit the model's output-token cap
      // produces no result, so it never reaches apply()'s retry — handle it here by
      // consuming the bad row and re-dispatching a fresh invocation.
      //  - Non-loop steps: bounded by llm.retry.maxAttempts (total attempts).
      //  - Loop steps (no llm.retry): bounded by MAX_TRUNCATION_RETRIES consecutive
      //    truncations for the CURRENT iteration; each retry shrinks the request via
      //    buildIterationPrompt's truncationRetries (computed in the dispatch path),
      //    so a deterministically-oversized chunk converges to a fitting size
      //    instead of failing the whole step.
      if (isOutputTruncationMessage(errTrimmed)) {
        const llmRetry = llmSpec.retry;
        const canRetry = stepDef.loop
          ? (await countTrailingTruncations(db, current.id)) < MAX_TRUNCATION_RETRIES
          : !!llmRetry && (await countLlmAttempts(db, current.id)) < llmRetry.maxAttempts;
        if (canRetry) {
          ctx.logger.warn(
            { stepId: stepDef.metadata.id, message, loop: !!stepDef.loop },
            'cli output truncated; retrying with a fresh (smaller) invocation',
          );
          await markLatestInvocationConsumed(db, current.id);
          // resolveLlmPhase returns LlmResolved; a fresh dispatch parks in
          // waiting_cli (resolved:false) — propagate it as-is. If it somehow
          // resolved, fall through and fail normally below.
          const retryLlm = await resolveLlmPhase(
            db,
            stepDef,
            current,
            ctx,
            detected,
            formValues,
            params,
          );
          if (!retryLlm.resolved) return retryLlm;
        }
      }
      const failed = await updateRow(db, current.id, {
        status: 'failed',
        errorMessage: `cli invocation failed: ${message}`,
        endedAt: new Date(),
      });
      return { resolved: false, result: { status: 'failed', row: failed, error: message } };
    }
    const llmOutput = invocation.parsedOutput ?? invocation.rawOutput;
    return { resolved: true, llmOutput, current };
  }

  if (invocation && invocation.endedAt === null) {
    return { resolved: false, result: { status: 'waiting_cli', row: current } };
  }

  // No invocation exists yet — dispatch one
  if (!params.providers || !params.deps) {
    // Best-effort LLM with no providers available: skip rather than fail.
    if (llmSpec.optional) {
      return { resolved: true, llmOutput: null, current };
    }
    const failed = await updateRow(db, current.id, {
      status: 'failed',
      errorMessage: 'step requires CLI invocation but no providers or deps supplied',
      endedAt: new Date(),
    });
    return {
      resolved: false,
      result: {
        status: 'failed',
        row: failed,
        error: failed.errorMessage ?? 'missing worker deps',
      },
    };
  }

  // Optional async setup the invocation depends on (e.g. 08a starting the
  // runner's headed browser so chrome-devtools MCP can connect). Idempotent;
  // a throw here fails the step like any dispatch error.
  if (llmSpec.prepare) {
    await llmSpec.prepare({ ctx, detected, formValues: formValues ?? {} });
  }

  // For loop iterations > 0, prefer the loop's iteration-aware prompt
  // builder when present so the next pass receives prior findings; fall
  // back to the standard prompt otherwise. iteration here = passes
  // already completed (i.e. the upcoming pass's index).
  const previousIterations = stepIterationsAsRecords(current);
  const upcomingIteration = previousIterations.length;
  // Consecutive output-truncations for the current (pending) iteration. When > 0 a
  // same-iteration retry is underway; route even iteration 0 through the iteration
  // builder so its shrink hint (truncationRetries) reaches the first pass too.
  const truncationRetries = stepDef.loop ? await countTrailingTruncations(db, current.id) : 0;
  let prompt =
    (upcomingIteration > 0 || truncationRetries > 0) && stepDef.loop?.buildIterationPrompt
      ? stepDef.loop.buildIterationPrompt({
          detected,
          formValues: formValues ?? {},
          iteration: upcomingIteration,
          previousIterations,
          truncationRetries,
        })
      : llmSpec.buildPrompt({ detected, formValues: formValues ?? {} });
  // Make every CLI adapter aware of user-attached task files (the prompt flows
  // through the dispatcher unchanged). No-op when the task has no attachments.
  prompt = await augmentPromptWithAttachments(db, params.taskId, prompt);
  // Append the global, admin-configured terseness directive (prose only; structured
  // output and reasoning are carved out / untouched). Default level is 'full'.
  prompt = await augmentPromptWithTerseness(prompt);
  // Multi-CLI loop steps pick a role per iteration (e.g. reviewer vs corrector);
  // the resolved provider differs per role. Non-loop steps resolve 'default'.
  const role = stepDef.loop?.resolveRole?.(upcomingIteration) ?? 'default';
  const { cliProviderId: preferredProviderId, effortLevel: preferredEffort } =
    await resolvePreferredCli(
      db,
      params.userId,
      stepDef.metadata.id,
      params.cliProviderId ?? null,
      params.providers,
      role,
      params.taskId,
      params.ignoreSavedStepClis ?? false,
    );
  const steeringRequested = await resolveSteeringEnabled();
  const plan = await resolveTaskDispatch(db, params.taskId, {
    providers: params.providers,
    preferredProviderId,
    steeringRequested,
    input: {
      kind: 'prompt',
      prompt,
      capabilities: llmSpec.requiredCapabilities,
    },
    invokeOpts: {
      cwd: params.workspacePath,
      effortLevel: preferredEffort ?? undefined,
      disallowedTools: miningDisallowedTools(stepDef.metadata.id),
      disableTools: llmSpec.disableTools,
    },
  });

  if (plan.mode === 'skip' || !plan.invocation) {
    const failed = await updateRow(db, current.id, {
      status: 'failed',
      errorMessage: `no cli provider available: ${plan.reason}`,
      endedAt: new Date(),
    });
    return {
      resolved: false,
      result: { status: 'failed', row: failed, error: failed.errorMessage ?? plan.reason },
    };
  }

  const guard = await enforceLocalModelGuard(db, stepDef, current, ctx, plan);
  if (guard) return { resolved: false, result: guard };

  const mode = plan.mode === 'subagent_emulated' ? 'subagent_emulated' : 'cli';
  // For multi-CLI loop steps, label the invocation with its role (Validator /
  // Fixer / Reviewer / Corrector / …) so the terminal header shows which pass it is.
  const roleLabel =
    role !== 'default'
      ? (stepDef.metadata.cliRoles?.find((r) => r.id === role)?.label ?? null)
      : null;
  const payloadKind: CliExecInvocationKind =
    plan.invocation.kind === 'subagent'
      ? plan.mode === 'subagent_emulated'
        ? 'subagent_sequential'
        : 'subagent_native'
      : 'cli';
  const inserted = await db
    .insert(schema.cliInvocations)
    .values({
      taskId: params.taskId,
      taskStepId: current.id,
      cliProviderId: plan.providerId,
      mode,
      prompt: plan.effectivePrompt ?? prompt,
      agentTitle: roleLabel,
      steerable: plan.invocation.kind === 'cli' && plan.invocation.spec.steerable === true,
    })
    .returning();
  const invRow = inserted[0];
  if (!invRow) throw new Error('failed to insert cli_invocations row');
  await params.deps.enqueueCliInvocation({
    invocationId: invRow.id,
    taskId: params.taskId,
    taskStepId: current.id,
    userId: params.userId,
    cliProviderId: plan.providerId,
    effortLevel: preferredEffort ?? undefined,
    kind: payloadKind,
    spec: plan.invocation.spec,
    timeoutMs: llmSpec.timeoutMs,
  });
  const updated = await updateRow(db, current.id, {
    status: 'waiting_cli',
    statusMessage: 'Waiting for AI analysis...',
  });
  ctx.logger.info(
    { invocationId: invRow.id, providerId: plan.providerId, mode: plan.mode },
    'cli invocation enqueued',
  );
  return { resolved: false, result: { status: 'waiting_cli', row: updated } };
}

/** AI-assisted retry: when the retry_ai action set `aiFixContext` on the step,
 *  run a diagnose-and-fix agent once (reusing the cli-invocation lifecycle), then
 *  clear the marker so apply re-runs against the fixed workspace. Designed for
 *  deterministic steps (the agent fixes the repo/env; the step re-runs itself). */
async function resolveAiFixPhase(
  db: Database,
  stepDef: StepDefinition,
  current: TaskStepRow,
  ctx: StepContext,
  params: AdvanceStepParams,
): Promise<
  { resolved: true; current: TaskStepRow } | { resolved: false; result: AdvanceStepResult }
> {
  const fixCtx = current.aiFixContext as { priorError: string; priorOutput: string } | null;
  if (!fixCtx) return { resolved: true, current };

  const latest = await db
    .select()
    .from(schema.cliInvocations)
    .where(
      and(
        eq(schema.cliInvocations.taskStepId, current.id),
        isNull(schema.cliInvocations.supersededAt),
        isNull(schema.cliInvocations.consumedAt),
        ne(schema.cliInvocations.mode, 'agent_mining'),
      ),
    )
    .orderBy(desc(schema.cliInvocations.createdAt))
    .limit(1);
  const invocation = latest[0];

  if (invocation && invocation.endedAt !== null) {
    // The fix agent finished (whether or not it succeeded). Consume it + clear
    // the marker, then let apply re-run against whatever the agent changed. If
    // the fix didn't help, apply fails again and re-surfaces the error.
    await markLatestInvocationConsumed(db, current.id);
    const updated = await updateRow(db, current.id, { aiFixContext: null });
    return { resolved: true, current: updated };
  }
  if (invocation && invocation.endedAt === null) {
    return { resolved: false, result: { status: 'waiting_cli', row: current } };
  }

  if (!params.providers || !params.deps) {
    const failed = await updateRow(db, current.id, {
      status: 'failed',
      errorMessage: 'retry_ai requires a CLI provider but none is available',
      aiFixContext: null,
      endedAt: new Date(),
    });
    return {
      resolved: false,
      result: { status: 'failed', row: failed, error: failed.errorMessage ?? 'no provider' },
    };
  }

  const prompt = [
    'A workflow step just failed. Diagnose the root cause and FIX it by editing files in the workspace so the step can succeed when it re-runs.',
    `Step: ${stepDef.metadata.id} (${stepDef.metadata.title}).`,
    '',
    `Failure error:\n${fixCtx.priorError || '(none recorded)'}`,
    fixCtx.priorOutput ? `\nOutput tail:\n${fixCtx.priorOutput}` : '',
    '',
    'Make minimal, correct edits. The step re-runs automatically after you finish — do NOT run it yourself. When done, stop.',
  ].join('\n');

  const { cliProviderId: preferredProviderId, effortLevel: preferredEffort } =
    await resolvePreferredCli(
      db,
      params.userId,
      stepDef.metadata.id,
      params.cliProviderId ?? null,
      params.providers,
      'default',
      params.taskId,
      params.ignoreSavedStepClis ?? false,
    );
  const plan = await resolveTaskDispatch(db, params.taskId, {
    providers: params.providers,
    preferredProviderId,
    input: { kind: 'prompt', prompt, capabilities: ['tool_use', 'file_write'] },
    invokeOpts: { cwd: params.workspacePath, effortLevel: preferredEffort ?? undefined },
  });
  if (plan.mode === 'skip' || !plan.invocation) {
    const failed = await updateRow(db, current.id, {
      status: 'failed',
      errorMessage: `retry_ai: no cli provider available: ${plan.reason}`,
      aiFixContext: null,
      endedAt: new Date(),
    });
    return {
      resolved: false,
      result: { status: 'failed', row: failed, error: failed.errorMessage ?? plan.reason },
    };
  }

  const fixGuard = await enforceLocalModelGuard(db, stepDef, current, ctx, plan);
  if (fixGuard) return { resolved: false, result: fixGuard };

  const fixMode = plan.mode === 'subagent_emulated' ? 'subagent_emulated' : 'cli';
  const payloadKind: CliExecInvocationKind =
    plan.invocation.kind === 'subagent'
      ? plan.mode === 'subagent_emulated'
        ? 'subagent_sequential'
        : 'subagent_native'
      : 'cli';
  const inserted = await db
    .insert(schema.cliInvocations)
    .values({
      taskId: params.taskId,
      taskStepId: current.id,
      cliProviderId: plan.providerId,
      mode: fixMode,
      prompt: plan.effectivePrompt ?? prompt,
    })
    .returning();
  const invRow = inserted[0];
  if (!invRow) throw new Error('failed to insert ai-fix cli_invocations row');
  await params.deps.enqueueCliInvocation({
    invocationId: invRow.id,
    taskId: params.taskId,
    taskStepId: current.id,
    userId: params.userId,
    cliProviderId: plan.providerId,
    effortLevel: preferredEffort ?? undefined,
    kind: payloadKind,
    spec: plan.invocation.spec,
    timeoutMs: 30 * 60 * 1000,
  });
  const updated = await updateRow(db, current.id, {
    status: 'waiting_cli',
    statusMessage: 'AI diagnosing the failure…',
  });
  ctx.logger.info(
    { invocationId: invRow.id, providerId: plan.providerId },
    'ai-fix agent enqueued',
  );
  return { resolved: false, result: { status: 'waiting_cli', row: updated } };
}

type AgentMiningResolved =
  | { resolved: true; results: AgentMiningResult[]; current: TaskStepRow }
  | { resolved: false; result: AdvanceStepResult };

async function resolveAgentMiningPhase(
  db: Database,
  stepDef: StepDefinition,
  current: TaskStepRow,
  ctx: StepContext,
  detected: unknown,
  formValues: FormValues | null,
  llmOutput: unknown,
  params: AdvanceStepParams,
): Promise<AgentMiningResolved> {
  const spec = stepDef.agentMining!;

  const existing = await db
    .select()
    .from(schema.taskStepAgentMinings)
    .where(eq(schema.taskStepAgentMinings.taskStepId, current.id));

  if (existing.length > 0) {
    const pending = existing.filter((r) => r.status === 'pending' || r.status === 'running');
    if (pending.length > 0) {
      return { resolved: false, result: { status: 'waiting_cli', row: current } };
    }
    const results: AgentMiningResult[] = existing.map((r) => ({
      agentId: r.agentId,
      agentTitle: r.agentTitle,
      status: r.status === 'done' ? 'done' : 'failed',
      output: r.output,
      rawOutput: r.rawOutput,
      errorMessage: r.errorMessage,
    }));

    // A mining terminal can fail independently of its siblings (for example, a
    // provider connection dropping mid-response). Let an opt-in step re-roll only
    // the transient failures before apply() consumes the batch. This uses the same
    // durable per-agent attempts budget as MiningRetryError, so a failure cannot
    // loop forever and successful siblings are never re-run.
    const miningRetry = spec.retry;
    const retryOnInvocationFailure = miningRetry?.retryOnInvocationFailure;
    if (
      miningRetry &&
      retryOnInvocationFailure &&
      !stepDef.loop &&
      params.providers &&
      params.deps
    ) {
      const retryableAgentIds = existing.flatMap((row, index) => {
        if (row.status !== 'failed' || row.attempts >= miningRetry.maxAttempts) return [];
        const result = results[index];
        return result && retryOnInvocationFailure(result) ? [row.agentId] : [];
      });
      if (retryableAgentIds.length > 0) {
        const requeued = await retryMiningAgents(
          db,
          stepDef,
          current,
          ctx,
          detected,
          formValues,
          llmOutput,
          params,
          retryableAgentIds,
          miningRetry.maxAttempts,
        );
        if (requeued > 0) {
          ctx.logger.warn(
            {
              stepId: stepDef.metadata.id,
              agentIds: retryableAgentIds,
              requeued,
              maxAttempts: miningRetry.maxAttempts,
            },
            're-running mining agents after transient terminal failure',
          );
          const parked = await updateRow(db, current.id, {
            status: 'waiting_cli',
            statusMessage: `Re-running ${requeued} mining agent(s) after a transient terminal failure...`,
          });
          return { resolved: false, result: { status: 'waiting_cli', row: parked } };
        }
      }
    }
    return { resolved: true, results, current };
  }

  if (!params.providers || !params.deps) {
    const failed = await updateRow(db, current.id, {
      status: 'failed',
      errorMessage: 'agent mining requires CLI invocation but no providers or deps supplied',
      endedAt: new Date(),
    });
    return {
      resolved: false,
      result: { status: 'failed', row: failed, error: failed.errorMessage ?? 'missing deps' },
    };
  }

  const dispatches = await spec.selectAgents({
    ctx,
    detected,
    formValues: formValues ?? {},
    llmOutput,
  });

  if (dispatches.length === 0) {
    ctx.logger.warn('agent mining selectAgents returned empty list, skipping mining');
    return { resolved: true, results: [], current };
  }

  const dispatched = await dispatchMiningAgents(
    db,
    stepDef,
    current,
    ctx,
    params,
    dispatches,
    null,
  );

  const updated = await updateRow(db, current.id, {
    status: 'waiting_cli',
    statusMessage: `Mining knowledge from ${dispatches.length} agent(s)...`,
  });
  ctx.logger.info(
    { dispatched, agentIds: dispatches.map((d) => d.agentId) },
    'agent mining fan-out enqueued',
  );
  return { resolved: false, result: { status: 'waiting_cli', row: updated } };
}

/** Existing mining row a retry re-dispatches onto, keyed by agentId. */
type MiningRetryTargets = Map<
  string,
  { id: string; attempts: number; cliInvocationId: string | null }
>;

/** Enqueue one cli invocation per dispatch.
 *
 *  Shared by the initial fan-out (`existing` = null, one INSERT per agent) and the
 *  per-agent retry (`existing` = the rows to re-roll, UPDATEd in place because the
 *  (task_step_id, agent_id) unique index forbids a second row per agent). Returns the
 *  number actually enqueued. */
async function dispatchMiningAgents(
  db: Database,
  stepDef: StepDefinition,
  current: TaskStepRow,
  ctx: StepContext,
  params: AdvanceStepParams,
  dispatches: AgentMiningDispatch[],
  existing: MiningRetryTargets | null,
): Promise<number> {
  const spec = stepDef.agentMining!;
  const { cliProviderId: preferredProviderId, effortLevel: preferredEffort } =
    await resolvePreferredCli(
      db,
      params.userId,
      stepDef.metadata.id,
      params.cliProviderId ?? null,
      params.providers!,
      'default',
      params.taskId,
      params.ignoreSavedStepClis ?? false,
    );
  // Each mining agent is its own Claude-family invocation with its own terminal,
  // so each is independently steerable (gated globally + by adapter support).
  const steeringRequested = await resolveSteeringEnabled();
  let enqueued = 0;

  for (const dispatch of dispatches) {
    const prior = existing?.get(dispatch.agentId) ?? null;
    // Close the mining terseness gap: the main dispatch gets the admin terseness level
    // at resolveLlmPhase, but fan-out sub-prompts are built per step and bypass it.
    // Apply the same directive so the level reaches mining output (skill-gen, discovery,
    // review). Agent-backed mining also carries its agent-file RESPONSE_STYLE_BLOCK; the
    // runtime directive is appended last and governs at prompt scope.
    const prompt = await augmentPromptWithTerseness(dispatch.prompt);
    const plan = await resolveTaskDispatch(db, params.taskId, {
      providers: params.providers!,
      preferredProviderId,
      steeringRequested,
      input: {
        kind: 'prompt',
        prompt,
        capabilities: spec.requiredCapabilities,
      },
      invokeOpts: {
        cwd: params.workspacePath,
        effortLevel: preferredEffort ?? undefined,
        disallowedTools: miningDisallowedTools(stepDef.metadata.id),
      },
    });

    if (plan.mode === 'skip' || !plan.invocation || plan.invocation.kind !== 'cli') {
      const failure = {
        status: 'failed' as const,
        errorMessage: `no cli provider available: ${plan.reason}`,
        endedAt: new Date(),
      };
      if (prior) {
        await db
          .update(schema.taskStepAgentMinings)
          .set({ ...failure, updatedAt: new Date() })
          .where(eq(schema.taskStepAgentMinings.id, prior.id));
      } else {
        await db.insert(schema.taskStepAgentMinings).values({
          taskStepId: current.id,
          agentId: dispatch.agentId,
          agentTitle: dispatch.agentTitle,
          ...failure,
        });
      }
      continue;
    }

    const inv = await db
      .insert(schema.cliInvocations)
      .values({
        taskId: params.taskId,
        taskStepId: current.id,
        cliProviderId: plan.providerId,
        mode: 'agent_mining',
        prompt: plan.effectivePrompt ?? prompt,
        steerable: plan.invocation.spec.steerable === true,
      })
      .returning();
    const invRow = inv[0];
    if (!invRow) throw new Error('failed to insert cli_invocations row for agent mining');

    let miningId: string;
    if (prior) {
      // Re-roll: supersede the prior terminal invocation, then reset the row to
      // pending so the fan-out barrier re-parks the step on it. The prior run may
      // have failed in transport or produced output apply() could not use.
      if (prior.cliInvocationId) {
        await db
          .update(schema.cliInvocations)
          .set({ supersededAt: new Date() })
          .where(eq(schema.cliInvocations.id, prior.cliInvocationId));
      }
      await db
        .update(schema.taskStepAgentMinings)
        .set({
          status: 'pending',
          cliProviderId: plan.providerId,
          cliInvocationId: invRow.id,
          output: null,
          rawOutput: null,
          errorMessage: null,
          startedAt: null,
          endedAt: null,
          attempts: prior.attempts + 1,
          updatedAt: new Date(),
        })
        .where(eq(schema.taskStepAgentMinings.id, prior.id));
      miningId = prior.id;
    } else {
      const mining = await db
        .insert(schema.taskStepAgentMinings)
        .values({
          taskStepId: current.id,
          agentId: dispatch.agentId,
          agentTitle: dispatch.agentTitle,
          cliProviderId: plan.providerId,
          cliInvocationId: invRow.id,
          status: 'pending',
        })
        // Idempotent fan-out: if a concurrent/duplicate execution already reserved this
        // (taskStepId, agentId) slot, skip rather than crash on the unique index. The epoch
        // guard prevents the cross-generation race; this covers a residual same-epoch
        // double-delivery. Supersede the invocation we just opened so it is not left orphaned.
        .onConflictDoNothing({
          target: [schema.taskStepAgentMinings.taskStepId, schema.taskStepAgentMinings.agentId],
        })
        .returning();
      const miningRow = mining[0];
      if (!miningRow) {
        await db
          .update(schema.cliInvocations)
          .set({ supersededAt: new Date() })
          .where(eq(schema.cliInvocations.id, invRow.id));
        ctx.logger.warn(
          { agentId: dispatch.agentId, taskStepId: current.id },
          'agent mining row already exists (concurrent/duplicate run) — skipping duplicate dispatch',
        );
        continue;
      }
      miningId = miningRow.id;
    }

    await params.deps!.enqueueCliInvocation({
      invocationId: invRow.id,
      taskId: params.taskId,
      taskStepId: current.id,
      userId: params.userId,
      cliProviderId: plan.providerId,
      kind: 'agent_mining',
      spec: plan.invocation.spec,
      timeoutMs: spec.timeoutMs,
      agentMiningId: miningId,
      softTimeout: spec.softTimeout === true,
    });
    enqueued++;
  }
  return enqueued;
}

const CANCEL_POLL_INTERVAL_MS = 2_000;

export async function advanceStep(params: AdvanceStepParams): Promise<AdvanceStepResult> {
  const { db, stepDef, taskId } = params;
  const meta = stepDef.metadata;
  const round = params.round ?? 0;

  const row = await upsertRow(db, taskId, stepDef, round, params.runSeq);

  // Terminal short-circuit. A `done`/`skipped` row reaching advanceStep is always a
  // stale/duplicate advance job or a resume walk passing back through already-finished
  // steps — a genuine re-run always arrives as `pending` (resetStepAndDownstream). Re-running
  // the phases here re-executes detect/apply and, worse, re-stamps `endedAt = now` on the
  // completion write below, inflating the step's wall span (and thus its billed "work") by
  // the entire parked/idle gap since it first finished. Return the stored row untouched.
  // Mirrors handleAdvanceStep's `skipped` guard; placed here so handleStartTask's direct
  // advanceStep(steps[0]) call is covered on retry/resume too.
  if (row.status === 'done') return { status: 'done', row, output: row.output };
  if (row.status === 'skipped') return { status: 'skipped', row };

  const controller = new AbortController();
  const throwIfCancelled = (): void => {
    if (controller.signal.aborted) {
      throw new TaskCancelledError();
    }
  };
  const pollTimer = setInterval(() => {
    void (async () => {
      try {
        const statusRow = await db.query.tasks.findFirst({
          where: eq(schema.tasks.id, taskId),
          columns: { status: true },
        });
        // Abort the in-flight step when the task is stopped out-of-band. A user
        // Cancel sets the task `cancelled`; a user Stop (cancel-active-cli) sets
        // it `failed`. Both must reach a running deterministic apply loop — which
        // only polls this flag, not its own step row — or Stop can't halt a long
        // run like RAG-populate (it would keep embedding after the click).
        if (statusRow?.status === 'cancelled' || statusRow?.status === 'failed') {
          controller.abort();
        }
      } catch (err) {
        log.warn({ err, taskId }, 'cancel poll failed');
      }
    })();
  }, CANCEL_POLL_INTERVAL_MS);

  const ctx: StepContext = {
    taskId,
    taskStepId: row.id,
    userId: params.userId,
    repoPath: params.repoPath,
    workspacePath: params.workspacePath,
    sandboxWorkdir: SANDBOX_WORKDIR,
    cliProviderId: params.cliProviderId,
    round,
    db,
    logger: log.child({ stepId: meta.id, taskId, taskStepId: row.id }),
    signal: controller.signal,
    throwIfCancelled,
    async emitProgress(message: string) {
      // Cosmetic status-line write. Best-effort: emitters fire this and discard the
      // promise (`void ctx.emitProgress(...)` on a setInterval heartbeat, per-file RAG
      // sync, etc.), so a transient DB/DNS blip here (e.g. `EAI_AGAIN postgres`) would
      // reject unhandled and kill the whole worker — freezing every task. Swallow + log.
      try {
        await updateRow(db, row.id, { statusMessage: message });
      } catch (err) {
        log.warn({ err, taskId, taskStepId: row.id }, 'progress update failed (non-fatal)');
      }
    },
  };

  try {
    if (stepDef.shouldRun) {
      const should = await stepDef.shouldRun(ctx);
      if (!should) {
        const updated = await updateRow(db, row.id, {
          status: 'skipped',
          endedAt: new Date(),
        });
        return { status: 'skipped', row: updated };
      }
    }

    let current = row;
    if (current.status === 'pending') {
      current = await updateRow(db, current.id, {
        status: 'running',
        startedAt: new Date(),
      });
    }

    let detected = current.detectOutput;
    if (detected === null || detected === undefined) {
      detected = stepDef.detect ? await stepDef.detect(ctx) : null;
      current = await updateRow(db, current.id, { detectOutput: detected, statusMessage: null });
    }

    // --- Pre-form LLM phase ---
    let llmOutput: unknown = undefined;
    if (stepDef.llm?.preForm) {
      const skip =
        stepDef.llm.skipIf?.({
          detected,
          formValues: {},
          iteration: stepIterationsAsRecords(current).length,
        }) ?? false;
      if (skip) {
        ctx.logger.info({ phase: 'llm.preForm' }, 'skipping llm phase via skipIf predicate');
      } else {
        const llmResult = await resolveLlmPhase(db, stepDef, current, ctx, detected, null, params);
        if (!llmResult.resolved) return llmResult.result;
        llmOutput = llmResult.llmOutput;
        current = llmResult.current;

        // Form-aware retry: re-roll a preForm generator whose output is unusable
        // BEFORE the form renders, so a form that surfaces the parse failure (a
        // manual-topics / candidate-selection / recipe-prefill prompt) is only shown
        // after the retry budget is spent. Reuses the llm.retry budget; each re-roll
        // parks and re-enters here, so this advances one attempt per completion.
        // Skipped under test bypass (no real invocation to re-roll).
        const preFormRetry = stepDef.llm.retry;
        if (
          preFormRetry &&
          process.env.HAIVE_TEST_BYPASS_LLM !== '1' &&
          stepDef.llm.shouldRetryPreForm?.(llmOutput)
        ) {
          const attempts = await countLlmAttempts(db, current.id);
          if (attempts < preFormRetry.maxAttempts) {
            ctx.logger.warn(
              { stepId: meta.id, attempts, maxAttempts: preFormRetry.maxAttempts },
              'preForm output unusable — re-rolling before form',
            );
            await markLatestInvocationConsumed(db, current.id);
            const reroll = await resolveLlmPhase(db, stepDef, current, ctx, detected, null, params);
            if (!reroll.resolved) return reroll.result;
            llmOutput = reroll.llmOutput;
            current = reroll.current;
          }
        }
      }
    }

    // --- Form ---
    // Auto-continue flag + gate-1 pre-answers for this step. One indexed PK
    // lookup; a missing row (unit-test fixtures) behaves like autoContinue=true
    // with no pre-answers, i.e. today's behavior.
    const taskFlags = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, taskId),
      columns: { autoContinue: true, preAnswers: true, repositoryId: true, type: true },
    });
    const autoContinue = taskFlags?.autoContinue ?? true;
    const stepPreAnswer = (taskFlags?.preAnswers ?? {})[meta.id];

    let persistedSchema: FormSchema | null = (current.formSchema as FormSchema | null) ?? null;
    if (!persistedSchema && stepDef.form) {
      // Post-llm / pre-form seam: let the step produce any artifact the form's
      // web viewer will reference (form() itself is sync). Awaited once, here,
      // only when the form is first built.
      if (stepDef.prepareForm) {
        await stepDef.prepareForm(ctx, detected, llmOutput);
      }
      persistedSchema = stepDef.form(ctx, detected, llmOutput);
      // Pre-answers render as pre-filled defaults whenever this form DOES stop
      // (manual mode, or auto mode falling back after a validation miss).
      if (persistedSchema && stepPreAnswer) {
        persistedSchema = overlayPreAnswerDefaults(persistedSchema, stepPreAnswer);
      }
      current = await updateRow(db, current.id, {
        formSchema: persistedSchema ?? null,
        statusMessage: null,
      });
    }

    // Manual mode: EVERY step pauses before apply. Formless steps get a
    // synthesized confirm-only schema so the existing waiting_form plumbing
    // (submit endpoint, events, idle bookkeeping, web renderer) works
    // unchanged; submitting it posts {} which validates against zero fields.
    if (!persistedSchema && !autoContinue && !current.formValues && !params.formValues) {
      persistedSchema = synthesizeConfirmSchema(meta.title, meta.description);
      current = await updateRow(db, current.id, { formSchema: persistedSchema });
    }

    let formValues = current.formValues as FormValues | null;
    if (persistedSchema && !formValues && !params.formValues) {
      // Auto mode: (a) a gate-1 pre-answer for this step, else (b) {} for
      // zero-field info forms → try to auto-submit. A validation failure falls
      // through to waiting_form (never fails the step) — e.g. a pre-answered
      // browser mode that the runtime schema no longer offers. submitAction
      // 'retry' forms signal a broken precondition and are never auto-passed.
      // A form may opt to auto-submit even in manual mode (autoContinue off) via
      // its own `autoSubmit` flag — for an info-only form with nothing to decide
      // (e.g. 06b's single-agent decision).
      if (
        // A plain manual Retry set pauseFormOnRetry to force this step to STOP at
        // its form even under auto-continue — suppress every auto-submit variant
        // (pre-answer / reuse / zero-field / step defaults / form autoSubmit) so the
        // user can inspect and edit. Cleared on park below (one-shot).
        !current.pauseFormOnRetry &&
        (autoContinue || persistedSchema.autoSubmit === true) &&
        (persistedSchema.submitAction ?? 'submit') === 'submit'
      ) {
        // A step may reuse a prior completed task's exact answers for this form
        // (env-replicate's declare-deps / generate-dockerfile, whose values are
        // stable per project). Strictly auto-continue gated — never fires in manual
        // mode, even for a form that set its own autoSubmit. undefined when not
        // opted in, the task has no repository, or no prior completed task has this
        // form filled.
        const reusedValues =
          autoContinue &&
          !stepPreAnswer &&
          meta.reuseLastCompletedFormValues &&
          taskFlags?.repositoryId
            ? await loadLastCompletedFormValues(db, {
                repositoryId: taskFlags.repositoryId,
                userId: params.userId,
                type: taskFlags.type,
                stepId: meta.id,
              })
            : undefined;
        // Those answers are a snapshot of the repo as it was when the prior task ran.
        // A step whose answers can go stale (declare-deps: the repo gained a DDEV
        // project since) refreshes them against this task's detect() output before
        // they are auto-submitted, so the reuse path cannot replay a value the fresh
        // scan already contradicts.
        const reuseCandidate =
          reusedValues && stepDef.reconcileReusedFormValues
            ? await stepDef.reconcileReusedFormValues(ctx, detected, reusedValues)
            : reusedValues;
        // Candidate precedence: a gate pre-answer wins; else a prior completed
        // task's reused values; else a zero-field info form auto-passes with {};
        // else a step that opts in via metadata.autoSubmitDefaults (or the form's
        // own autoSubmit) auto-submits its declared field defaults.
        const candidate =
          stepPreAnswer ??
          reuseCandidate ??
          (persistedSchema.fields.length === 0
            ? {}
            : meta.autoSubmitDefaults || persistedSchema.autoSubmit
              ? extractFormDefaults(persistedSchema)
              : undefined);
        if (candidate !== undefined) {
          const validation = validateFormValues(persistedSchema, candidate);
          if (validation.success) {
            formValues = validation.data;
            current = await updateRow(db, current.id, { formValues, status: 'running' });
            ctx.logger.info(
              {
                source: stepPreAnswer
                  ? 'pre_answer'
                  : reuseCandidate
                    ? 'prior_task'
                    : persistedSchema.fields.length === 0
                      ? 'zero_field'
                      : 'step_defaults',
              },
              'auto-continue: form auto-submitted',
            );
          } else {
            ctx.logger.warn(
              { issues: validation.issues },
              'auto-continue: pre-answer failed validation; waiting for user',
            );
          }
        }
      }
      if (!formValues) {
        current = await updateRow(db, current.id, {
          status: 'waiting_form',
          // One-shot: a manual Retry set pauseFormOnRetry to force this park instead
          // of auto-submitting. Clear it here so the pause never leaks into a later
          // automatic re-run (fix-loop / revise / gate loop-back) of this same step.
          ...(current.pauseFormOnRetry ? { pauseFormOnRetry: false } : {}),
        });
        return {
          status: 'waiting_form',
          row: current,
          formSchema: persistedSchema,
        };
      }
    }

    if (persistedSchema && params.formValues) {
      const validation = validateFormValues(persistedSchema, params.formValues);
      if (!validation.success) {
        const failed = await updateRow(db, current.id, {
          status: 'failed',
          errorMessage: `validation failed: ${validation.issues.join('; ')}`,
          endedAt: new Date(),
        });
        return {
          status: 'failed',
          row: failed,
          error: validation.issues.join('; '),
        };
      }
      formValues = validation.data;
      current = await updateRow(db, current.id, {
        formValues,
        status: 'running',
      });
    }

    // --- AI-fix phase (retry_ai recovery) ---
    // When retry_ai set a fix marker, run a diagnose-and-fix agent once, then
    // re-run apply against the fixed workspace. The DAG executor is exempt: it
    // owns aiFixContext to resolve a merge conflict inside the integration
    // worktree (the generic agent would run at the repo root and would also
    // mis-consume a completed coder invocation). See resolveDagPhase.
    if (current.aiFixContext && !stepDef.dagExecute && !stepDef.mergeResolve) {
      const fixResult = await resolveAiFixPhase(db, stepDef, current, ctx, params);
      if (!fixResult.resolved) return fixResult.result;
      current = fixResult.current;
    }

    // --- Post-form LLM phase (default) ---
    if (stepDef.llm && !stepDef.llm.preForm) {
      const skip =
        stepDef.llm.skipIf?.({
          detected,
          formValues: formValues ?? {},
          iteration: stepIterationsAsRecords(current).length,
        }) ?? false;
      if (skip) {
        ctx.logger.info({ phase: 'llm.postForm' }, 'skipping llm phase via skipIf predicate');
      } else {
        const llmResult = await resolveLlmPhase(
          db,
          stepDef,
          current,
          ctx,
          detected,
          formValues,
          params,
        );
        if (!llmResult.resolved) return llmResult.result;
        llmOutput = llmResult.llmOutput;
        current = llmResult.current;
      }
    }

    // --- Agent mining phase (fan-out N CLI jobs, wait for all) ---
    let agentMiningResults: AgentMiningResult[] | undefined;
    if (stepDef.agentMining) {
      const miningResult = await resolveAgentMiningPhase(
        db,
        stepDef,
        current,
        ctx,
        detected,
        formValues,
        llmOutput,
        params,
      );
      if (!miningResult.resolved) return miningResult.result;
      agentMiningResults = miningResult.results;
      current = miningResult.current;
    }

    // --- DAG execution phase (multi-level coder fan-out; parks waiting_cli per
    // level until every level checkpoints, then apply finalizes the step) ---
    if (stepDef.dagExecute) {
      const dagResult = await resolveDagPhase(db, stepDef, current, ctx, params);
      if (!dagResult.resolved) return dagResult.result;
      current = dagResult.current;
    }

    // --- Merge-resolution phase (12-worktree-cleanup): merge the feature branch
    // into its base with an LLM conflict-resolution loop, parking waiting_cli (fix
    // agent) / waiting_form (user clarification) until the merge commits, then apply
    // removes the worktree. Mutually exclusive with dagExecute. ---
    if (stepDef.mergeResolve) {
      const mergeResult = await resolveMergePhase(db, stepDef, current, ctx, params);
      if (!mergeResult.resolved) return mergeResult.result;
      current = mergeResult.current;
    }

    const previousIterations = stepIterationsAsRecords(current);
    const iteration = previousIterations.length;
    // For llm.retry steps, tell apply whether this is the final attempt so it can
    // degrade (return its stub) instead of throwing a RetryableParseError once the
    // re-roll budget is spent. Non-retry steps are always "final" (degrade now).
    // Bypass (smoke) enqueues no invocation, so treat it as the final attempt
    // (degrade, never throw-to-retry). Non-retry steps are always final.
    const llmRetry = stepDef.llm?.retry;
    const isFinalLlmAttempt =
      process.env.HAIVE_TEST_BYPASS_LLM === '1' || !llmRetry
        ? true
        : (await countLlmAttempts(db, current.id)) >= llmRetry.maxAttempts;
    // Same contract for mining agents: final once NO agent has a re-roll left, so
    // apply() degrades (surfaces the reviewer as non-approving) instead of throwing.
    const miningRetry = stepDef.agentMining?.retry;
    const isFinalMiningAttempt =
      process.env.HAIVE_TEST_BYPASS_LLM === '1' || !miningRetry || stepDef.loop
        ? true
        : !(await miningAgentsWithBudget(db, current.id, miningRetry.maxAttempts));
    let output: unknown;
    try {
      output = await stepDef.apply(ctx, {
        detected,
        formValues: formValues ?? {},
        llmOutput,
        agentMiningResults,
        iteration,
        previousIterations,
        isFinalLlmAttempt,
        isFinalMiningAttempt,
      });
    } catch (applyErr) {
      // A second mining wave: agents whose prompts depend on what the first wave found.
      // Fresh rows, so the fan-out barrier re-parks the step; apply() runs again with
      // both waves in agentMiningResults. See MiningWaveError for why no other phase
      // can express this.
      if (
        applyErr instanceof MiningWaveError &&
        stepDef.agentMining &&
        !stepDef.loop &&
        params.providers &&
        params.deps
      ) {
        const dispatched = await dispatchMiningAgents(
          db,
          stepDef,
          current,
          ctx,
          params,
          applyErr.dispatches,
          null,
        );
        if (dispatched > 0) {
          ctx.logger.info(
            { stepId: meta.id, agentIds: applyErr.dispatches.map((d) => d.agentId) },
            'second mining wave dispatched',
          );
          const parked = await updateRow(db, current.id, {
            status: 'waiting_cli',
            statusMessage: `Running ${dispatched} follow-up agent(s)...`,
          });
          return { status: 'waiting_cli', row: parked };
        }
        // Nothing went out: every agent already had a row, or no provider could take
        // them (dispatchMiningAgents wrote those rows as failed). Parking would hang the
        // step on a barrier with nothing pending, so run apply() again and tell it the
        // wave is not coming. It must not ask a second time.
        ctx.logger.warn(
          { stepId: meta.id, agentIds: applyErr.dispatches.map((d) => d.agentId) },
          'second mining wave dispatched no agents; continuing without it',
        );
        output = await stepDef.apply(ctx, {
          detected,
          formValues: formValues ?? {},
          llmOutput,
          agentMiningResults,
          iteration,
          previousIterations,
          isFinalLlmAttempt,
          isFinalMiningAttempt,
          miningWaveExhausted: true,
        });
      }
      // agentMining.retry: a reviewer that ran but emitted prose instead of its JSON
      // contract is re-rolled on its own, leaving the other agents' completed rows
      // alone. Re-running one agent is far cheaper than the alternatives: a fix round
      // through implementation, or a developer reject at the gate.
      else if (applyErr instanceof MiningRetryError && miningRetry && !stepDef.loop) {
        const requeued = await retryMiningAgents(
          db,
          stepDef,
          current,
          ctx,
          detected,
          formValues,
          llmOutput,
          params,
          applyErr.agentIds,
          miningRetry.maxAttempts,
        );
        if (requeued > 0) {
          const parked = await updateRow(db, current.id, {
            status: 'waiting_cli',
            statusMessage: `Re-running ${requeued} agent(s) whose output could not be read...`,
          });
          return { status: 'waiting_cli', row: parked };
        }
        // Every NAMED agent is spent, but isFinalMiningAttempt was false because some
        // OTHER agent still had budget (peer exhausted on its re-roll, security fine on
        // its first). apply() cannot see that, so it threw. Re-run it as final and let
        // it degrade: failing the step here would discard a review that mostly worked.
        ctx.logger.warn(
          { stepId: meta.id, agentIds: applyErr.agentIds },
          'no re-roll budget left for the named agents; degrading',
        );
        output = await stepDef.apply(ctx, {
          detected,
          formValues: formValues ?? {},
          llmOutput,
          agentMiningResults,
          iteration,
          previousIterations,
          isFinalLlmAttempt,
          isFinalMiningAttempt: true,
        });
      } else {
        // llm.retry: a flaky model (e.g. a cloud Ollama model whose agentic tool-loop
        // intermittently ends with no JSON, or emits unparseable/truncated JSON) often
        // succeeds on a fresh roll. On a retryable apply throw, re-enqueue a NEW cli
        // invocation (consume the bad one) up to maxAttempts TOTAL, parking the step in
        // waiting_cli; once attempts are exhausted, rethrow so the outer catch fails the
        // step. Skipped for loop steps (they own their own re-dispatch counting).
        const retry = stepDef.llm?.retry;
        if (retry && !stepDef.loop && (retry.retryOn?.(applyErr) ?? true)) {
          const attempt = await countLlmAttempts(db, current.id);
          if (attempt < retry.maxAttempts) {
            ctx.logger.warn(
              {
                stepId: meta.id,
                attempt,
                maxAttempts: retry.maxAttempts,
                err: applyErr instanceof Error ? applyErr.message : String(applyErr),
              },
              'llm apply failed; retrying with a fresh invocation',
            );
            await markLatestInvocationConsumed(db, current.id);
            const retryLlm = await resolveLlmPhase(
              db,
              stepDef,
              current,
              ctx,
              detected,
              formValues,
              params,
            );
            // A fresh enqueue always parks in waiting_cli (resolved:false); return it
            // so the orchestrator re-enters when the retry invocation completes. If it
            // somehow resolved synchronously, fall through and rethrow.
            if (!retryLlm.resolved) return retryLlm.result;
          }
        }
        throw applyErr;
      }
    }

    // Curated per-step recap for the "What the agent did" panel. LLM steps that
    // already emit a summary field get it for free here; steps that ran an agent
    // but emit no summary field are left null for the async LLM summarizer
    // (handleResult) to fill. Deterministic steps stay null (no panel).
    const curatedSummary =
      stepDef.llm || stepDef.agentMining || stepDef.dagExecute
        ? resolveCuratedSummary(output)
        : null;

    // Non-fatal: surface when a step silently fell back to a stub because the model's
    // output was unparseable (a weak-but-alive model). Persisted on the done finalize.
    const degradedNote = computeDegradedNote(stepDef, llmOutput, agentMiningResults, output);

    // --- Loop hook: decide whether another LLM pass is warranted ---
    if (stepDef.loop) {
      const budget = (await resolveLoopBudget(db, taskId, current, stepDef)) ?? 1;
      const continueRequested = await stepDef.loop.shouldContinue({
        ctx,
        applyOutput: output,
        llmOutput,
        iteration,
        previousIterations,
      });
      const nextIteration = iteration + 1;
      const exhaustedBudget = continueRequested && nextIteration >= budget;
      // Mark this pass's invocation consumed so the next resolveLlmPhase
      // (whether triggered now for the next pass or later for retries)
      // enqueues a fresh CLI run instead of replaying the same output.
      await markLatestInvocationConsumed(db, current.id);
      const newEntry: StepIterationEntry = {
        iteration,
        llmOutput,
        applyOutput: output,
        continueRequested,
        recordedAt: new Date().toISOString(),
        ...(exhaustedBudget ? { exhaustedBudget: true } : {}),
      };
      const newIterations = [...(current.iterations ?? []), newEntry] as StepIterationEntry[];
      current = await updateRow(db, current.id, {
        iterations: newIterations,
        iterationCount: newIterations.length,
        statusMessage: null,
      });
      ctx.logger.info(
        { iteration, continueRequested, budget, exhaustedBudget },
        'loop pass completed',
      );
      if (continueRequested && !exhaustedBudget) {
        // Re-enter LLM phase to enqueue iteration N+1. This single
        // recursive resolveLlmPhase call (a) inserts a fresh
        // cli_invocations row, (b) flips status to waiting_cli, and
        // (c) returns. The orchestrator picks up where we left off when
        // that invocation completes.
        const llmResult = await resolveLlmPhase(
          db,
          stepDef,
          current,
          ctx,
          detected,
          formValues,
          params,
        );
        if (!llmResult.resolved) return llmResult.result;
        // Shouldn't reach here — resolveLlmPhase always returns
        // unresolved (waiting_cli) for fresh enqueues.
        ctx.logger.warn(
          { iteration: nextIteration },
          'loop re-enter resolved synchronously; falling through to done',
        );
      }
    }

    // No curated summary field was available → kick off a best-effort async LLM
    // summarizer that fills task_steps.summary later. We are past the loop hook here,
    // so this runs once per step finalization (not per loop pass) and never blocks it.
    if (!curatedSummary && (stepDef.llm || stepDef.agentMining || stepDef.dagExecute)) {
      await maybeEnqueueStepSummary(db, stepDef, current, params, output, ctx.logger);
    }

    // --- Fix-loop hook: a downstream step that finds a BLOCKING defect routes back
    // to the implementation step for a new round instead of finishing the chain. The
    // step row is still marked done (it ran successfully and produced its findings);
    // handleResult turns the loop_back into a round bump + re-entry at implement. ---
    // Skip the loop-back once the user accepted remaining issues at the escalation
    // gate — every later fix-loop check stands down so the run proceeds to gate 2.
    if (stepDef.fixLoop && !(await isFixLoopSuppressed(db, taskId))) {
      const verdict = stepDef.fixLoop.evaluate(output);
      if (verdict?.blocking) {
        const finished = await updateRow(db, current.id, {
          status: 'done',
          output,
          summary: curatedSummary,
          statusMessage: null,
          endedAt: new Date(),
        });
        ctx.logger.info(
          { stepId: meta.id, round },
          'fix-loop: blocking defect found; routing back to implementation',
        );
        return {
          status: 'loop_back',
          row: finished,
          diagnosis: verdict.diagnosis,
          sourceStepId: meta.id,
        };
      }
    }

    // --- Restart-loop hook: a HUMAN gate (gate-2 developer reject after browser/manual
    // verification) that asks to restart from implementation. Like fixLoop it returns
    // loop_back — round bump + re-enter at implement, whole chain re-runs as new round
    // rows — but UNCAPPED and suppression-immune: the developer is the bound, not
    // max_fix_rounds, and a prior auto-fix Accept does not stand it down. ---
    if (stepDef.restartLoop) {
      const restart = stepDef.restartLoop.evaluate(output);
      if (restart) {
        const finished = await updateRow(db, current.id, {
          status: 'done',
          output,
          summary: curatedSummary,
          statusMessage: null,
          endedAt: new Date(),
        });
        ctx.logger.info(
          { stepId: meta.id, round },
          'restart-loop: human gate requested restart from implementation (uncapped)',
        );
        return {
          status: 'loop_back',
          row: finished,
          diagnosis: restart.diagnosis,
          sourceStepId: meta.id,
          uncapped: true,
        };
      }
    }

    // --- Revise-loop hook: a review step whose apply output asks to revise an EARLIER
    // step (e.g. 03c reject → re-mine 03b). The step row is marked done (it ran fine and
    // recorded its decision); handleResult resets the target + its downstream and
    // re-enters the target in the SAME round. Human-gated (the review form re-parks each
    // cycle), so unlike fix-loop there is no round bump and no cap. ---
    if (stepDef.reviseLoop) {
      const target = stepDef.reviseLoop.evaluate(output);
      if (target) {
        const finished = await updateRow(db, current.id, {
          status: 'done',
          output,
          summary: curatedSummary,
          statusMessage: null,
          endedAt: new Date(),
        });
        ctx.logger.info(
          { stepId: meta.id, targetStepId: target.targetStepId },
          'revise-loop: apply requested revising an earlier step',
        );
        return {
          status: 'revise',
          row: finished,
          targetStepId: target.targetStepId,
          sourceStepId: meta.id,
        };
      }
    }

    // A Stop/Cancel that landed during apply() (task set failed/cancelled -> poll
    // aborted the signal) must win over this completion: honor it before the done
    // write so a finished step cannot clobber the stopped state back to 'done' and
    // advance. Long deterministic steps (RAG sync) also poll the signal internally;
    // this closes the return-race generically for every step.
    throwIfCancelled();
    const done = await updateRow(db, current.id, {
      status: 'done',
      output,
      summary: curatedSummary,
      degradedNote,
      statusMessage: null,
      endedAt: new Date(),
    });

    // Surface B: freeze context-window usage on the finished step (best-effort; never
    // blocks completion). No-op for deterministic steps (no CLI invocations). Returns
    // the provider whose allowance this step consumed, or null.
    const usageProviderId = await writeStepContextUsage(db, current.id).catch((err) => {
      log.warn({ err, stepId: meta.id }, 'failed to record step context usage');
      return null;
    });
    // A CLI step just consumed subscription allowance — kick a gentle usage poll so the
    // header meters and this step's stamp reflect it promptly (throttled per provider).
    if (usageProviderId)
      await enqueueUsagePollTick().catch((err) => {
        log.warn({ err, stepId: meta.id }, 'failed to enqueue usage poll after step');
      });

    return { status: 'done', row: done, output };
  } catch (err) {
    const cancelled = err instanceof TaskCancelledError;
    const errorMessage = cancelled
      ? 'task cancelled by user'
      : err instanceof Error
        ? err.message
        : String(err);
    if (cancelled) {
      log.info({ stepId: meta.id, taskId }, 'step aborted by task cancel');
    } else {
      log.error({ err, stepId: meta.id, taskId }, 'step runner failed');
    }
    // Deterministic fix-loop steps (e.g. 07c) route a fixable thrown failure back to
    // implementation as a diagnosis instead of failing the task. handleResult enforces
    // the round cap; at the cap the task fails with this diagnosis.
    if (!cancelled && stepDef.fixLoopOnError) {
      const finished = await updateRow(db, row.id, {
        status: 'done',
        statusMessage: null,
        errorMessage,
        endedAt: new Date(),
      }).catch(() => row);
      log.info(
        { stepId: meta.id, taskId, round },
        'fix-loop: step error routed back to implementation',
      );
      return { status: 'loop_back', row: finished, diagnosis: errorMessage, sourceStepId: meta.id };
    }
    const failed = await updateRow(db, row.id, {
      status: 'failed',
      statusMessage: null,
      errorMessage,
      endedAt: new Date(),
    }).catch(() => row);
    return { status: 'failed', row: failed, error: errorMessage };
  } finally {
    clearInterval(pollTimer);
    if (!controller.signal.aborted) controller.abort();
  }
}

const WORKFLOW_TYPE_OFFSETS: Record<string, number> = {
  onboarding: 0,
  env_replicate: 0,
  workflow: 100,
  kb_author: 300,
  run_app: 400,
};

export function computeGlobalStepIndex(workflowType: string, index: number): number {
  const offset = WORKFLOW_TYPE_OFFSETS[workflowType] ?? 0;
  return offset + index;
}

async function upsertRow(
  db: Database,
  taskId: string,
  stepDef: StepDefinition,
  round: number,
  runSeq?: number,
): Promise<TaskStepRow> {
  const meta = stepDef.metadata;
  const existing = await db
    .select()
    .from(schema.taskSteps)
    .where(
      and(
        eq(schema.taskSteps.taskId, taskId),
        eq(schema.taskSteps.stepId, meta.id),
        eq(schema.taskSteps.round, round),
      ),
    )
    .limit(1);
  if (existing[0]) {
    // Self-heal a row created before its run-list position was known (or before
    // run_seq existed) so its display order corrects without waiting for the boot
    // backfill. Only fills a null — never overwrites a stamped position.
    if (runSeq != null && existing[0].runSeq == null) {
      const [updated] = await db
        .update(schema.taskSteps)
        .set({ runSeq })
        .where(eq(schema.taskSteps.id, existing[0].id))
        .returning();
      return updated ?? existing[0];
    }
    return existing[0];
  }
  const inserted = await db
    .insert(schema.taskSteps)
    .values({
      taskId,
      stepId: meta.id,
      stepIndex: computeGlobalStepIndex(meta.workflowType, meta.index),
      runSeq: runSeq ?? null,
      round,
      title: meta.title,
      status: 'pending',
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new Error('Failed to insert task step row');
  return row;
}

async function updateRow(db: Database, id: string, patch: UpdatePatch): Promise<TaskStepRow> {
  const rows = await db
    .update(schema.taskSteps)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.taskSteps.id, id))
    .returning();
  const row = rows[0];
  if (!row) throw new Error(`Task step ${id} not found`);
  return row;
}

const STEP_SUMMARY_TIMEOUT_MS = 60_000;

/** Best-effort: enqueue a prompt-only LLM summarizer for a finalizing LLM step that
 *  produced no curated summary field. The invocation is unlinked (taskStepId=null) so
 *  it stays out of the step terminal and token totals; its completion handler writes
 *  task_steps.summary for `current.id` and does NOT resume the step machine. Never
 *  throws — a missing provider or failed call just leaves summary null (no panel). */
async function maybeEnqueueStepSummary(
  db: Database,
  stepDef: StepDefinition,
  current: TaskStepRow,
  params: AdvanceStepParams,
  output: unknown,
  logger: StepContext['logger'],
): Promise<void> {
  try {
    const { providers, deps } = params;
    if (!providers || !deps) return;
    const [latest] = await db
      .select({ rawOutput: schema.cliInvocations.rawOutput })
      .from(schema.cliInvocations)
      .where(
        and(
          eq(schema.cliInvocations.taskStepId, current.id),
          isNull(schema.cliInvocations.supersededAt),
          ne(schema.cliInvocations.mode, 'agent_mining'),
        ),
      )
      .orderBy(desc(schema.cliInvocations.createdAt))
      .limit(1);
    const rawOutput = latest?.rawOutput?.trim();

    // Single-agent steps (mode 'cli') summarize the one invocation's final message.
    // Multi-agent steps (agentMining) have no non-mining invocation on this step —
    // each reviewer's output lives in its own task_step_agent_minings row — so fall
    // back to a per-agent breakdown so the panel reflects the whole fan-out.
    let prompt: string;
    if (rawOutput) {
      prompt = buildStepSummaryPrompt(current.title, output, rawOutput);
    } else if (stepDef.agentMining) {
      const minings = await db
        .select({
          agentId: schema.taskStepAgentMinings.agentId,
          agentTitle: schema.taskStepAgentMinings.agentTitle,
          rawOutput: schema.taskStepAgentMinings.rawOutput,
        })
        .from(schema.taskStepAgentMinings)
        .where(eq(schema.taskStepAgentMinings.taskStepId, current.id))
        .orderBy(asc(schema.taskStepAgentMinings.createdAt));
      const agents = minings
        .map((m) => ({ title: m.agentTitle ?? m.agentId, text: (m.rawOutput ?? '').trim() }))
        .filter((a) => a.text.length > 0);
      if (agents.length === 0) return; // no agent text to summarize
      prompt = buildAgentMiningSummaryPrompt(current.title, output, agents);
    } else {
      return; // no agent text to summarize
    }
    const { cliProviderId: preferredProviderId, effortLevel: preferredEffort } =
      await resolvePreferredCli(
        db,
        params.userId,
        stepDef.metadata.id,
        params.cliProviderId ?? null,
        providers,
        'default',
        params.taskId,
        params.ignoreSavedStepClis ?? false,
      );
    const plan = await resolveTaskDispatch(db, params.taskId, {
      providers,
      preferredProviderId,
      input: { kind: 'prompt', prompt, capabilities: [] },
      invokeOpts: { cwd: params.workspacePath, effortLevel: preferredEffort ?? undefined },
    });
    const invocation = plan.invocation;
    if (plan.mode === 'skip' || !invocation || invocation.kind !== 'cli') return;

    const [invRow] = await db
      .insert(schema.cliInvocations)
      .values({
        taskId: params.taskId,
        taskStepId: null,
        cliProviderId: plan.providerId,
        mode: 'cli',
        prompt: plan.effectivePrompt ?? prompt,
        agentTitle: 'Step summary',
      })
      .returning({ id: schema.cliInvocations.id });
    if (!invRow) return;

    await deps.enqueueCliInvocation({
      invocationId: invRow.id,
      taskId: params.taskId,
      taskStepId: null,
      userId: params.userId,
      cliProviderId: plan.providerId,
      kind: 'cli',
      spec: invocation.spec,
      timeoutMs: STEP_SUMMARY_TIMEOUT_MS,
      purpose: 'step_summary',
      summaryForStepId: current.id,
    });
    logger.info({ stepId: stepDef.metadata.id, invocationId: invRow.id }, 'step summary enqueued');
  } catch (err) {
    logger.warn({ err, stepId: stepDef.metadata.id }, 'step summary enqueue failed (best-effort)');
  }
}

function buildStepSummaryPrompt(stepTitle: string, output: unknown, rawOutput: string): string {
  const structured = JSON.stringify(output ?? {}, null, 2).slice(0, 4000);
  const agentText = rawOutput.slice(0, 6000);
  return [
    `An automated coding agent just finished a workflow step titled "${stepTitle}".`,
    '',
    "The agent's final message was:",
    '"""',
    agentText,
    '"""',
    '',
    'Its structured result was:',
    '```json',
    structured,
    '```',
    '',
    'In 1-3 plain sentences, describe what the agent actually did in this step — what it ' +
      'found, changed, or fixed, and the outcome. Write only the summary itself: no ' +
      'preamble, no headings, no bullet list.',
  ].join('\n');
}

/** Multi-agent variant of buildStepSummaryPrompt. agentMining steps (code review,
 *  discovery, adversarial QA, skill generation) run several agents in parallel, each
 *  writing its own task_step_agent_minings row. Summarize what EACH agent did so the
 *  "What the agent did" panel reflects the whole fan-out, not a single terminal. */
function buildAgentMiningSummaryPrompt(
  stepTitle: string,
  output: unknown,
  agents: Array<{ title: string; text: string }>,
): string {
  const structured = JSON.stringify(output ?? {}, null, 2).slice(0, 3000);
  // Budget the raw text across agents so the prompt stays bounded regardless of how
  // many agents ran (2-6 depending on QA level).
  const perAgent = Math.max(800, Math.floor(7000 / Math.max(agents.length, 1)));
  const blocks = agents
    .map((a) => [`### ${a.title}`, a.text.slice(0, perAgent)].join('\n'))
    .join('\n\n');
  return [
    `Several automated agents ran in parallel during a workflow step titled "${stepTitle}".`,
    'Each agent and its final message:',
    '"""',
    blocks,
    '"""',
    '',
    'The combined structured result was:',
    '```json',
    structured,
    '```',
    '',
    'Summarize what each agent did: one short line per agent in the form ' +
      '"Agent Name — what it found or concluded", leading each line with the agent name ' +
      'exactly as given above. End with a final line stating the overall outcome (e.g. the ' +
      'blocking verdict). Write only the summary: no preamble, no extra headings, no JSON.',
  ].join('\n');
}

/** Read the step's persisted iterations array as the lighter-weight
 *  StepLoopPassRecord shape exposed to step modules. Strips bookkeeping
 *  fields (continueRequested flag stays since loop modules want it). */
function stepIterationsAsRecords(row: TaskStepRow): StepLoopPassRecord[] {
  const rows = (row.iterations ?? []) as StepIterationEntry[];
  return rows.map((entry) => ({
    iteration: entry.iteration,
    llmOutput: entry.llmOutput,
    applyOutput: entry.applyOutput,
    continueRequested: entry.continueRequested,
  }));
}

/** Resolve the max-iterations budget for a loop step. Precedence:
 *   1. The step's formValues.maxIterations — the in-form selector wins so
 *      the user can change the budget on retry without touching the task.
 *   2. tasks.step_loop_limits[stepId] — set at task creation time from
 *      the new-task form selector.
 *   3. loopSpec.maxIterations — built-in default when neither override
 *      exists.
 *  Returns null if the step has no loop hook at all. */
async function resolveLoopBudget(
  db: Database,
  taskId: string,
  current: TaskStepRow,
  stepDef: StepDefinition,
): Promise<number | null> {
  if (!stepDef.loop) return null;
  // The configured budget is in ROUNDS; multiply by passesPerRound to get the
  // actual LLM-pass cap the loop enforces (default 1 → rounds == passes).
  const perRound = stepDef.loop.passesPerRound ?? 1;
  const formValues = (current.formValues ?? {}) as Record<string, unknown>;
  const formOverride = formValues.maxIterations;
  let rounds: number | null = null;
  if (typeof formOverride === 'number' && formOverride > 0) {
    rounds = formOverride;
  } else if (typeof formOverride === 'string') {
    const parsed = Number.parseInt(formOverride, 10);
    if (Number.isFinite(parsed) && parsed > 0) rounds = parsed;
  }
  if (rounds === null) {
    const task = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, taskId),
      columns: { stepLoopLimits: true },
    });
    const limits = (task?.stepLoopLimits ?? {}) as Record<string, number>;
    const override = limits[stepDef.metadata.id];
    if (typeof override === 'number' && override > 0) rounds = override;
  }
  if (rounds === null) rounds = stepDef.loop.maxIterations;
  return rounds * perRound;
}

/** True when at least one mining agent on this step still has a re-roll left.
 *  Drives isFinalMiningAttempt, so apply() knows whether it may throw or must degrade. */
async function miningAgentsWithBudget(
  db: Database,
  taskStepId: string,
  maxAttempts: number,
): Promise<boolean> {
  const rows = await db
    .select({ attempts: schema.taskStepAgentMinings.attempts })
    .from(schema.taskStepAgentMinings)
    .where(eq(schema.taskStepAgentMinings.taskStepId, taskStepId));
  return rows.some((r) => r.attempts < maxAttempts);
}

/** Re-dispatch the named mining agents that still have budget. Returns how many were
 *  re-enqueued; 0 means every named agent is spent and the caller must not park.
 *
 *  selectAgents is re-run to rebuild each prompt, then filtered to the named agents —
 *  the other agents' `done` rows are never touched, and the fan-out barrier re-parks
 *  the step because at least one row went back to `pending`. */
async function retryMiningAgents(
  db: Database,
  stepDef: StepDefinition,
  current: TaskStepRow,
  ctx: StepContext,
  detected: unknown,
  formValues: FormValues | null,
  llmOutput: unknown,
  params: AdvanceStepParams,
  agentIds: string[],
  maxAttempts: number,
): Promise<number> {
  if (agentIds.length === 0 || !params.providers || !params.deps) return 0;

  const rows = await db
    .select()
    .from(schema.taskStepAgentMinings)
    .where(eq(schema.taskStepAgentMinings.taskStepId, current.id));

  const wanted = new Set(agentIds);
  const targets: MiningRetryTargets = new Map();
  for (const r of rows) {
    if (!wanted.has(r.agentId) || r.attempts >= maxAttempts) continue;
    targets.set(r.agentId, {
      id: r.id,
      attempts: r.attempts,
      cliInvocationId: r.cliInvocationId,
    });
  }
  if (targets.size === 0) {
    ctx.logger.warn(
      { stepId: stepDef.metadata.id, agentIds, maxAttempts },
      'mining retry requested but every named agent is out of budget',
    );
    return 0;
  }

  const dispatches = (
    await stepDef.agentMining!.selectAgents({
      ctx,
      detected,
      formValues: formValues ?? {},
      llmOutput,
    })
  ).filter((d) => targets.has(d.agentId));

  if (dispatches.length === 0) {
    ctx.logger.warn(
      { stepId: stepDef.metadata.id, agentIds },
      'mining retry requested but selectAgents no longer offers those agents',
    );
    return 0;
  }

  ctx.logger.warn(
    {
      stepId: stepDef.metadata.id,
      agentIds: dispatches.map((d) => d.agentId),
      maxAttempts,
    },
    'agent output unusable; re-rolling those agents',
  );
  return dispatchMiningAgents(db, stepDef, current, ctx, params, dispatches, targets);
}

/** Mark the currently-active LLM invocation row as consumed so the next
 *  resolveLlmPhase pass enqueues a fresh one. No-op when the step has no
 *  unconsumed invocation (already-consumed paths or steps without llm). */
async function markLatestInvocationConsumed(db: Database, taskStepId: string): Promise<void> {
  const row = await db
    .select({ id: schema.cliInvocations.id })
    .from(schema.cliInvocations)
    .where(
      and(
        eq(schema.cliInvocations.taskStepId, taskStepId),
        isNull(schema.cliInvocations.supersededAt),
        isNull(schema.cliInvocations.consumedAt),
        ne(schema.cliInvocations.mode, 'agent_mining'),
      ),
    )
    .orderBy(desc(schema.cliInvocations.createdAt))
    .limit(1);
  const invId = row[0]?.id;
  if (!invId) return;
  await db
    .update(schema.cliInvocations)
    .set({ consumedAt: new Date() })
    .where(eq(schema.cliInvocations.id, invId));
}

/** Count the LLM invocations already spent on this step (non-superseded,
 *  non-agent_mining). Drives the llm.retry attempt cap; durable across worker
 *  restarts because every attempt — including consumed prior ones — is its own
 *  cli_invocations row. */
async function countLlmAttempts(db: Database, taskStepId: string): Promise<number> {
  const rows = await db
    .select({ id: schema.cliInvocations.id })
    .from(schema.cliInvocations)
    .where(
      and(
        eq(schema.cliInvocations.taskStepId, taskStepId),
        isNull(schema.cliInvocations.supersededAt),
        ne(schema.cliInvocations.mode, 'agent_mining'),
      ),
    );
  return rows.length;
}

/** Max consecutive output-truncation re-dispatches tolerated for one loop
 *  iteration before the step fails. Each retry shrinks the request, so this also
 *  bounds how small a single chunk is asked to get. */
const MAX_TRUNCATION_RETRIES = 3;

/** Count the most-recent CONSECUTIVE invocations for a step whose error is an
 *  output-truncation. Resets at the first non-truncation row, so for a loop step
 *  this is the truncation count for the CURRENT (pending) iteration — used both to
 *  bound truncation retries and to tell the iteration prompt builder how much to
 *  shrink. A consumed-but-not-superseded truncated row still counts (it is the
 *  attempt we just re-dispatched past). */
async function countTrailingTruncations(db: Database, taskStepId: string): Promise<number> {
  const rows = await db
    .select({ errorMessage: schema.cliInvocations.errorMessage })
    .from(schema.cliInvocations)
    .where(
      and(
        eq(schema.cliInvocations.taskStepId, taskStepId),
        isNull(schema.cliInvocations.supersededAt),
        ne(schema.cliInvocations.mode, 'agent_mining'),
      ),
    )
    .orderBy(desc(schema.cliInvocations.createdAt))
    .limit(10);
  let n = 0;
  for (const r of rows) {
    if (isOutputTruncationMessage(r.errorMessage)) n++;
    else break;
  }
  return n;
}

/** Writes a gate-1 pre-answer value into a leaf field's default so a form
 *  that still stops renders pre-filled. Values that don't fit the field
 *  (wrong type, option no longer offered) are left out rather than forced. */
function overlayLeafDefault(field: LeafFormField, pre: Record<string, unknown>): LeafFormField {
  if (!(field.id in pre)) return field;
  const v = pre[field.id];
  switch (field.type) {
    case 'checkbox':
      return typeof v === 'boolean' ? { ...field, default: v } : field;
    case 'text':
    case 'textarea':
    case 'select-with-text':
    case 'radio-with-textarea':
      return typeof v === 'string' ? { ...field, default: v } : field;
    case 'select':
    case 'radio':
      return typeof v === 'string' && field.options.some((o) => o.value === v)
        ? { ...field, default: v }
        : field;
    case 'multi-select': {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return field;
      const allowed = new Set(field.options.map((o) => o.value));
      return { ...field, defaults: (v as string[]).filter((x) => allowed.has(x)) };
    }
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? { ...field, default: v } : field;
    default:
      return field;
  }
}

function overlayPreAnswerDefaults(schema: FormSchema, pre: Record<string, unknown>): FormSchema {
  return {
    ...schema,
    fields: schema.fields.map(
      (field): FormField =>
        field.type === 'accordion'
          ? {
              ...field,
              items: field.items.map((item) => ({
                ...item,
                fields: item.fields.map((leaf) => overlayLeafDefault(leaf, pre)),
              })),
            }
          : overlayLeafDefault(field, pre),
    ),
  };
}

/** Confirm-only schema for manual mode (task.autoContinue=false): formless
 *  steps pause on this so the user can review the run before apply. Submitting
 *  posts {} which validates against zero fields. */
function synthesizeConfirmSchema(title: string, description: string): FormSchema {
  return {
    title,
    description,
    fields: [],
    submitLabel: 'Continue',
  };
}
