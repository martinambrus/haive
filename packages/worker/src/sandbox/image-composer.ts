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
  const hash = createHash('sha256').update(dockerfileBody, 'utf8').digest('hex').slice(0, 16);

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
