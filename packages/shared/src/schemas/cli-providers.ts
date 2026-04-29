import { z } from 'zod';

export const cliProviderNameSchema = z.enum(['claude-code', 'codex', 'gemini', 'amp', 'zai']);

export const cliAuthModeSchema = z.enum(['subscription', 'api_key']);
export const cliSandboxBuildStatusSchema = z.enum(['idle', 'building', 'ready', 'failed']);

export const cliNetworkModeSchema = z.enum(['none', 'full', 'allowlist']);
export type CliNetworkMode = z.infer<typeof cliNetworkModeSchema>;

const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isValidDomainPattern(input: string): boolean {
  const d = input.trim().toLowerCase();
  if (!d || d.length > 253) return false;
  const hasPrefixWildcard = d.startsWith('*.');
  const hasSuffixWildcard = d.endsWith('.*');
  const hasLeadingDot = !hasPrefixWildcard && d.startsWith('.');
  if (hasPrefixWildcard && hasSuffixWildcard) return false;
  let core = d;
  if (hasPrefixWildcard) core = core.slice(2);
  else if (hasLeadingDot) core = core.slice(1);
  if (hasSuffixWildcard) core = core.slice(0, -2);
  if (!core || core.includes('*')) return false;
  return core.split('.').every((label) => DOMAIN_LABEL.test(label));
}

const IPV4_OCTET = /^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;
const IPV6 = /^[0-9a-fA-F:]+$/;

export function isValidIpOrCidr(input: string): boolean {
  const raw = input.trim();
  if (!raw) return false;
  const [addr, cidr] = raw.includes('/') ? raw.split('/', 2) : [raw, null];
  if (!addr) return false;
  const isV6 = addr.includes(':');
  if (cidr !== null) {
    if (!/^\d+$/.test(cidr)) return false;
    const n = Number(cidr);
    const max = isV6 ? 128 : 32;
    if (n < 0 || n > max) return false;
  }
  if (isV6) return IPV6.test(addr) && addr.split(':').length <= 8;
  const parts = addr.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => IPV4_OCTET.test(p));
}

const domainPatternSchema = z.string().refine(isValidDomainPattern, {
  message:
    'Invalid domain pattern. Accepted: `example.com`, `*.example.com`, `.example.com`, `example.*`.',
});

const ipOrCidrSchema = z.string().refine(isValidIpOrCidr, {
  message: 'Invalid IP address or CIDR (IPv4 or IPv6).',
});

export const cliNetworkPolicySchema = z.object({
  mode: cliNetworkModeSchema,
  domains: z.array(domainPatternSchema).default([]),
  ips: z.array(ipOrCidrSchema).default([]),
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
  effortLevel: z.string().nullable().optional(),
  sandboxDockerfileExtra: z.string().optional(),
  enabled: z.boolean().optional(),
  networkPolicy: cliNetworkPolicySchema.optional(),
  rulesContent: z.string().optional(),
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
