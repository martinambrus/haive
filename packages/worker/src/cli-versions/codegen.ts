import { CLI_INSTALL_METADATA, type CliProviderName } from '@haive/shared';

export interface DockerfileCodegenResult {
  lines: string[];
  supported: boolean;
}

const ENSURE_NPM_LINE =
  'RUN if ! command -v npm >/dev/null 2>&1; then ' +
  'apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && ' +
  'curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && ' +
  'apt-get install -y --no-install-recommends nodejs && ' +
  'rm -rf /var/lib/apt/lists/*; ' +
  'fi';

const ENSURE_NODE_USER_LINE =
  'RUN if ! id -u node >/dev/null 2>&1; then ' +
  'if id -u ubuntu >/dev/null 2>&1; then ' +
  'usermod -l node -d /home/node -m ubuntu && groupmod -n node ubuntu; ' +
  'else ' +
  'groupadd -g 1000 node 2>/dev/null || groupadd node; ' +
  'useradd -u 1000 -g node -m -s /bin/bash node 2>/dev/null || useradd -g node -m -s /bin/bash node; ' +
  'fi; ' +
  'fi';

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
    lines.push(ENSURE_NPM_LINE);
    lines.push(ENSURE_NODE_USER_LINE);
    lines.push(`RUN npm install -g ${install.package}${pin} && ${install.binary} --version`);
  } else if (install.kind === 'curl-script') {
    lines.push(ENSURE_NODE_USER_LINE);
    lines.push(`RUN curl -fsSL ${install.url} | bash`);
  } else if (install.kind === 'piggyback') {
    const target = CLI_INSTALL_METADATA[install.uses];
    if (target.install.kind === 'npm') {
      const pin = version ? `@${version}` : '';
      lines.push(ENSURE_NPM_LINE);
      lines.push(ENSURE_NODE_USER_LINE);
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
