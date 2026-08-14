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
  minWorkingLoginVersion?: string;
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
    autoUpdateDisable: [
      {
        kind: 'config-file',
        path: '/etc/gemini-cli/settings.json',
        content: '{"general":{"enableAutoUpdate":false,"enableAutoUpdateNotification":false}}\n',
      },
    ],
    versionPinnable: true,
    // In-app OAuth login needs NO_BROWSER=true to print the auth URL to
    // stdout. Versions 0.18.0..0.18.3 suppress it (google-gemini/gemini-cli#13853).
    // Fixed in 0.18.4.
    minWorkingLoginVersion: '0.18.4',
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
    // image-cache resolves it to the existing haive-cli-sandbox:claude-code-<ver>
    // tag, so adding this provider builds no new sandbox image.
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
  },
};
