import type { AuthMode, CliProviderName } from '../types/index.js';

export interface CliProviderMetadata {
  name: CliProviderName;
  displayName: string;
  description: string;
  defaultExecutable: string;
  supportsSubagents: boolean;
  supportsApi: boolean;
  supportsCliAuth: boolean;
  defaultAuthMode: AuthMode;
  apiKeyEnvName: string | null;
  defaultModel: string | null;
  authConfigPaths: string[];
  docsUrl?: string;
}

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
    defaultAuthMode: 'subscription',
    apiKeyEnvName: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-sonnet-4-20250514',
    authConfigPaths: ['~/.config/claude', '~/.claude'],
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code',
  },
  codex: {
    name: 'codex',
    displayName: 'OpenAI Codex',
    description: 'OpenAI Codex CLI. Sub-agents are emulated via the splitter.',
    defaultExecutable: 'codex',
    supportsSubagents: false,
    supportsApi: true,
    supportsCliAuth: true,
    defaultAuthMode: 'subscription',
    apiKeyEnvName: 'OPENAI_API_KEY',
    defaultModel: 'o3',
    authConfigPaths: ['~/.codex'],
  },
  gemini: {
    name: 'gemini',
    displayName: 'Google Gemini',
    description: 'Google Gemini CLI. Sub-agents are emulated via the splitter.',
    defaultExecutable: 'gemini',
    supportsSubagents: false,
    supportsApi: true,
    supportsCliAuth: true,
    defaultAuthMode: 'subscription',
    apiKeyEnvName: 'GEMINI_API_KEY',
    defaultModel: 'gemini-2.5-pro',
    authConfigPaths: ['~/.config/gemini', '~/.gemini'],
  },
  amp: {
    name: 'amp',
    displayName: 'Sourcegraph Amp',
    description: 'Sourcegraph Amp CLI. CLI-only, sub-agents emulated.',
    defaultExecutable: 'amp',
    supportsSubagents: false,
    supportsApi: false,
    supportsCliAuth: true,
    defaultAuthMode: 'subscription',
    apiKeyEnvName: null,
    defaultModel: null,
    authConfigPaths: ['~/.config/amp', '~/.amp'],
  },
  grok: {
    name: 'grok',
    displayName: 'xAI Grok',
    description: 'xAI Grok CLI. OpenAI-compatible API path via api.x.ai.',
    defaultExecutable: 'grok',
    supportsSubagents: false,
    supportsApi: true,
    supportsCliAuth: true,
    defaultAuthMode: 'mixed',
    apiKeyEnvName: 'XAI_API_KEY',
    defaultModel: 'grok-3',
    authConfigPaths: ['~/.config/grok', '~/.grok'],
  },
  qwen: {
    name: 'qwen',
    displayName: 'Alibaba Qwen',
    description: 'Alibaba Qwen CLI. OpenAI-compatible API via DashScope.',
    defaultExecutable: 'qwen',
    supportsSubagents: false,
    supportsApi: true,
    supportsCliAuth: true,
    defaultAuthMode: 'mixed',
    apiKeyEnvName: 'DASHSCOPE_API_KEY',
    defaultModel: 'qwen-max',
    authConfigPaths: ['~/.qwen'],
  },
  kiro: {
    name: 'kiro',
    displayName: 'Kiro',
    description: 'Kiro CLI. CLI-only, sub-agents emulated.',
    defaultExecutable: 'kiro',
    supportsSubagents: false,
    supportsApi: false,
    supportsCliAuth: true,
    defaultAuthMode: 'subscription',
    apiKeyEnvName: null,
    defaultModel: null,
    authConfigPaths: ['~/.kiro'],
  },
  zai: {
    name: 'zai',
    displayName: 'Z.AI',
    description: 'Z.AI CLI. Wraps the Claude binary with Anthropic-compatible env vars.',
    defaultExecutable: 'claude',
    supportsSubagents: true,
    supportsApi: true,
    supportsCliAuth: true,
    defaultAuthMode: 'mixed',
    apiKeyEnvName: 'ANTHROPIC_API_KEY',
    defaultModel: 'zai-latest',
    authConfigPaths: ['~/.config/claude', '~/.claude'],
  },
};

export const CLI_PROVIDER_LIST: CliProviderMetadata[] = Object.values(CLI_PROVIDER_CATALOG);

export function getCliProviderMetadata(name: CliProviderName): CliProviderMetadata {
  return CLI_PROVIDER_CATALOG[name];
}
