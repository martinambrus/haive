import { join } from 'node:path';
import { getCliProviderMetadata, resolveCliAuthUserVolumeName } from '@haive/shared';
import type { AuthMode, CliProviderName } from '@haive/shared';
import type { DockerVolumeMount } from './docker-runner.js';
import { SANDBOX_USER_HOME } from './sandbox-runner.js';

export interface ResolveCliAuthMountsOptions {
  writable?: boolean;
}

export interface CliAuthMountContext {
  userId: string;
  providerId: string;
  providerName: CliProviderName;
  authMode: AuthMode;
  isolateAuth: boolean;
}

export function resolveCliAuthMounts(
  ctx: CliAuthMountContext,
  opts: ResolveCliAuthMountsOptions = {},
): DockerVolumeMount[] {
  const meta = getCliProviderMetadata(ctx.providerName);
  const readOnly = !(opts.writable ?? false);
  return meta.authConfigPaths.map((raw, idx) => ({
    source: resolveCliAuthUserVolumeName(ctx, idx),
    target: expandTildeToSandbox(raw),
    readOnly,
    kind: 'auth' as const,
  }));
}

export function expandTildeToSandbox(p: string): string {
  if (p === '~') return SANDBOX_USER_HOME;
  if (p.startsWith('~/')) return join(SANDBOX_USER_HOME, p.slice(2));
  return p;
}
