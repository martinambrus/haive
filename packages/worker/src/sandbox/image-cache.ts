import { CLI_INSTALL_METADATA, type CliProviderName } from '@haive/shared';
import { buildProviderInstallLines } from '../cli-versions/codegen.js';

export interface ImageTagResolution {
  tag: string;
  shared: boolean;
  dockerfileLines: string[];
}

const BASE_IMAGE = 'haive-cli-sandbox:latest';

export function resolveImageTag(params: {
  name: CliProviderName;
  cliVersion: string | null;
  providerId: string;
  sandboxDockerfileExtra: string | null;
}): ImageTagResolution | null {
  const extra = (params.sandboxDockerfileExtra ?? '').trim();
  const meta = CLI_INSTALL_METADATA[params.name];
  const codegen = buildProviderInstallLines(params.name, params.cliVersion);

  const hasInstall = codegen.supported && codegen.lines.length > 0;
  const hasExtras = extra.length > 0;

  if (!hasInstall && !hasExtras) return null;

  const blocks = [`FROM ${BASE_IMAGE}`];
  if (hasInstall) blocks.push(codegen.lines.join('\n'));
  if (hasExtras) blocks.push(extra);
  const dockerfileLines = [blocks.join('\n\n')];

  if (hasInstall && !hasExtras) {
    const effectiveName =
      meta.install.kind === 'piggyback' ? meta.install.uses : params.name;
    const versionSegment =
      meta.versionPinnable && params.cliVersion ? params.cliVersion : 'installer';
    return {
      tag: `haive-cli-sandbox:${effectiveName}-${versionSegment}`,
      shared: true,
      dockerfileLines,
    };
  }

  return {
    tag: `haive-cli-sandbox:provider-${params.providerId}`,
    shared: false,
    dockerfileLines,
  };
}

export function renderDockerfile(resolution: ImageTagResolution): string {
  return `${resolution.dockerfileLines.join('\n\n')}\n`;
}
