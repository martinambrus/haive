import { CLI_INSTALL_METADATA, type CliProviderName } from '@haive/shared';

export interface DockerfileCodegenResult {
  lines: string[];
  supported: boolean;
}

export function buildProviderInstallLines(
  name: CliProviderName,
  version: string | null,
): DockerfileCodegenResult {
  const meta = CLI_INSTALL_METADATA[name];
  const install = meta.install;
  const lines: string[] = [];

  if (install.kind === 'unsupported') {
    return { lines: [], supported: false };
  }

  if (install.kind === 'npm') {
    const pin = version ? `@${version}` : '';
    lines.push(`RUN npm install -g ${install.package}${pin} && ${install.binary} --version`);
  } else if (install.kind === 'curl-script') {
    lines.push(`RUN curl -fsSL ${install.url} | bash`);
  } else if (install.kind === 'piggyback') {
    const target = CLI_INSTALL_METADATA[install.uses];
    if (target.install.kind === 'npm') {
      const pin = version ? `@${version}` : '';
      lines.push(
        `RUN npm install -g ${target.install.package}${pin} && ${target.install.binary} --version`,
      );
    }
  }

  for (const knob of meta.autoUpdateDisable) {
    if (knob.kind === 'env') {
      for (const [k, v] of Object.entries(knob.vars)) {
        lines.push(`ENV ${k}=${v}`);
      }
    } else if (knob.kind === 'config-file') {
      const slash = knob.path.lastIndexOf('/');
      const dir = slash > 0 ? knob.path.substring(0, slash) : '/';
      const content = knob.content.replace(/\n+$/, '');
      if (content.includes("'")) {
        throw new Error(
          `cli-versions/codegen: config-file content for ${name} contains a single quote; extend escape logic`,
        );
      }
      lines.push(`RUN mkdir -p ${dir} && printf '%s\\n' '${content}' > ${knob.path}`);
    }
  }

  return { lines, supported: true };
}
