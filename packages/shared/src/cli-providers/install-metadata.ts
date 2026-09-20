import type { CliProviderName } from '../types/index.js';

export type AutoUpdateDisableKnob =
  | { kind: 'env'; vars: Record<string, string> }
  | { kind: 'config-file'; path: string; content: string };

export type VersionSource =
  | { kind: 'npm'; package: string }
  | { kind: 'github-releases'; repo: string; tagPrefix?: string }
  | { kind: 'pypi'; package: string }
  | { kind: 'gem'; gem: string }
  | { kind: 'none' };

export type InstallSpec =
  | { kind: 'npm'; package: string; binary: string }
  | {
      kind: 'curl-script';
      url: string;
      binary: string;
      /** Arguments passed after `bash -s --`. Used to steer installers that take
       *  a target-directory FLAG (agy's `--dir /usr/local/bin`). */
      installArgs?: string[];
      /** Environment assignments prefixed to the `bash` invocation. Used to steer
       *  installers that take a target directory as an ENV var instead of a flag
       *  (grok's `GROK_BIN_DIR`), because grok parses `$1` as a version string and
       *  rejects an unexpected flag outright. */
      env?: Record<string, string>;
    }
  | { kind: 'piggyback'; uses: CliProviderName }
  | { kind: 'unsupported'; reason: string };

export interface CliInstallMetadata {
  install: InstallSpec;
  versionSource: VersionSource;
  autoUpdateDisable: AutoUpdateDisableKnob[];
  versionPinnable: boolean;
  /** Oldest build that can run Haive's command line at all. The API neither offers nor saves an
   *  older one (isRunnableCliVersion): a pin below it fails every run. */
  minRunnableVersion?: string;
  /** Directories under the sandbox user's home that the CLI writes into and Haive mounts files
   *  beneath. The image pre-creates them owned by `node`: Docker creates a missing mount parent
   *  root-owned, and the CLI then cannot write beside the mount. */
  nodeOwnedDirs?: string[];
}

export const CLI_INSTALL_METADATA: Record<CliProviderName, CliInstallMetadata> = {
  'claude-code': {
    install: { kind: 'npm', package: '@anthropic-ai/claude-code', binary: 'claude' },
    versionSource: { kind: 'npm', package: '@anthropic-ai/claude-code' },
    autoUpdateDisable: [{ kind: 'env', vars: { DISABLE_AUTOUPDATER: '1' } }],
    versionPinnable: true,
  },
  codex: {
    install: { kind: 'npm', package: '@openai/codex', binary: 'codex' },
    versionSource: { kind: 'github-releases', repo: 'openai/codex', tagPrefix: 'rust-v' },
    autoUpdateDisable: [
      {
        kind: 'config-file',
        path: '/root/.codex/config.toml',
        content: 'check_for_update_on_startup = false\n',
      },
    ],
    versionPinnable: true,
  },
  gemini: {
    install: { kind: 'npm', package: '@google/gemini-cli', binary: 'gemini' },
    versionSource: { kind: 'npm', package: '@google/gemini-cli' },
    // gemini's SYSTEM settings file, and its ONLY writer: codegen `printf >`s it, so a second
    // writer in the base image was overwritten in every gemini image (the base image's
    // enableAgents:false never survived). It outranks the user's ~/.gemini volume and the repo's
    // .gemini/settings.json, and gemini reads it only while it is ROOT-owned, which a build-time
    // write is (MEASURED: 0.60.0 skips a uid-1000-owned one with a security warning).
    // - experimental.enableAgents:false: Haive owns fan-out (supportsSubagents=false).
    // - skills.disabled: gemini's built-in skills, which have no group switch. MEASURED on 0.26.0,
    //   0.35.3, 0.39.1, 0.45.3 and 0.60.0: both gone, repo skills intact. Builds from before
    //   skills existed accept the key and ignore it.
    autoUpdateDisable: [
      {
        kind: 'config-file',
        path: '/etc/gemini-cli/settings.json',
        content:
          '{"experimental":{"enableAgents":false},"general":{"enableAutoUpdate":false,"enableAutoUpdateNotification":false},"skills":{"disabled":["skill-creator","antigravity-support"]}}\n',
      },
    ],
    versionPinnable: true,
    // `--output-format json` shipped in v0.6.0. MEASURED with Haive's argv: 0.1.22 and 0.5.5 exit 1
    // on "Unknown arguments: output-format", while 0.6.0 through 0.60.0 reach the model.
    minRunnableVersion: '0.6.0',
  },
  amp: {
    install: { kind: 'npm', package: '@sourcegraph/amp', binary: 'amp' },
    versionSource: { kind: 'npm', package: '@sourcegraph/amp' },
    autoUpdateDisable: [{ kind: 'env', vars: { AMP_SKIP_UPDATE_CHECK: '1' } }],
    versionPinnable: true,
  },
  zai: {
    install: { kind: 'piggyback', uses: 'claude-code' },
    versionSource: { kind: 'npm', package: '@anthropic-ai/claude-code' },
    autoUpdateDisable: [{ kind: 'env', vars: { DISABLE_AUTOUPDATER: '1' } }],
    versionPinnable: true,
  },
  antigravity: {
    install: {
      kind: 'curl-script',
      url: 'https://antigravity.google/cli/install.sh',
      binary: 'agy',
      // Was hardcoded in cli-versions/codegen; moved here when grok arrived with
      // an env-var-based installer. The rendered line must stay byte-identical.
      installArgs: ['--dir', '/usr/local/bin'],
    },
    // Manifest-based downloader, no plain registry to pin against.
    versionSource: { kind: 'none' },
    // agy self-updates in the background; disable it in the pinned sandbox
    // image. Env name per Antigravity docs (runtime-unconfirmed; a wrong name
    // is harmless — it just sets an unused env var).
    autoUpdateDisable: [{ kind: 'env', vars: { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' } }],
    versionPinnable: false,
    // agy keeps its project state in ~/.gemini/config, where Haive also mounts its MCP config.
    // MEASURED on 1.2.2: with that dir root-owned by the mount, every print run died with
    // "failed to get/create default project: ... permission denied"; node-owned, it runs.
    nodeOwnedDirs: ['/home/node/.gemini/config'],
  },
  ollama: {
    // Ollama reuses the Claude binary (like zai); no separate install.
    install: { kind: 'piggyback', uses: 'claude-code' },
    versionSource: { kind: 'npm', package: '@anthropic-ai/claude-code' },
    autoUpdateDisable: [{ kind: 'env', vars: { DISABLE_AUTOUPDATER: '1' } }],
    versionPinnable: true,
  },
  muse: {
    // Muse reuses the Claude binary against Meta's Anthropic-compatible
    // endpoint (like zai/ollama); no separate install. Piggybacking also means
    // image-cache resolves it to the existing haive-cli-sandbox:claude-code-<ver>-<hash>
    // tag, so adding this provider builds no new sandbox image — the hash is over the
    // RENDERED Dockerfile, which is byte-identical to claude-code's, so sharing survives.
    // It would stop sharing (correctly) if the entries below ever diverged from
    // claude-code's, e.g. a different autoUpdateDisable knob.
    install: { kind: 'piggyback', uses: 'claude-code' },
    versionSource: { kind: 'npm', package: '@anthropic-ai/claude-code' },
    autoUpdateDisable: [{ kind: 'env', vars: { DISABLE_AUTOUPDATER: '1' } }],
    versionPinnable: true,
  },
  grok: {
    // TWO env vars, and BOTH are load-bearing — `--dir` is not an option here at all:
    // the installer validates `$1` against ^[0-9]+\.[0-9]+\.[0-9]+ and exits
    // "Invalid version format" on a flag.
    //
    // GROK_BIN_DIR only moves the SYMLINK. The payload path is hardcoded
    // (`DOWNLOAD_DIR="$HOME/.grok/downloads"`), so with the build's default HOME the
    // real binary lands under /root — mode 0700 — and /usr/local/bin/grok becomes a
    // link the sandbox's non-root `node` user cannot follow. Measured: as uid 1000
    // that image fails with `Cannot find module '/grok'` while root runs it fine.
    // HOME=/opt/grok moves the payload to a 0755 path, verified working as uid 1000.
    //
    // It also keeps ~/.grok free at RUNTIME, which is what the provider's
    // authConfigPaths mount needs — a binary living there would be shadowed by the
    // per-task auth volume the moment a task starts.
    install: {
      kind: 'curl-script',
      url: 'https://x.ai/cli/install.sh',
      binary: 'grok',
      env: { HOME: '/opt/grok', GROK_BIN_DIR: '/usr/local/bin' },
    },
    // xai-org/grok-build publishes NO GitHub releases and NO tags, so the npm
    // package is the only machine-readable version feed. It is the same version
    // stream as the curl installer (npm 1.0.3 == `grok --version` 1.0.3), which
    // the installer takes as its `$1` positional. A drift between the two fails
    // the image build loudly rather than silently installing the wrong version.
    versionSource: { kind: 'npm', package: '@xai-official/grok' },
    // No env var disables grok's updater — the only knob is `[cli] auto_update`
    // in config.toml (docs 05-configuration). Every orchestrated run also passes
    // `--no-auto-update`, which is the per-run guarantee this file cannot give.
    autoUpdateDisable: [
      {
        kind: 'config-file',
        path: '/root/.grok/config.toml',
        content: '[cli]\nauto_update = false\n',
      },
    ],
    versionPinnable: true,
    // `--output-format streaming-messages-json`, which the adapter depends on, arrived in 0.2.116.
    // MEASURED with Haive's argv: every build from 0.1.202 to 0.2.115 exits 2 on it.
    minRunnableVersion: '0.2.116',
  },
  openrouter: {
    // OpenRouter reuses the Claude binary against its Anthropic-compatible endpoint
    // (like zai/ollama/muse); no separate install. Piggybacking also means
    // image-cache resolves it to the existing haive-cli-sandbox:claude-code-<ver>
    // tag, so adding this provider builds no new sandbox image.
    install: { kind: 'piggyback', uses: 'claude-code' },
    versionSource: { kind: 'npm', package: '@anthropic-ai/claude-code' },
    autoUpdateDisable: [{ kind: 'env', vars: { DISABLE_AUTOUPDATER: '1' } }],
    versionPinnable: true,
  },
};

function versionTriple(version: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** False only for a version KNOWN to be older than the CLI's minRunnableVersion. A shape that does
 *  not parse counts as runnable: refusing what cannot be read would block a legitimate build,
 *  while a broken one still fails loudly at its first run. */
export function isRunnableCliVersion(name: CliProviderName, version: string): boolean {
  const floor = CLI_INSTALL_METADATA[name]?.minRunnableVersion;
  if (!floor) return true;
  const v = versionTriple(version);
  const f = versionTriple(floor);
  if (!v || !f) return true;
  for (let i = 0; i < 3; i++) {
    if (v[i] !== f[i]) return v[i]! > f[i]!;
  }
  return true;
}
