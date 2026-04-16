import { z } from 'zod';

export const workflowTypeSchema = z.enum(['onboarding', 'workflow']);

export const taskStatusSchema = z.enum([
  'created',
  'queued',
  'running',
  'paused',
  'waiting_user',
  'completed',
  'failed',
  'cancelled',
]);

export const stepStatusSchema = z.enum([
  'pending',
  'running',
  'waiting_form',
  'waiting_cli',
  'done',
  'failed',
  'skipped',
]);

export const resourceLimitsSchema = z
  .object({
    memoryLimitMb: z.number().int().min(128).max(65536).optional(),
    cpuLimitMilli: z.number().int().min(100).max(16000).optional(),
  })
  .optional();

export type ResourceLimits = z.infer<typeof resourceLimitsSchema>;

export const createTaskRequestSchema = z.object({
  type: workflowTypeSchema,
  title: z.string().min(1).max(512),
  description: z.string().optional(),
  repositoryId: z.string().uuid().optional(),
  cliProviderId: z.string().uuid().optional(),
  envTemplateId: z.string().uuid().optional(),
  resourceLimits: resourceLimitsSchema,
});

export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;

export const submitStepRequestSchema = z.object({
  values: z.record(z.string(), z.unknown()),
});

export type SubmitStepRequest = z.infer<typeof submitStepRequestSchema>;

export const taskActionSchema = z.enum(['pause', 'resume', 'cancel', 'retry']);

export const taskActionRequestSchema = z.object({
  action: taskActionSchema,
});

export type TaskAction = z.infer<typeof taskActionSchema>;

export const stepActionSchema = z.enum(['retry', 'skip']);

export const stepActionRequestSchema = z.object({
  action: stepActionSchema,
  note: z.string().max(2000).optional(),
});

export type StepAction = z.infer<typeof stepActionSchema>;

export const setCliProviderRequestSchema = z.object({
  cliProviderId: z.string().uuid().nullable(),
});

export type SetCliProviderRequest = z.infer<typeof setCliProviderRequestSchema>;

export const overrideNextStepRequestSchema = z.object({
  stepId: z.string().min(1).max(128),
});

export type OverrideNextStepRequest = z.infer<typeof overrideNextStepRequestSchema>;
