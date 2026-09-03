import type { FormSchema, FormField } from '../schemas/form.js';
import type { StepStatus } from '../types/index.js';

/** What a dispatch needs from whichever CLI serves it.
 *
 *  `vision` is a HARD requirement, not a preference: a provider whose model is
 *  known to reject image input (`modelLimits.vision === false`, learned from a
 *  live 400) is excluded rather than handed the work. The alternative is the
 *  status quo for a task carrying a wireframe — the no-vision prompt boundary
 *  tells the agent not to open images, so it silently plans around one and
 *  reports success. Declare it only where an image is genuinely load-bearing;
 *  a task that merely COULD have one must not lock every blind model out. */
export type StepCapability = 'subagents' | 'tool_use' | 'file_write' | 'vision';

export interface DetectResult {
  summary?: string;
  data: Record<string, unknown>;
  warnings?: string[];
}

export type FormValues = Record<string, unknown>;

/** A named CLI role within a step (e.g. spec-quality's reviewer/corrector). When
 *  a step declares roles, the UI renders one provider dropdown per role and the
 *  loop resolves a provider per role/iteration instead of one per step. */
export interface CliRoleDescriptor {
  id: string;
  label: string;
}

export interface StepMetadata {
  id: string;
  /** User-facing WorkflowType or internal registry key (e.g. 'env_replicate'). */
  workflowType: string;
  index: number;
  title: string;
  description: string;
  requiresCli: boolean;
  requiredCapabilities?: StepCapability[];
  /** When set, this step uses multiple CLIs by role (one provider per role).
   *  Mirror the entry in STEP_CLI_ROLES below so api/web can render the
   *  per-role dropdowns without importing the worker step registry. */
  cliRoles?: readonly CliRoleDescriptor[];
  /** True when `detect()` resolves CLI-specific paths or metadata from the
   *  CliProviderMetadata catalog. Switching `task.cliProviderId` invalidates
   *  cached `detectOutput` on these steps so the next advance re-detects.
   *  Must match the id listed in PROVIDER_SENSITIVE_STEP_IDS — the API package
   *  reads that constant to know which task_steps rows to invalidate on
   *  provider change (it does not have access to the worker step registry). */
  providerSensitive?: boolean;
  /** When true, the user-facing Skip step action is permitted for this step.
   *  Skip is otherwise disabled across the workflow; only steps that opt in
   *  (currently 06a-db-migrate) may be skipped. The API skip handler enforces this. */
  allowSkip?: boolean;
  /** When true, a local in-stack Ollama model is BLOCKED from running this step
   *  by default — these steps rewrite long-lived project files (skills, working
   *  code) where a weak local model is dangerous. Override per deployment with
   *  the ALLOW_LOCAL_MODEL_DESTRUCTIVE_STEPS config flag. Cloud/remote Ollama
   *  and every non-Ollama provider are unaffected. */
  unsafeForLocalModels?: boolean;
  /** When true, and the task is in auto-continue mode with no gate pre-answer
   *  for this step, the runner auto-submits the form using each field's declared
   *  default instead of parking on waiting_form. Off by default: only steps whose
   *  defaults are the correct unattended choice opt in (currently 03-build-image,
   *  where the default reuses an existing image or builds with the auto-generated
   *  tag). If any required field lacks a default the candidate fails validation
   *  and the step still falls back to waiting_form. Read only by the worker step
   *  runner, so no shared-constant mirror is needed. */
  autoSubmitDefaults?: boolean;
  /** When true, and the task is in auto-continue mode, the runner reuses the most
   *  recent SUCCESSFULLY COMPLETED same-repository, same-workflow-type task's
   *  submitted `formValues` for this step id and auto-submits them instead of
   *  parking on waiting_form. For steps whose answers are stable per project
   *  (currently 01-declare-deps and 02-generate-dockerfile). Gated strictly on
   *  auto-continue: with auto-continue off the form always parks, so manual mode is
   *  unchanged. Distinct from autoSubmitDefaults, which submits the schema's own
   *  field defaults even on the first task; this reuses a prior task's actual
   *  answers and only fires once such a task exists. Falls back to waiting_form
   *  when no prior completed task exists or the reused values fail validation
   *  against the current schema. Read only by the worker step runner, so no
   *  shared-constant mirror is needed. */
  reuseLastCompletedFormValues?: boolean;
}

/** Step IDs whose StepDefinition sets `metadata.providerSensitive = true`.
 *  Duplicated here because the api package needs this list to invalidate
 *  cached detectOutput on `PATCH /tasks/:id/cli-provider`, and the worker's
 *  step registry is not importable from api without a circular dep.
 *
 *  Keep in sync with the `providerSensitive: true` flags on StepDefinition
 *  metadata blocks. A worker startup assertion verifies the match. */
/** Per-step CLI roles, keyed by step id. Duplicated here (like
 *  PROVIDER_SENSITIVE_STEP_IDS) because the api/web packages need it to render
 *  per-role provider dropdowns and the worker step registry is not importable
 *  from them. Keep in sync with each StepDefinition's `metadata.cliRoles`. */
export const STEP_CLI_ROLES: Record<string, readonly CliRoleDescriptor[]> = {
  '05-phase-0b5-spec-quality': [
    { id: 'reviewer', label: 'Reviewer' },
    { id: 'corrector', label: 'Corrector' },
  ],
  '07a-code-simplify': [
    { id: 'simplifier', label: 'Simplifier' },
    { id: 'fixup', label: 'Fixup verifier' },
  ],
  '07b-phase-4-validate': [
    { id: 'validator', label: 'Validator' },
    { id: 'fixer', label: 'Fixer' },
  ],
  '08a-browser-verify': [
    { id: 'tester', label: 'Tester' },
    { id: 'fixer', label: 'Fixer' },
  ],
};

/** Per-step MINING SEATS: the individually addressable agents inside a fan-out step,
 *  keyed by step id. A seat's id is the `roleKey` its dispatch carries, and per-seat
 *  provider choices are stored in the SAME `user_step_cli_role_preferences` table the
 *  loop roles above use — the table is keyed (user, step, role) and does not care which
 *  kind of seat a role names.
 *
 *  DELIBERATELY SEPARATE FROM STEP_CLI_ROLES, not an extension of it. That map's
 *  PRESENCE is the api/web marker for a multi-pass LOOP step and its LENGTH is
 *  `loopPassesPerRound` (api `_helpers.ts` / `_step-label.ts`, web `iterationBadgeLabel`
 *  and `isResumableStep`). Listing 08c's eight seats there would make a parallel fan-out
 *  report eight sequential passes per round and render loop badges and Resume semantics
 *  that do not apply to it. Every loop-semantics read must keep reading STEP_CLI_ROLES.
 *
 *  A seat left unset resolves through `resolvePreferredCli`'s existing fall-through to
 *  the step's `default` pref and then the task provider, so an unconfigured fan-out
 *  behaves exactly as it did before per-seat selection existed.
 *
 *  Rosters are CUMULATIVE BY QA LEVEL, so not every seat listed here runs on every task:
 *  08c's lens reviewers arrive at `standard` (operational) and `enterprise` (all three),
 *  and 08d's roster is 2 at `poc`, 4 at `standard`, 6 at `enterprise`. The registry lists
 *  every seat that can exist; a seat the level never dispatches simply goes unused.
 *
 *  Keep in sync with `REVIEW_LENSES` / `REFUTE_LENSES` in 08c-code-review.ts and
 *  `ADVERSARIES` in 08d-adversarial-qa.ts. */
export const STEP_MINING_SEATS: Record<string, readonly CliRoleDescriptor[]> = {
  '08c-code-review': [
    { id: 'peer-reviewer', label: 'Peer Reviewer' },
    { id: 'security-code-reviewer', label: 'Security Code Reviewer' },
    { id: 'operational-reviewer', label: 'Operational Reviewer' },
    { id: 'performance-reviewer', label: 'Performance Reviewer' },
    { id: 'simplicity-reviewer', label: 'Simplicity Reviewer' },
    // The refuter wave dispatches one agent per finding per lens, so the finding-derived
    // agent id is unbounded and the LENS is the stable seat. Namespaced so a lens id can
    // never collide with a reviewer id above.
    { id: 'refuter:reach', label: 'Refuter: reachability' },
    { id: 'refuter:impact', label: 'Refuter: impact' },
    { id: 'refuter:defense', label: 'Refuter: defenses' },
  ],
  '08d-adversarial-qa': [
    { id: 'edge-case-breaker', label: 'Edge Case Breaker' },
    { id: 'workflow-disruptor', label: 'Workflow Disruptor' },
    { id: 'auth-bandit', label: 'Auth Bandit' },
    { id: 'injection-infector', label: 'Injection Infector' },
    { id: 'logic-lunatic', label: 'Logic Lunatic' },
    { id: 'chaos-creator', label: 'Chaos Creator' },
    // The PoC-verification wave. Same shape as 08c's refuter lenses: the agent id is
    // per-FINDING and unbounded, so the LENS is the stable seat, namespaced so it can
    // never collide with an adversary id above.
    { id: 'qa-verify:execute', label: 'PoC verifier: executes' },
    { id: 'qa-verify:target', label: 'PoC verifier: target real' },
    { id: 'qa-verify:linkage', label: 'PoC verifier: code linkage' },
  ],
};

/** Step ids whose StepDefinition sets `metadata.allowSkip = true`. The user
 *  Skip action is permitted ONLY on these; the API skip handler enforces it
 *  (the api can't import the worker step registry). Keep in sync with the
 *  `allowSkip: true` flags on StepDefinition metadata. */
export const SKIPPABLE_STEP_IDS: readonly string[] = [
  '03b-business-requirements',
  '06a-db-migrate',
  '11a-gate-4-push',
  '11b-kb-commit',
  '11c-rag-reindex',
  '11d-skill-sync',
];

export const PROVIDER_SENSITIVE_STEP_IDS: readonly string[] = [
  '04-tooling-infrastructure',
  '07-generate-files',
  '07_5-verify-files',
  '09_5-skill-generation',
  '09_5b-skill-repair',
  '09_6-skill-verification',
  '11-final-review',
  '01b-install-plugins',
  '01-declare-deps',
  '11d-skill-sync',
];

/** The model-health canary step ids (one per pipeline). The canary validates the
 *  task's chosen model, so a CLI change here is a task-level decision, not a
 *  per-step one: the api rewrites tasks.cli_provider_id to the new provider so
 *  every later step inherits it (worker re-reads it each advance). Duplicated
 *  here because the api cannot import the worker step registry. */
export const MODEL_HEALTH_STEP_IDS: readonly string[] = [
  '00-model-health-onboarding',
  '00-model-health-workflow',
];

/** Every step whose StepDefinition dispatches a CLI — i.e. defines `llm`,
 *  `agentMining`, or `dagExecute` (the exact predicate the worker step runner
 *  uses to decide an invocation happens). Only these steps ever consume a
 *  per-step CLI provider, so the web renders the per-step CLI picker ONLY for
 *  them; deterministic steps hide it (their per-step preference is never read —
 *  provider-sensitive deterministic steps key off the task-level provider).
 *
 *  Carries `workflowType` + `title` alongside the id so the api can name and group
 *  steps that have NO `task_steps` row yet — the upcoming-CLI panel's whole point,
 *  since a row is created lazily (when the step runs or parks) and until then there
 *  is nothing to read a title from.
 *
 *  Duplicated here (like PROVIDER_SENSITIVE_STEP_IDS) because the api/web
 *  packages cannot import the worker step registry. A worker startup assertion
 *  (assertCliDispatchListInSync) verifies EVERY field against the registry, so the
 *  worker refuses to boot on drift — a retitled step fails boot rather than
 *  mislabelling a dropdown. Do NOT key off StepMetadata.requiresCli — that flag is
 *  unreliable (hand-set, unasserted) and read nowhere in prod. */
export interface CliDispatchStep {
  id: string;
  /** StepMetadata.workflowType — the pipeline this step belongs to. */
  workflowType: string;
  /** StepMetadata.title, verbatim. */
  title: string;
}

export const CLI_DISPATCH_STEPS: readonly CliDispatchStep[] = [
  // canary model-health steps (one per pipeline)
  { id: '00-model-health-onboarding', workflowType: 'onboarding', title: 'Model health check' },
  { id: '00-model-health-workflow', workflowType: 'workflow', title: 'Model health check' },
  // onboarding
  { id: '01-env-detect', workflowType: 'onboarding', title: 'Environment detection' },
  { id: '06_5-agent-discovery', workflowType: 'onboarding', title: 'Agent discovery' },
  { id: '07_7-secret-sweep', workflowType: 'onboarding', title: 'Committed secret sweep' },
  {
    id: '08-knowledge-acquisition',
    workflowType: 'onboarding',
    title: 'Knowledge base acquisition',
  },
  {
    id: '09-qa',
    workflowType: 'onboarding',
    title: 'Knowledge base Q&A — agent question generation',
  },
  {
    id: '09_1-qa-suggestions',
    workflowType: 'onboarding',
    title: 'Knowledge base Q&A — suggested answers',
  },
  {
    id: '09_2-qa-resolve',
    workflowType: 'onboarding',
    title: 'Knowledge base Q&A — find answers',
  },
  {
    id: '09_3-qa-review',
    workflowType: 'onboarding',
    title: 'Knowledge base Q&A — review answers',
  },
  { id: '09_5-skill-generation', workflowType: 'onboarding', title: 'Skill generation' },
  { id: '09_5b-skill-repair', workflowType: 'onboarding', title: 'Skill repair' },
  { id: '09_6_4-global-kb-merge', workflowType: 'onboarding', title: 'Global KB merge' },
  { id: '10_8-plan-build', workflowType: 'onboarding', title: 'Project plan' },
  { id: '11-final-review', workflowType: 'onboarding', title: 'Final review' },
  // workflow
  { id: '00-triage', workflowType: 'workflow', title: 'Choose execution path' },
  { id: '00b-estimate', workflowType: 'workflow', title: 'Estimate effort' },
  { id: '01a-app-boot', workflowType: 'workflow', title: 'App boot' },
  {
    id: '03-phase-0a-discovery',
    workflowType: 'workflow',
    title: 'Phase 0a: Knowledge discovery',
  },
  {
    id: '03b-business-requirements',
    workflowType: 'workflow',
    title: 'Phase 1: Business requirements',
  },
  {
    id: '03b2-humanize-requirements',
    workflowType: 'workflow',
    title: 'Phase 1: Humanize requirements',
  },
  { id: '04-phase-0b-pre-planning', workflowType: 'workflow', title: 'Phase 0b: Pre-planning' },
  { id: '04a-spec-audit', workflowType: 'workflow', title: 'Spec audit (broad)' },
  {
    id: '05-phase-0b5-spec-quality',
    workflowType: 'workflow',
    title: 'Phase 0b.5: Spec quality review',
  },
  { id: '05a-resolve-spec-warnings', workflowType: 'workflow', title: 'Resolve spec warnings' },
  { id: '06-run-config', workflowType: 'workflow', title: 'Run configuration' },
  { id: '06b-sprint-planning', workflowType: 'workflow', title: 'Phase 2c: Sprint planning' },
  { id: '06c-dag-execute', workflowType: 'workflow', title: 'Phase 3: DAG implementation' },
  { id: '07-phase-2-implement', workflowType: 'workflow', title: 'Phase 2: Implement' },
  { id: '07a-code-simplify', workflowType: 'workflow', title: 'Phase 3.5: Code simplification' },
  {
    id: '07b-phase-4-validate',
    workflowType: 'workflow',
    title: 'Phase 4: Implementation validation',
  },
  { id: '08a-browser-verify', workflowType: 'workflow', title: 'Phase 5a: Browser validation' },
  { id: '08b-test-management', workflowType: 'workflow', title: 'Phase 5b: Test management' },
  { id: '08c-code-review', workflowType: 'workflow', title: 'Phase 6: Code review' },
  { id: '08c2-code-audit', workflowType: 'workflow', title: 'Code audit (broad)' },
  { id: '08d-adversarial-qa', workflowType: 'workflow', title: 'Phase 7: Adversarial QA' },
  { id: '08e-insights-triage', workflowType: 'workflow', title: 'Insight triage' },
  { id: '11-phase-8-learning', workflowType: 'workflow', title: 'Phase 8: Learning capture' },
  { id: '11d-skill-sync', workflowType: 'workflow', title: 'Skill sync' },
  // kb-author
  { id: '01-kb-enrich', workflowType: 'kb_author', title: 'Knowledge base enrichment' },
  // plan canvas — 02-advisory-decision is deliberately absent: it runs no CLI,
  // because closing a non-code blocker is the user's call, not an agent's.
  { id: '01-plan-build', workflowType: 'plan_build', title: 'Build the plan' },
  // Dispatches only what a person ticked at its gate — a clean build spends
  // nothing here — but it CAN dispatch, which is what this list records.
  { id: '02-plan-coverage', workflowType: 'plan_build', title: 'Coverage check' },
  { id: '01-plan-chat', workflowType: 'plan_chat', title: 'Plan conversation' },
  { id: '01-advisory-research', workflowType: 'advisory', title: 'Research' },
];

/** Ids only — the shape every pre-existing consumer reads. Derived so the two can
 *  never disagree. */
export const CLI_DISPATCH_STEP_IDS: readonly string[] = CLI_DISPATCH_STEPS.map((s) => s.id);

export interface StepRunRecord {
  id: string;
  taskId: string;
  stepId: string;
  stepIndex: number;
  title: string;
  status: StepStatus;
  detectOutput: unknown;
  formSchema: FormSchema | null;
  formValues: FormValues | null;
  output: unknown;
  errorMessage: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

export type FormFieldByType<T extends FormField['type']> = Extract<FormField, { type: T }>;
