import { join } from 'node:path';
import { cliAuthVolumeName, getCliProviderMetadata } from '@haive/shared';
import type { CliProviderName } from '@haive/shared';
import type { DockerVolumeMount } from './docker-runner.js';
import { SANDBOX_USER_HOME } from './sandbox-runner.js';

export interface ResolveCliAuthMountsOptions {
  writable?: boolean;
}

export function resolveCliAuthMounts(
  userId: string,
  providerName: CliProviderName,
  opts: ResolveCliAuthMountsOptions = {},
): DockerVolumeMount[] {
  const meta = getCliProviderMetadata(providerName);
  const readOnly = !(opts.writable ?? false);
  return meta.authConfigPaths.map((raw, idx) => ({
    source: cliAuthVolumeName(userId, providerName, idx),
    target: expandTildeToSandbox(raw),
    readOnly,
  }));
}

export function expandTildeToSandbox(p: string): string {
  if (p === '~') return SANDBOX_USER_HOME;
  if (p.startsWith('~/')) return join(SANDBOX_USER_HOME, p.slice(2));
  return p;
}
