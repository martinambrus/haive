import { z } from 'zod';

export const TASK_INTEGRATION_CHOICES_MAX = 64;
export const taskIntegrationChoiceSchema = z
  .object({
    // Live category registration is checked by admission; keep request schemas independent of
    // modularity/contracts, which itself reads the task schemas.
    categoryId: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[a-z0-9][a-z0-9_.-]*$/),
    connectionId: z.string().uuid(),
  })
  .strict();
export const taskIntegrationChoicesSchema = z
  .array(taskIntegrationChoiceSchema)
  .max(TASK_INTEGRATION_CHOICES_MAX)
  .refine(
    (choices) => new Set(choices.map((choice) => choice.categoryId)).size === choices.length,
    'Choose one account per category',
  );
export type TaskIntegrationChoice = z.infer<typeof taskIntegrationChoiceSchema>;

/** JSON choices are carried in a bounded GET query, using the same shape as create. */
export const taskIntegrationPreviewQuerySchema = z
  .object({
    type: z.string().min(1).max(128),
    repositoryId: z.string().uuid().optional(),
    choices: z.string().max(24_000).optional(),
  })
  .strict();

export interface TaskIntegrationAccount {
  connectionId: string;
  providerId: string;
  providerLabel: string;
  accountLabel: string | null;
  status: 'connected' | 'needs_reauth' | 'revoked' | 'provider_unavailable';
}
export interface TaskIntegrationCategoryPreview {
  categoryId: string;
  label: string;
  required: boolean;
  steps: {
    stepId: string;
    title: string;
    requirementId: string;
    access: 'read' | 'write';
    optional: boolean;
  }[];
  status: 'resolved' | 'unresolved';
  /** Resolver reasons remain open so newer provider/module states retain their names. */
  reason: string | null;
  selected: TaskIntegrationAccount | null;
  candidates: TaskIntegrationAccount[];
}
export interface TaskIntegrationPreview {
  admitted: boolean;
  scope: 'static' | 'dispatch-time';
  categories: TaskIntegrationCategoryPreview[];
  issues: {
    stepId: string;
    reason: 'integration-provider-pinned' | 'integration-requirement-invalid';
  }[];
}
