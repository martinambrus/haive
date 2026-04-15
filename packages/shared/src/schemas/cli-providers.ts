import { z } from 'zod';

export const cliProviderNameSchema = z.enum([
  'claude-code',
  'codex',
  'gemini',
  'amp',
  'grok',
  'qwen',
  'kiro',
  'zai',
]);

export const cliAuthModeSchema = z.enum(['subscription', 'api_key', 'mixed']);

export const createCliProviderRequestSchema = z.object({
  name: cliProviderNameSchema,
  label: z.string().min(1).max(255),
  executablePath: z.string().optional(),
  wrapperPath: z.string().optional(),
  wrapperContent: z.string().optional(),
  envVars: z.record(z.string(), z.string()).optional(),
  cliArgs: z.array(z.string()).optional(),
  authMode: cliAuthModeSchema,
  enabled: z.boolean().optional(),
});

export const updateCliProviderRequestSchema = createCliProviderRequestSchema.partial();

export type CreateCliProviderRequest = z.infer<typeof createCliProviderRequestSchema>;
export type UpdateCliProviderRequest = z.infer<typeof updateCliProviderRequestSchema>;

export const setCliProviderSecretRequestSchema = z.object({
  secretName: z.string().min(1).max(255),
  value: z.string().min(1),
});

export type SetCliProviderSecretRequest = z.infer<typeof setCliProviderSecretRequestSchema>;
