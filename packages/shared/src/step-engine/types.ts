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
}

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
