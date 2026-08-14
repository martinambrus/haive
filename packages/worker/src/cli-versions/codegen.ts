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
    // Install to a global, on-PATH dir. The installers default to a path under
    // $HOME, which during the image build is root's home and is not reachable by
    // the sandbox's `node` user, so each installer is steered to /usr/local/bin
    // (matching the npm -g install location).
    //
    // HOW that is steered is per-installer, which is why it is declared in
    // install-metadata rather than hardcoded here:
    //   - agy takes a `--dir` FLAG        -> installArgs
    //   - grok takes a GROK_BIN_DIR ENV   -> env (its `$1` is parsed as a
    //     version and it rejects `--dir` outright as an invalid version format)
    // grok also takes its pinned version as that `$1` positional, so a pinnable
    // curl installer appends the version after any installArgs.
    const envPrefix =
      install.env && Object.keys(install.env).length > 0
        ? `${Object.entries(install.env)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ')} `
        : '';
    const scriptArgs = [...(install.installArgs ?? [])];
    if (meta.versionPinnable && version) scriptArgs.push(version);
    const argSuffix = scriptArgs.length > 0 ? ` -- ${scriptArgs.join(' ')}` : '';
    lines.push(`RUN curl -fsSL ${install.url} | ${envPrefix}bash -s${argSuffix}`);
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
      // ONE QUOTED ARG PER LINE, not one interpolated blob. `printf '%s\n'` repeats its
      // format for every operand, so N args produce N newline-terminated lines.
      //
      // Interpolating the raw content instead puts any embedded newline straight into the
      // Dockerfile, splitting the RUN into two physical lines — docker then parses line 2 as
      // an instruction and the build dies with `unknown instruction: <first token>`. Only
      // codex used this branch for a long time and its content is a single line, so the bug
      // stayed invisible until grok arrived with a two-line TOML table. Single-line content
      // still renders byte-identically, which the codex assertion in install-codegen.test.ts
      // pins down.
      const args = content.split('\n').map((line) => `'${line}'`);
      lines.push(`RUN mkdir -p ${dir} && printf '%s\\n' ${args.join(' ')} > ${knob.path}`);
    }
  }

  return { lines, supported: true };
}
