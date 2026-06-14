import type { CliProviderName } from '../types/index.js';

export type AutoUpdateDisableKnob =
  | { kind: 'env'; vars: Record<string, string> }
  | { kind: 'config-file'; path: string; content: string };

export type VersionSource =
  | { kind: 'npm'; package: string }
  | { kind: 'github-releases'; repo: string; tagPrefix?: string }
  | { kind: 'none' };

export type InstallSpec =
  | { kind: 'npm'; package: string; binary: string }
  | { kind: 'curl-script'; url: string; binary: string }
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
};
