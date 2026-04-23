import type { AuthMode, CliProviderName } from '../types/index.js';

export interface EffortScaleMetadata {
  /** Allowed level identifiers for this CLI, ordered low-to-high. */
  values: readonly string[];
  /** Identifier for the highest effort level. Used as the default when no
   *  per-provider override is set, and to gate the onboarding warning. */
  max: string;
}

/** Per-CLI spec for mounting user-level skills into a task container.
 *  `host` is the canonical user-home path (tilde-form). `fallbackHost` lets
 *  us seed from another CLI's skills dir when the canonical one is absent —
 *  e.g. codex falls back to `~/.claude/skills` so users migrating from
 *  Claude Code don't lose their skills. `containerPath` is the absolute
 *  mount target inside the sandbox. */
export interface UserSkillPath {
  host: string;
  fallbackHost?: string;
  containerPath: string;
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
  /** Repo-relative directory where this CLI auto-loads project-level skills.
   *  Used by onboarding step 09_5 to write skills to the active CLI's native
   *  path (claude-based CLIs share `.claude/skills`; codex uses `.agents/skills`;
   *  gemini uses `.gemini/skills`). */
  projectSkillsDir: string;
  /** Host → container bind mounts for user-level skills. Empty when the
   *  CLI's authConfigPaths already cover its skills dir (claude-code, amp,
   *  zai all share `~/.claude` which contains `skills/`). */
  userSkillsPaths: readonly UserSkillPath[];
}

const CLAUDE_LIKE_EFFORT_SCALE: EffortScaleMetadata = {
  values: ['low', 'medium', 'high', 'max'],
  max: 'max',
};

// Codex's native reasoning effort levels exposed via `model_reasoning_effort`
// in config.toml or per-run as `-c model_reasoning_effort="<level>"` on
// `codex exec`. `xhigh` is model-dependent (GPT-5 family); picking it on an
// older model will cause the CLI to reject the run, but that's the user's
// call — we surface the CLI's actual vocabulary rather than remapping onto
// claude-code's scale.
const CODEX_EFFORT_SCALE: EffortScaleMetadata = {
  values: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  max: 'xhigh',
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
    projectSkillsDir: '.claude/skills',
    userSkillsPaths: [],
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
    effortScale: CODEX_EFFORT_SCALE,
    projectSkillsDir: '.agents/skills',
    userSkillsPaths: [
      {
        host: '~/.agents/skills',
        fallbackHost: '~/.claude/skills',
        containerPath: '/root/.agents/skills',
      },
    ],
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
    projectSkillsDir: '.gemini/skills',
    userSkillsPaths: [
      {
        host: '~/.gemini/skills',
        fallbackHost: '~/.claude/skills',
        containerPath: '/root/.gemini/skills',
      },
    ],
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
    projectSkillsDir: '.claude/skills',
    userSkillsPaths: [],
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
    projectSkillsDir: '.claude/skills',
    userSkillsPaths: [],
  },
};

export const CLI_PROVIDER_LIST: CliProviderMetadata[] = Object.values(CLI_PROVIDER_CATALOG);

export function getCliProviderMetadata(name: CliProviderName): CliProviderMetadata {
  return CLI_PROVIDER_CATALOG[name];
}
