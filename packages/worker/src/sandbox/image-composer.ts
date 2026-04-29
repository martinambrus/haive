import { createHash } from 'node:crypto';
import type { CliProviderName } from '@haive/shared';
import { buildProviderInstallLines } from '../cli-versions/codegen.js';

export const SANDBOX_CORE_IMAGE = 'haive-cli-sandbox:latest';

export interface SandboxImageComposition {
  tag: string;
  hash: string;
  dockerfileBody: string;
  hasEnvTemplate: boolean;
  hasCliInstall: boolean;
  hasExtras: boolean;
}

export interface ComposeInput {
  envTemplateDockerfile: string | null;
  provider: {
    name: CliProviderName;
    cliVersion: string | null;
    sandboxDockerfileExtra: string | null;
  };
  /**
   * Current image ID (sha256:...) of the SANDBOX_CORE_IMAGE base. When a
   * dockerfile body references the base by tag (`haive-cli-sandbox:latest`),
   * the tag itself is mutable — rebuilding the base produces a new image but
   * keeps the same tag, so a hash over the dockerfile body alone fails to
   * invalidate composed image tags. Mixing the base ID into the hash forces
   * a fresh tag on base rebuild. Caller passes `null` (or omits) when the
   * base image isn't yet built or the env-template doesn't reference it.
   */
  baseImageId?: string | null;
}

export function composeSandboxImage(input: ComposeInput): SandboxImageComposition {
  const extra = (input.provider.sandboxDockerfileExtra ?? '').trim();
  const codegen = buildProviderInstallLines(input.provider.name, input.provider.cliVersion);
  const installLines = codegen.supported ? codegen.lines : [];

  const base = resolveBase(input.envTemplateDockerfile);
  const parts: string[] = [base];
  if (installLines.length > 0) parts.push(installLines.join('\n'));
  if (extra.length > 0) parts.push(extra);

  const dockerfileBody = `${parts.join('\n\n')}\n`;

  const referencesSandboxBase =
    input.envTemplateDockerfile === null || dockerfileBody.includes(SANDBOX_CORE_IMAGE);
  const baseIdForHash = referencesSandboxBase && input.baseImageId ? input.baseImageId : '';
  const hashInput =
    baseIdForHash.length > 0 ? `${baseIdForHash}\n${dockerfileBody}` : dockerfileBody;
  const hash = createHash('sha256').update(hashInput, 'utf8').digest('hex').slice(0, 16);

  return {
    tag: `haive-sandbox:${hash}`,
    hash,
    dockerfileBody,
    hasEnvTemplate: input.envTemplateDockerfile !== null,
    hasCliInstall: installLines.length > 0,
    hasExtras: extra.length > 0,
  };
}

function resolveBase(envTemplateDockerfile: string | null): string {
  if (!envTemplateDockerfile) return `FROM ${SANDBOX_CORE_IMAGE}`;
  return envTemplateDockerfile.trimEnd();
}
