import { BaseCliAdapter } from './base-adapter.js';
import type {
  CliCommandSpec,
  CliProviderRecord,
  EffortScale,
  EnvInjection,
  InvokeOpts,
  PluginInstallCommand,
  PluginInstallOpts,
} from './types.js';

const CLAUDE_EFFORT_SCALE: EffortScale = {
  values: ['low', 'medium', 'high', 'max'],
  max: 'max',
};

const CLAUDE_LSP_PLUGINS: Record<string, string> = {
  typescript: 'vtsls',
  python: 'pyright',
  go: 'gopls',
  rust: 'rust-analyzer',
  php: 'phpactor',
  java: 'jdtls',
};
const CLAUDE_LSP_MARKETPLACE_REF = 'Piebald-AI/claude-code-lsps';
const CLAUDE_LSP_MARKETPLACE_ID = 'claude-code-lsps';

export class ClaudeCodeAdapter extends BaseCliAdapter {
  readonly providerName = 'claude-code' as const;
  readonly defaultExecutable = 'claude';
  readonly supportsSubagents = true;
  readonly supportsCliAuth = true;
  readonly supportsMcp = true;
  readonly supportsPlugins = true;
  readonly defaultAuthMode = 'subscription' as const;
  readonly apiKeyEnvName = 'ANTHROPIC_API_KEY';
  readonly defaultModel = 'claude-sonnet-4-20250514';
  readonly rulesFile = 'CLAUDE.md';
  readonly rulesFileMode = 'import' as const;
  override readonly effortScale = CLAUDE_EFFORT_SCALE;

  buildCliInvocation(
    provider: CliProviderRecord,
    prompt: string,
    opts: InvokeOpts,
  ): CliCommandSpec {
    return {
      command: this.resolveExecutable(provider),
      args: this.mergedArgs(provider, [
        '--dangerously-skip-permissions',
        '-p',
        prompt,
        '--output-format',
        'stream-json',
        '--verbose',
      ]),
      env: {
        // Claude Code caps a single response at 32000 output tokens by default
        // and hard-fails when a step exceeds it (skill generation emits many
        // sub-skill bodies in one JSON blob and blows past 32K). Raise to 128000
        // — onboarding runs Claude Code on Opus (verified: claude-opus-4-8[1m]),
        // whose 128K output ceiling this matches. It is a ceiling, not a target,
        // so smaller-output steps are unaffected. NOTE: 128K is Opus-only — if
        // Claude Code is switched to a 64K model (Sonnet 4.6 / Haiku 4.5) every
        // request would 400; drop this to 64000 via the provider's envVars then
        // (it wins because mergedEnv spreads last).
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: '128000',
        ...this.mergedEnv(provider, opts),
      },
      cwd: opts.cwd,
    };
  }

  override effortEnv(level: string): Record<string, string> {
    return { CLAUDE_CODE_EFFORT_LEVEL: level };
  }

  envInjection(_provider: CliProviderRecord): EnvInjection {
    return {
      envVars: {},
      extraArgs: [],
    };
  }

  override buildPluginInstallCommands(
    provider: CliProviderRecord,
    opts: PluginInstallOpts,
  ): PluginInstallCommand[] {
    const exec = this.resolveExecutable(provider);
    const cmds: PluginInstallCommand[] = [];
    const lspPlugins = opts.lspLanguages
      .map((lang) => CLAUDE_LSP_PLUGINS[lang === 'php-extended' ? 'php' : lang])
      .filter((v): v is string => !!v);
    const uniqueLsp = [...new Set(lspPlugins)];
    if (uniqueLsp.length > 0) {
      cmds.push({
        description: `Add ${CLAUDE_LSP_MARKETPLACE_REF} marketplace`,
        command: exec,
        args: ['plugin', 'marketplace', 'add', CLAUDE_LSP_MARKETPLACE_REF],
      });
      for (const name of uniqueLsp) {
        cmds.push({
          description: `Install LSP plugin ${name}`,
          command: exec,
          args: ['plugin', 'install', `${name}@${CLAUDE_LSP_MARKETPLACE_ID}`],
        });
      }
    }
    if (opts.drupalLspPath) {
      cmds.push({
        description: 'Add local drupal-lsp marketplace',
        command: exec,
        args: ['plugin', 'marketplace', 'add', opts.drupalLspPath],
      });
      cmds.push({
        description: 'Install drupal-php-lsp plugin',
        command: exec,
        args: ['plugin', 'install', 'drupal-php-lsp@drupal-lsp-marketplace'],
      });
    }
    return cmds;
  }
}
