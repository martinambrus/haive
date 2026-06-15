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
export const SKIPPABLE_STEP_IDS: readonly string[] = ['06a-db-migrate'];

export const PROVIDER_SENSITIVE_STEP_IDS: readonly string[] = [
  '04-tooling-infrastructure',
  '07_5-verify-files',
  '09_5-skill-generation',
  '09_6-skill-verification',
  '11-final-review',
  '01b-install-plugins',
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
