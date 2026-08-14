import { posix } from 'node:path';
import { BaseCliAdapter } from './base-adapter.js';
import type {
  CliCommandSpec,
  CliProviderRecord,
  EnvInjection,
  InvokeOpts,
  PluginInstallCommand,
  PluginInstallOpts,
} from './types.js';

// PHP intentionally absent — see the CLAUDE_LSP_PLUGINS note in claude-code.ts.
// Haive installs no phpactor binary; PHP LSP is intelephense via the local
// drupal-php-lsp plugin, so php must not map to the marketplace phpactor plugin.
//
// Grok reads the CLAUDE marketplace format: `grok plugin marketplace add
// Piebald-AI/claude-code-lsps` followed by `grok plugin install vtsls@claude-code-lsps`
// installs cleanly and `grok plugin details` reports the plugin's `LSP servers`
// component. Verified against grok 1.0.3 — this is not assumed from the docs.
const GROK_LSP_PLUGINS: Record<string, string> = {
  typescript: 'vtsls',
  python: 'pyright',
  go: 'gopls',
  rust: 'rust-analyzer',
  java: 'jdtls',
};
const GROK_LSP_MARKETPLACE_REF = 'Piebald-AI/claude-code-lsps';
const GROK_LSP_MARKETPLACE_ID = 'claude-code-lsps';

export class GrokAdapter extends BaseCliAdapter {
  readonly providerName = 'grok' as const;
  readonly defaultExecutable = 'grok';
  // Native subagents (the `spawn_subagent` tool, with git-worktree isolation), so
  // the splitter dispatches ONE native invocation rather than a sequential script.
  readonly supportsSubagents = true;
  readonly supportsCliAuth = true;
  readonly supportsMcp = true;
  readonly supportsPlugins = true;
  override readonly supportsLsp = true;
  // API key by default (XAI_API_KEY). `grok login --device-auth` also works for a
  // SuperGrok subscription — see setup-token-command. assertUserAuthReady
  // short-circuits when authMode is 'api_key', so supportsCliAuth being true does
  // not force a login.
  readonly defaultAuthMode = 'api_key' as const;
  // grok reads this env var directly; no remap needed (contrast zai/muse, which
  // have to alias their key onto ANTHROPIC_AUTH_TOKEN).
  readonly apiKeyEnvName = 'XAI_API_KEY';
  readonly defaultModel = 'grok-build-0.1';
  // grok reads AGENTS.md natively (and CLAUDE.md too, for Claude Code compat), so
  // step 07 appends its rules block straight to the shared repo-root AGENTS.md.
  readonly rulesFile = 'AGENTS.md';
  readonly rulesFileMode = 'native' as const;
  override readonly defaultEgressDomains = ['api.x.ai', 'auth.x.ai', 'grok.com'];

  // effortScale stays null (BaseCliAdapter's default) even though `grok --effort`
  // exists. It is INERT on the models Haive reaches, and an unknown level is
  // accepted silently rather than rejected, so there is nothing to expose and
  // nothing to probe. The full measurement lives on the catalog entry — read that
  // before reinstating a scale.

  buildCliInvocation(
    provider: CliProviderRecord,
    prompt: string,
    opts: InvokeOpts,
  ): CliCommandSpec {
    const env = this.mergedEnv(provider, opts);
    const args: string[] = [
      // NDJSON in the Anthropic Messages wire format — `system`/`init`,
      // `assistant` with message.content[] blocks, `user` tool_result, and a
      // terminal `result` carrying total_cost_usd + the four usage buckets. That
      // is exactly what the claude-family collector in queues/cli-exec/stream.ts
      // already parses, which is why outputFormat below is 'claude-stream-json'
      // and no grok-specific parser exists. Do NOT switch this to
      // `streaming-json`: that is grok's own ACP event shape and nothing reads it.
      '--output-format',
      'streaming-messages-json',
      // Non-interactive tool approval. Headless runs otherwise stall on the first
      // approval prompt with no one to answer it.
      '--always-approve',
      // The image pins a version; let neither a run nor a background check move it.
      '--no-auto-update',
    ];
    // Grok's OWN sandbox (Landlock/seccomp) is deliberately never requested: it
    // defaults to off, and Haive's per-task Docker container is already the
    // boundary. Nesting it would only restrict writes inside a container that is
    // itself disposable.

    // The provider's model field wins so the UI picker is authoritative, then the
    // catalog default — grok's own default is a different model family
    // (grok-4.20-*-non-reasoning), so omitting -m would silently contradict the
    // model the catalog advertises and the form shows.
    const model = provider.model ?? this.defaultModel;
    if (model) args.push('-m', model);

    // Deny-list. Haive passes ['Agent'] for onboarding mining so a mining agent
    // cannot fan out into its own subagents. grok accepts the same `Agent` and
    // `Agent(type)` entries Claude Code does; verified that it drops
    // `spawn_subagent` from the session's advertised tool list.
    if (opts.disallowedTools && opts.disallowedTools.length > 0) {
      args.push('--disallowed-tools', opts.disallowedTools.join(','));
    }
    // Allow-list emptied: the model answers from the prompt alone with no repo
    // crawl. Same intent as the claude-family `--tools ""`.
    if (opts.disableTools) {
      args.push('--tools', '');
    }

    // Prompt last, mirroring the antigravity adapter: keep every flag ahead of the
    // value-taking `-p` so none can be mistaken for part of the prompt.
    args.push('-p', prompt);

    return {
      command: this.resolveExecutable(provider),
      args: this.mergedArgs(provider, args),
      env,
      cwd: opts.cwd,
      outputFormat: 'claude-stream-json',
    };
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
      .map((lang) => GROK_LSP_PLUGINS[lang === 'php-extended' ? 'php' : lang])
      .filter((v): v is string => !!v);
    const uniqueLsp = [...new Set(lspPlugins)];
    // `--trust` on every install: grok keeps a plugin's hooks and MCP servers
    // INACTIVE until the plugin is trusted, so an untrusted LSP plugin installs
    // successfully and then does nothing. The claude-family adapters need no
    // equivalent because Claude Code has no such gate.
    if (uniqueLsp.length > 0) {
      cmds.push({
        description: `Add ${GROK_LSP_MARKETPLACE_REF} marketplace`,
        command: exec,
        args: ['plugin', 'marketplace', 'add', GROK_LSP_MARKETPLACE_REF],
      });
      for (const name of uniqueLsp) {
        cmds.push({
          description: `Install LSP plugin ${name}`,
          command: exec,
          args: ['plugin', 'install', `${name}@${GROK_LSP_MARKETPLACE_ID}`, '--trust'],
        });
      }
    }
    if (opts.drupalLspPath) {
      // The qualifier is the FOLDER BASENAME, not the `name` inside
      // `.claude-plugin/marketplace.json`. This is the one place grok and claude-code
      // genuinely diverge on the Claude plugin format, so do not "unify" it with
      // claude-code's `drupal-php-lsp@drupal-lsp-marketplace`: grok registers a LOCAL
      // marketplace source under the directory it was added from, and installing against
      // the manifest name fails with `Unknown marketplace "drupal-lsp-marketplace".
      // Registered marketplaces: - drupal-php-lsp (local/drupal-php-lsp)`. Measured
      // against grok 1.0.3. The REMOTE marketplace above needs no such treatment —
      // `claude-code-lsps` is already the repo basename grok derives.
      const localMarketplaceId = posix.basename(opts.drupalLspPath);
      cmds.push({
        description: 'Add local drupal-lsp marketplace',
        command: exec,
        args: ['plugin', 'marketplace', 'add', opts.drupalLspPath],
      });
      cmds.push({
        description: 'Install drupal-php-lsp plugin',
        command: exec,
        args: ['plugin', 'install', `drupal-php-lsp@${localMarketplaceId}`, '--trust'],
      });
    }
    return cmds;
  }
}
