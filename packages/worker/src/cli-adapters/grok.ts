import { posix } from 'node:path';
import { SANDBOX_USER_HOME } from '../sandbox/sandbox-identity.js';
import { BaseCliAdapter } from './base-adapter.js';
import type {
  CliCommandSpec,
  CliProviderRecord,
  InvokeOpts,
  PluginInstallCommand,
  PluginInstallOpts,
} from './types.js';
import { deliverPrompt } from './prompt-delivery.js';

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

/** grok loads project skills and project instructions only in a TRUSTED folder, and a headless
 *  run is never trusted: MEASURED on 1.0.34, every grok run listed 0 repo skills and no AGENTS.md.
 *  Turning the gate off (worktrees included; a `--trust` grant would persist into the auth volume
 *  and skip a nested checkout) also ungates the repo's Claude-compat hooks, which stay off: Haive
 *  keeps rtk's `.claude/settings.json` hook off grok on purpose (see _rtk-templates.ts). */
const GROK_PROJECT_CONTEXT_ENV: Readonly<Record<string, string>> = {
  GROK_FOLDER_TRUST: '0',
  GROK_CLAUDE_HOOKS_ENABLED: '0',
};

/** grok lists its own 23 bundled skills (9,008 chars, one of them steering apps toward xAI) beside
 *  the repo's. `[skills] ignore` hides them; it lives in grok's MANAGED config layer, read from
 *  outside the auth volume, so Haive never merges into the `config.toml` grok writes itself.
 *  MEASURED: skills block 11,417 -> 2,388 chars, repo skills intact. */
const GROK_MANAGED_CONFIG = {
  containerPath: '/etc/grok/managed_config.toml',
  content: `[skills]\nignore = ["${SANDBOX_USER_HOME}/.grok/bundled/skills"]\n`,
};

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
  override readonly supportsDisableTools = true;
  // Kept in sync with the catalog entry, which uses this as a CAPABILITY flag
  // rather than a mere default: 'subscription' is what allows a provider row to
  // be saved in either mode (api_key stays legal because apiKeyEnvName is set).
  // A SuperGrok sign-in goes through `grok login --device-auth`
  // (setup-token-command); assertUserAuthReady short-circuits for api_key rows,
  // so neither mode forces a login the other way.
  readonly defaultAuthMode = 'subscription' as const;
  // grok reads this env var directly; no remap needed (contrast zai/muse, which
  // have to alias their key onto ANTHROPIC_AUTH_TOKEN).
  readonly apiKeyEnvName = 'XAI_API_KEY';
  readonly defaultModel = 'grok-build-0.1';
  // grok reads AGENTS.md natively (and CLAUDE.md too, for Claude Code compat), so
  // step 07 appends its rules block straight to the shared repo-root AGENTS.md.
  readonly rulesFile = 'AGENTS.md';
  readonly rulesFileMode = 'native' as const;
  // accounts.x.ai is the DEVICE-CODE endpoint, captured from a real
  // `grok login --device-auth` run (it prints
  // https://accounts.x.ai/oauth2/device?user_code=XXXX-XXXX) and confirmed as a
  // literal in the binary. Without it a login under network policy
  // none/allowlist cannot reach the authorization server.
  override readonly defaultEgressDomains = ['api.x.ai', 'accounts.x.ai', 'auth.x.ai', 'grok.com'];

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
    const env = { ...GROK_PROJECT_CONTEXT_ENV, ...this.mergedEnv(provider, opts) };
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
    // `-p, --single <PROMPT>` takes a value, and grok's REPL needs a TTY, so
    // stdin is not a route (verified: bare `grok` with piped input dies with
    // ENXIO). It does offer `--prompt-file`, which has no size limit — verified
    // against the real binary with a live call. The `-p` is dropped entirely in
    // that mode; the two are alternative ways to say the same thing.
    const delivery = deliverPrompt(prompt, {
      adapter: 'grok',
      stdin: false,
      fileFlag: '--prompt-file',
    });
    if (delivery.promptFile) args.push(...delivery.argv);
    else args.push('-p', ...delivery.argv);

    return {
      command: this.resolveExecutable(provider),
      args: this.mergedArgs(provider, args),
      ...(delivery.promptFile ? { promptFile: delivery.promptFile } : {}),
      configFiles: [GROK_MANAGED_CONFIG],
      env,
      cwd: opts.cwd,
      outputFormat: 'claude-stream-json',
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
