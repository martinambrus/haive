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
  /** Repo-relative directory where this CLI auto-loads project-level custom
   *  agent definitions. Null when the CLI has no file-based custom-agent
   *  system (amp exposes only the built-in Task tool). Paths are taken from
   *  each vendor's docs: claude-code/zai use `.claude/agents/`; gemini uses
   *  `.gemini/agents/`; codex uses `.codex/agents/`. */
  projectAgentsDir: string | null;
  /** File format the CLI expects for agent definitions. Claude-family and
   *  gemini read markdown with YAML frontmatter; codex reads TOML — the
   *  current generator only emits markdown, so codex agent writes are
   *  skipped until a TOML emitter exists. Null iff projectAgentsDir is null. */
  agentFileFormat: 'markdown' | 'toml' | null;
  /** Whether this provider's reported costUsd is a trustworthy real backend price.
   *  - 'metered': real per-token price from the provider's own backend (claude-code,
   *    codex, gemini) — sum + display as $.
   *  - 'subscription': flat-plan CLI, no meaningful per-token price (amp, antigravity).
   *  - 'local': free local compute; the claude binary reports Anthropic-price FICTION
   *    against a local endpoint (ollama).
   *  - 'estimate': metered backend, but the claude binary MISPRICES it against
   *    Anthropic's table (zai/GLM overstates ~10x) — reported, but not real $.
   *  Only 'metered' cost is summed as real dollars in the token telemetry; the rest are
   *  shown token-only with the basis label. Raw costUsd is still persisted per
   *  invocation for observability. */
  costBasis: 'metered' | 'subscription' | 'local' | 'estimate';
}

// Claude Code drives the real Anthropic `claude` binary, which accepts an
// `xhigh` reasoning level between `high` and `max`. Kept separate from
// CLAUDE_LIKE_EFFORT_SCALE so the zai wrapper — same binary, but a GLM backend
// that does not honor xhigh — stays on the conservative shared scale.
const CLAUDE_CODE_EFFORT_SCALE: EffortScaleMetadata = {
  values: ['low', 'medium', 'high', 'xhigh', 'max'],
  max: 'max',
};

// The claude-family effort scale for CLI wrappers that drive the claude binary
// against a non-Anthropic backend (zai/GLM). No `xhigh` — that level is
// Anthropic-model-specific.
const CLAUDE_LIKE_EFFORT_SCALE: EffortScaleMetadata = {
  values: ['low', 'medium', 'high', 'max'],
  max: 'max',
};

// Codex's native reasoning effort levels exposed via `model_reasoning_effort`
// in config.toml or per-run as `-c model_reasoning_effort="<level>"` on
// `codex exec`, ordered low-to-high per the CLI's own ReasoningEffort enum.
// `minimal` is intentionally omitted: it disables web search, which Haive's
// codex steps rely on. `xhigh`/`max`/`ultra` are model-dependent (newer GPT-5
// family); picking one on a model that does not support it makes the CLI reject
// the run, but that's the user's call — we surface the CLI's actual vocabulary
// rather than remapping onto claude-code's scale.
const CODEX_EFFORT_SCALE: EffortScaleMetadata = {
  values: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  max: 'ultra',
};

export const CLI_PROVIDER_CATALOG: Record<CliProviderName, CliProviderMetadata> = {
  'claude-code': {
    name: 'claude-code',
    costBasis: 'metered',
    displayName: 'Claude Code',
    description:
      "Anthropic's first-class CLI for Claude. Native sub-agent support via the Task tool.",
    defaultExecutable: 'claude',
    supportsSubagents: true,
    supportsCliAuth: true,
    supportsMcp: true,
    supportsPlugins: true,
    defaultAuthMode: 'subscription',
    apiKeyEnvName: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-sonnet-4-20250514',
    authConfigPaths: ['~/.config/claude', '~/.claude'],
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code',
    effortScale: CLAUDE_CODE_EFFORT_SCALE,
    projectSkillsDir: '.claude/skills',
    userSkillsPaths: [],
    projectAgentsDir: '.claude/agents',
    agentFileFormat: 'markdown',
  },
  codex: {
    name: 'codex',
    costBasis: 'metered',
    displayName: 'OpenAI Codex',
    description: "OpenAI's Codex CLI. Native sub-agent orchestration.",
    defaultExecutable: 'codex',
    supportsSubagents: true,
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
    projectAgentsDir: '.codex/agents',
    agentFileFormat: 'toml',
  },
  gemini: {
    name: 'gemini',
    costBasis: 'metered',
    displayName: 'Google Gemini',
    description: 'Google Gemini CLI. Native sub-agents via markdown agent definitions.',
    defaultExecutable: 'gemini',
    supportsSubagents: true,
    // BYOK/API-key only (no subscription CLI login). Kept true like zai so the
    // dispatcher's CLI path stays available; defaultAuthMode='api_key' is what
    // removes the subscription option from the UI/API.
    supportsCliAuth: true,
    supportsMcp: true,
    supportsPlugins: false,
    defaultAuthMode: 'api_key',
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
    projectAgentsDir: '.gemini/agents',
    agentFileFormat: 'markdown',
  },
  amp: {
    name: 'amp',
    costBasis: 'subscription',
    displayName: 'Sourcegraph Amp',
    description: 'Sourcegraph Amp CLI. Native sub-agents spawn parallel mini-Amp threads.',
    defaultExecutable: 'amp',
    supportsSubagents: true,
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
    projectAgentsDir: null,
    agentFileFormat: null,
  },
  zai: {
    name: 'zai',
    costBasis: 'estimate',
    displayName: 'Z.AI',
    description: 'Z.AI CLI. Wraps the Claude binary with Anthropic-compatible env vars.',
    defaultExecutable: 'claude',
    supportsSubagents: true,
    supportsCliAuth: true,
    supportsMcp: true,
    supportsPlugins: true,
    defaultAuthMode: 'api_key',
    apiKeyEnvName: 'ANTHROPIC_AUTH_TOKEN',
    defaultModel: 'glm-4.6',
    authConfigPaths: ['~/.config/claude', '~/.claude'],
    effortScale: CLAUDE_LIKE_EFFORT_SCALE,
    projectSkillsDir: '.claude/skills',
    userSkillsPaths: [],
    projectAgentsDir: '.claude/agents',
    agentFileFormat: 'markdown',
  },
  antigravity: {
    name: 'antigravity',
    costBasis: 'subscription',
    displayName: 'Google Antigravity',
    description:
      'Google Antigravity CLI (agy). Subscription coding via Continue-with-Google sign-in.',
    defaultExecutable: 'agy',
    // agy is a full agentic CLI with native subagents (dispatched as a single
    // native invocation, not sequential emulation).
    supportsSubagents: true,
    supportsCliAuth: true,
    supportsMcp: true,
    supportsPlugins: true,
    defaultAuthMode: 'subscription',
    // No simple API-key env; BYOK would be GCP ADC, out of scope for v1.
    apiKeyEnvName: null,
    defaultModel: null,
    // OAuth token persists as a file under this dir
    // (antigravity-oauth-token); captured by the auth volume.
    authConfigPaths: ['~/.gemini/antigravity-cli'],
    docsUrl: 'https://antigravity.google/docs/cli-getting-started',
    effortScale: null,
    // Workspace skills/agents dirs confirmed against the agy binary
    // (.agents/skills, .agents/agents); agy reads AGENTS.md and imports
    // claude/gemini-style markdown agent definitions.
    projectSkillsDir: '.agents/skills',
    userSkillsPaths: [],
    projectAgentsDir: '.agents/agents',
    agentFileFormat: 'markdown',
  },
  ollama: {
    name: 'ollama',
    costBasis: 'local',
    displayName: 'Ollama',
    description:
      "Ollama models (local, remote server, or Ollama Cloud). Reuses the Claude binary against Ollama's Anthropic-compatible endpoint; set the model and base URL per provider.",
    defaultExecutable: 'claude',
    // Native sub-agents via the claude binary's Task() (same mechanism as zai);
    // agent-mining fan-outs work regardless. Scaffolding steps are protected by
    // the unsafeForLocalModels guardrail, not by this flag.
    supportsSubagents: true,
    supportsCliAuth: true,
    supportsMcp: true,
    // The claude binary's `plugin` subcommands install into .claude/plugins with
    // no model call, so they work against the Ollama endpoint like claude-code/zai.
    supportsPlugins: true,
    defaultAuthMode: 'api_key',
    // Local Ollama needs no real key (the binary accepts any non-empty token);
    // cloud/remote users store their key UNDER THIS env name (not
    // OLLAMA_API_KEY) because secrets merge into env verbatim with no remap.
    apiKeyEnvName: 'ANTHROPIC_AUTH_TOKEN',
    // No universal default; the per-provider `model` field must be set.
    defaultModel: null,
    authConfigPaths: ['~/.config/claude', '~/.claude'],
    docsUrl: 'https://docs.ollama.com',
    effortScale: null,
    projectSkillsDir: '.claude/skills',
    userSkillsPaths: [],
    projectAgentsDir: '.claude/agents',
    agentFileFormat: 'markdown',
  },
};

export const CLI_PROVIDER_LIST: CliProviderMetadata[] = Object.values(CLI_PROVIDER_CATALOG);

/** Provider names whose reported costUsd is a real backend price (safe to sum as $).
 *  Used by the token telemetry to keep local/subscription/mispriced $ out of the
 *  headline cost. See CliProviderMetadata.costBasis. */
export const COST_METERED_PROVIDERS: CliProviderName[] = CLI_PROVIDER_LIST.filter(
  (p) => p.costBasis === 'metered',
).map((p) => p.name);

export function isCostMetered(name: CliProviderName): boolean {
  return CLI_PROVIDER_CATALOG[name].costBasis === 'metered';
}

/** The effective cost basis for an invocation given its provider's auth mode.
 *  A metered backend bills real per-token money ONLY under api_key auth; under a
 *  flat subscription plan the CLI still reports a notional (Anthropic-price)
 *  costUsd, so classify it as 'subscription' — token-only, no real $. All other
 *  bases are auth-mode-independent and pass through unchanged. Equivalent to the
 *  SQL cost filters (`name in <metered> and auth_mode = 'api_key'`). */
export function resolveCostBasis(
  name: CliProviderName,
  authMode: AuthMode,
): CliProviderMetadata['costBasis'] {
  const base = CLI_PROVIDER_CATALOG[name].costBasis;
  if (base === 'metered' && authMode === 'subscription') return 'subscription';
  return base;
}

export function getCliProviderMetadata(name: CliProviderName): CliProviderMetadata {
  return CLI_PROVIDER_CATALOG[name];
}
