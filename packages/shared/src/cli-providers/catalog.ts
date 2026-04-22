import type { AuthMode, CliProviderName } from '../types/index.js';

export interface EffortScaleMetadata {
  /** Allowed level identifiers for this CLI, ordered low-to-high. */
  values: readonly string[];
  /** Identifier for the highest effort level. Used as the default when no
   *  per-provider override is set, and to gate the onboarding warning. */
  max: string;
}

export interface CliProviderMetadata {
  name: CliProviderName;
  displayName: string;
  description: string;
  defaultExecutable: string;
  supportsSubagents: boolean;
  supportsApi: boolean;
  supportsCliAuth: boolean;
  supportsMcp: boolean;
  supportsPlugins: boolean;
  defaultAuthMode: AuthMode;
  apiKeyEnvName: string | null;
  defaultModel: string | null;
  authConfigPaths: string[];
  docsUrl?: string;
  /** When non-null the provider exposes a reasoning/effort knob and the UI
   *  must render a selector for it. Adapters that don't support such a knob
   *  set this to null and ignore any stored effortLevel. */
  effortScale: EffortScaleMetadata | null;
}

const CLAUDE_LIKE_EFFORT_SCALE: EffortScaleMetadata = {
  values: ['low', 'medium', 'high', 'max'],
  max: 'max',
};

export const CLI_PROVIDER_CATALOG: Record<CliProviderName, CliProviderMetadata> = {
  'claude-code': {
    name: 'claude-code',
    displayName: 'Claude Code',
    description:
      "Anthropic's first-class CLI for Claude. Native sub-agent support via the Task tool.",
    defaultExecutable: 'claude',
    supportsSubagents: true,
    supportsApi: true,
    supportsCliAuth: true,
    supportsMcp: true,
    supportsPlugins: true,
    defaultAuthMode: 'subscription',
    apiKeyEnvName: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-sonnet-4-20250514',
    authConfigPaths: ['~/.config/claude', '~/.claude'],
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code',
    effortScale: CLAUDE_LIKE_EFFORT_SCALE,
  },
  codex: {
    name: 'codex',
    displayName: 'OpenAI Codex',
    description: "OpenAI's Codex CLI. Native sub-agent orchestration.",
    defaultExecutable: 'codex',
    supportsSubagents: true,
    supportsApi: true,
    supportsCliAuth: true,
    supportsMcp: true,
    supportsPlugins: false,
    defaultAuthMode: 'subscription',
    apiKeyEnvName: 'OPENAI_API_KEY',
    defaultModel: 'o3',
    authConfigPaths: ['~/.codex'],
    effortScale: null,
  },
  gemini: {
    name: 'gemini',
    displayName: 'Google Gemini',
    description: 'Google Gemini CLI. Native sub-agents via markdown agent definitions.',
    defaultExecutable: 'gemini',
    supportsSubagents: true,
    supportsApi: true,
    supportsCliAuth: true,
    supportsMcp: true,
    supportsPlugins: false,
    defaultAuthMode: 'subscription',
    apiKeyEnvName: 'GEMINI_API_KEY',
    defaultModel: 'gemini-2.5-pro',
    authConfigPaths: ['~/.config/gemini', '~/.gemini'],
    effortScale: null,
  },
  amp: {
    name: 'amp',
    displayName: 'Sourcegraph Amp',
    description: 'Sourcegraph Amp CLI. Native sub-agents spawn parallel mini-Amp threads.',
    defaultExecutable: 'amp',
    supportsSubagents: true,
    supportsApi: false,
    supportsCliAuth: true,
    supportsMcp: false,
    supportsPlugins: false,
    defaultAuthMode: 'subscription',
    apiKeyEnvName: null,
    defaultModel: null,
    authConfigPaths: ['~/.local/share/amp', '~/.config/amp'],
    effortScale: null,
  },
  grok: {
    name: 'grok',
    displayName: 'xAI Grok',
    description: 'xAI Grok CLI. OpenAI-compatible API path via api.x.ai. Configurable sub-agents.',
    defaultExecutable: 'grok',
    supportsSubagents: true,
    supportsApi: true,
    supportsCliAuth: true,
    supportsMcp: false,
    supportsPlugins: false,
    defaultAuthMode: 'mixed',
    apiKeyEnvName: 'XAI_API_KEY',
    defaultModel: 'grok-3',
    authConfigPaths: ['~/.config/grok', '~/.grok'],
    effortScale: null,
  },
  qwen: {
    name: 'qwen',
    displayName: 'Alibaba Qwen',
    description: 'Alibaba Qwen CLI. OpenAI-compatible API via DashScope. Native sub-agent support.',
    defaultExecutable: 'qwen',
    supportsSubagents: true,
    supportsApi: true,
    supportsCliAuth: true,
    supportsMcp: false,
    supportsPlugins: true,
    defaultAuthMode: 'mixed',
    apiKeyEnvName: 'DASHSCOPE_API_KEY',
    defaultModel: 'qwen-max',
    authConfigPaths: ['~/.qwen'],
    effortScale: null,
  },
  kiro: {
    name: 'kiro',
    displayName: 'Kiro',
    description: 'Kiro CLI. CLI-only. Native sub-agents with task dependencies.',
    defaultExecutable: 'kiro',
    supportsSubagents: true,
    supportsApi: false,
    supportsCliAuth: true,
    supportsMcp: false,
    supportsPlugins: false,
    defaultAuthMode: 'subscription',
    apiKeyEnvName: null,
    defaultModel: null,
    authConfigPaths: ['~/.kiro'],
    effortScale: null,
  },
  zai: {
    name: 'zai',
    displayName: 'Z.AI',
    description: 'Z.AI CLI. Wraps the Claude binary with Anthropic-compatible env vars.',
    defaultExecutable: 'claude',
    supportsSubagents: true,
    supportsApi: true,
    supportsCliAuth: true,
    supportsMcp: true,
    supportsPlugins: true,
    defaultAuthMode: 'mixed',
    apiKeyEnvName: 'ANTHROPIC_API_KEY',
    defaultModel: 'zai-latest',
    authConfigPaths: ['~/.config/claude', '~/.claude'],
    effortScale: CLAUDE_LIKE_EFFORT_SCALE,
  },
};

export const CLI_PROVIDER_LIST: CliProviderMetadata[] = Object.values(CLI_PROVIDER_CATALOG);

export function getCliProviderMetadata(name: CliProviderName): CliProviderMetadata {
  return CLI_PROVIDER_CATALOG[name];
}
