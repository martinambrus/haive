import type { FormSchema, FormField } from '../schemas/form.js';
import type { StepStatus } from '../types/index.js';

export type StepCapability = 'subagents' | 'tool_use' | 'file_write';

export interface DetectResult {
  summary?: string;
  data: Record<string, unknown>;
  warnings?: string[];
}

export type FormValues = Record<string, unknown>;

export interface StepMetadata {
  id: string;
  /** User-facing WorkflowType or internal registry key (e.g. 'env_replicate'). */
  workflowType: string;
  index: number;
  title: string;
  description: string;
  requiresCli: boolean;
  requiredCapabilities?: StepCapability[];
  /** True when `detect()` resolves CLI-specific paths or metadata from the
   *  CliProviderMetadata catalog. Switching `task.cliProviderId` invalidates
   *  cached `detectOutput` on these steps so the next advance re-detects.
   *  Must match the id listed in PROVIDER_SENSITIVE_STEP_IDS — the API package
   *  reads that constant to know which task_steps rows to invalidate on
   *  provider change (it does not have access to the worker step registry). */
  providerSensitive?: boolean;
}

/** Step IDs whose StepDefinition sets `metadata.providerSensitive = true`.
 *  Duplicated here because the api package needs this list to invalidate
 *  cached detectOutput on `PATCH /tasks/:id/cli-provider`, and the worker's
 *  step registry is not importable from api without a circular dep.
 *
 *  Keep in sync with the `providerSensitive: true` flags on StepDefinition
 *  metadata blocks. A worker startup assertion verifies the match. */
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
