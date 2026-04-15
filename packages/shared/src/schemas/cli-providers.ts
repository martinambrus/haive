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
export const cliSandboxBuildStatusSchema = z.enum(['idle', 'building', 'ready', 'failed']);

export const cliNetworkModeSchema = z.enum(['none', 'full', 'allowlist']);
export type CliNetworkMode = z.infer<typeof cliNetworkModeSchema>;

export const cliNetworkPolicySchema = z.object({
  mode: cliNetworkModeSchema,
  domains: z.array(z.string()).default([]),
  ips: z.array(z.string()).default([]),
});
export type CliNetworkPolicy = z.infer<typeof cliNetworkPolicySchema>;

export const DEFAULT_CLI_NETWORK_POLICY: CliNetworkPolicy = {
  mode: 'full',
  domains: [],
  ips: [],
};

export const createCliProviderRequestSchema = z.object({
  name: cliProviderNameSchema,
  label: z.string().min(1).max(255),
  executablePath: z.string().optional(),
  wrapperPath: z.string().optional(),
  wrapperContent: z.string().optional(),
  envVars: z.record(z.string(), z.string()).optional(),
  cliArgs: z.array(z.string()).optional(),
  authMode: cliAuthModeSchema,
  cliVersion: z.string().nullable().optional(),
  sandboxDockerfileExtra: z.string().optional(),
  enabled: z.boolean().optional(),
  networkPolicy: cliNetworkPolicySchema.optional(),
});

export const updateCliProviderRequestSchema = createCliProviderRequestSchema.partial();

export type CreateCliProviderRequest = z.infer<typeof createCliProviderRequestSchema>;
export type UpdateCliProviderRequest = z.infer<typeof updateCliProviderRequestSchema>;
export type CliSandboxBuildStatus = z.infer<typeof cliSandboxBuildStatusSchema>;

export const cliPackageVersionsEntrySchema = z.object({
  name: cliProviderNameSchema,
  versions: z.array(z.string()),
  latestVersion: z.string().nullable(),
  fetchedAt: z.string().nullable(),
  fetchError: z.string().nullable(),
});

export type CliPackageVersionsEntry = z.infer<typeof cliPackageVersionsEntrySchema>;

export const setCliProviderSecretRequestSchema = z.object({
  secretName: z.string().min(1).max(255),
  value: z.string().min(1),
});

export type SetCliProviderSecretRequest = z.infer<typeof setCliProviderSecretRequestSchema>;
