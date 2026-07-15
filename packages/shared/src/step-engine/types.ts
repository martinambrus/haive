import type { FormSchema, FormField } from '../schemas/form.js';
import type { StepStatus } from '../types/index.js';

export type StepCapability = 'subagents' | 'tool_use' | 'file_write';

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

/** Step ids whose StepDefinition dispatches a CLI — i.e. defines `llm`,
 *  `agentMining`, or `dagExecute` (the exact predicate the worker step runner
 *  uses to decide an invocation happens). Only these steps ever consume a
 *  per-step CLI provider, so the web renders the per-step CLI picker ONLY for
 *  them; deterministic steps hide it (their per-step preference is never read —
 *  provider-sensitive deterministic steps key off the task-level provider).
 *
 *  Duplicated here (like PROVIDER_SENSITIVE_STEP_IDS) because the api/web
 *  packages cannot import the worker step registry. A worker startup assertion
 *  (assertCliDispatchListInSync) verifies this matches the registry, so the
 *  worker refuses to boot on drift. Do NOT key off StepMetadata.requiresCli —
 *  that flag is unreliable (hand-set, unasserted) and read nowhere in prod. */
export const CLI_DISPATCH_STEP_IDS: readonly string[] = [
  // canary model-health steps (one per pipeline)
  '00-model-health-onboarding',
  '00-model-health-workflow',
  // onboarding
  '01-env-detect',
  '06_5-agent-discovery',
  '08-knowledge-acquisition',
  '09-qa',
  '09_1-qa-suggestions',
  '09_2-qa-resolve',
  '09_3-qa-review',
  '09_5-skill-generation',
  '09_5b-skill-repair',
  '09_6_4-global-kb-merge',
  '11-final-review',
  // workflow
  '00-triage',
  '00b-estimate',
  '01a-app-boot',
  '03-phase-0a-discovery',
  '03b-business-requirements',
  '03b2-humanize-requirements',
  '04-phase-0b-pre-planning',
  '04a-spec-audit',
  '05-phase-0b5-spec-quality',
  '05a-resolve-spec-warnings',
  '06-run-config',
  '06b-sprint-planning',
  '06c-dag-execute',
  '07-phase-2-implement',
  '07a-code-simplify',
  '07b-phase-4-validate',
  '08a-browser-verify',
  '08b-test-management',
  '08c-code-review',
  '08c2-code-audit',
  '08d-adversarial-qa',
  '08e-insights-triage',
  '11-phase-8-learning',
  '11d-skill-sync',
  // kb-author
  '01-kb-enrich',
];

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
