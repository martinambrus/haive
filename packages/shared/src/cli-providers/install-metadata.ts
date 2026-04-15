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
        content:
          '{"general":{"enableAutoUpdate":false,"enableAutoUpdateNotification":false}}\n',
      },
    ],
    versionPinnable: true,
  },
  amp: {
    install: { kind: 'npm', package: '@sourcegraph/amp', binary: 'amp' },
    versionSource: { kind: 'npm', package: '@sourcegraph/amp' },
    autoUpdateDisable: [{ kind: 'env', vars: { AMP_SKIP_UPDATE_CHECK: '1' } }],
    versionPinnable: true,
  },
  qwen: {
    install: { kind: 'npm', package: '@qwen-code/qwen-code', binary: 'qwen' },
    versionSource: { kind: 'npm', package: '@qwen-code/qwen-code' },
    autoUpdateDisable: [
      {
        kind: 'config-file',
        path: '/root/.qwen/settings.json',
        content: '{"general":{"enableAutoUpdate":false}}\n',
      },
    ],
    versionPinnable: true,
  },
  grok: {
    install: {
      kind: 'unsupported',
      reason: 'No first-party xAI CLI available as of 2026-04',
    },
    versionSource: { kind: 'none' },
    autoUpdateDisable: [],
    versionPinnable: false,
  },
  kiro: {
    install: { kind: 'curl-script', url: 'https://cli.kiro.dev/install', binary: 'kiro-cli' },
    versionSource: { kind: 'none' },
    autoUpdateDisable: [
      {
        kind: 'config-file',
        path: '/root/.kiro/settings/cli.json',
        content: '{"app":{"disableAutoupdates":true}}\n',
      },
    ],
    versionPinnable: false,
  },
  zai: {
    install: { kind: 'piggyback', uses: 'claude-code' },
    versionSource: { kind: 'npm', package: '@anthropic-ai/claude-code' },
    autoUpdateDisable: [{ kind: 'env', vars: { DISABLE_AUTOUPDATER: '1' } }],
    versionPinnable: true,
  },
};
