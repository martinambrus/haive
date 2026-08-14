import type { CliProviderName } from '@haive/shared';

const EMPTY_MCP_SETTINGS = '{\n  "mcpServers": {}\n}\n';

/** Resolve `.claude/mcp_settings.json` body for a given user-supplied
 *  textarea value. Empty/whitespace input is rewritten to an empty-but-valid
 *  `{"mcpServers": {}}` stub so CLI providers that pass `--mcp-config` don't
 *  fail with "Invalid MCP configuration: Does not adhere to MCP server
 *  configuration schema" on a missing or empty file. Non-empty input is
 *  preserved verbatim with a trailing newline. */
export function mcpSettingsFileContent(input: string): string {
  if (input.trim().length === 0) return EMPTY_MCP_SETTINGS;
  return input.endsWith('\n') ? input : input + '\n';
}

export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * How a CLI's MCP configuration is allowed to reach the sandbox.
 *
 * - `bind`: the file is Haive-owned and lives OUTSIDE any auth-volume mount, so it can be
 *   bind-mounted (cli-exec) or written wholesale (terminal).
 * - `cli-merge`: the file is the CLI's OWN config, it sits INSIDE the auth-volume mount, and it
 *   holds state Haive does not own — grok keeps `[[marketplace.sources]]` and `[plugins]` there,
 *   codex keeps user settings. Merge it with the CLI's own `mcp add` / `mcp remove`.
 * - `volume-merge`: same nesting, but the CLI has no `mcp add` subcommand (gemini), so the merge
 *   is performed on the file itself.
 * - `volume-write`: nested too, but the file holds NOTHING except MCP servers (antigravity), so
 *   Haive owns it outright and writes it whole — into the volume, still never over it.
 *
 * Bind-mounting a path nested inside a named-volume mount is what this field exists to prevent.
 * Docker materialises the missing mount target INSIDE the volume as a root-owned stub that
 * outlives the container, so the CLI (uid 1000) can no longer write its own config — and the
 * mount hides whatever else the file held for as long as it is in place.
 */
export type McpDelivery = 'bind' | 'cli-merge' | 'volume-merge' | 'volume-write';

export interface McpConfigFile {
  path: string;
  content: string;
  format: 'json' | 'toml';
  delivery: McpDelivery;
  /** Extra CLI args the caller must append so the binary actually picks up
   *  the bind-mounted file (e.g. claude-code's `--mcp-config <path>`). */
  cliArgs?: string[];
}

export interface BuildDefaultMcpServersOptions {
  repoPath: string;
  databaseUrl?: string;
  includeFilesystem?: boolean;
  includeGit?: boolean;
  includeChromeDevtools?: boolean;
  /** When set, chrome-devtools connects to this already-running browser's CDP
   *  endpoint (the headed Chrome on the task's DDEV runner desktop) instead of
   *  launching its own isolated headless instance — so the agent drives the
   *  SAME browser the user watches/assists via the VNC panel. */
  chromeDevtoolsBrowserUrl?: string;
  /** Pin the chrome-devtools-mcp npm version the agent launches via `npx`. This
   *  is the OPERATIVE pin (Haive's injected server overrides the user's on name
   *  collision). Empty/absent = `@latest`. */
  chromeDevtoolsMcpVersion?: string | null;
  /** Enable the haive-rag MCP server (project RAG retrieval). Requires
   *  ragServerPath, ragApiUrl, and ragToken to also be set. */
  includeRagSearch?: boolean;
  /** Container path of the bind-mounted haive-rag MCP server script. */
  ragServerPath?: string;
  /** Base URL of the Haive API the rag proxy calls (e.g. http://api:3001). */
  ragApiUrl?: string;
  /** Task-scoped bearer token the rag proxy presents to the API. */
  ragToken?: string;
  /** Whether the resolved CLI can use Haive's LSP integration. Passed to the
   *  RAG tool so its model-visible grounding guidance never advertises an
   *  unavailable navigation surface. */
  ragLspAvailable?: boolean;
  /** Enable the ddev-control MCP server (ddev_status/ddev_logs/ddev_restart via the
   *  API). Requires ddevControlServerPath, ddevApiUrl, and ddevToken to also be set. */
  includeDdevControl?: boolean;
  /** Container path of the bind-mounted ddev-control MCP server script. */
  ddevControlServerPath?: string;
  /** Base URL of the Haive API the ddev proxy calls (e.g. http://api:3001). */
  ddevApiUrl?: string;
  /** Task-scoped bearer token the ddev proxy presents to the API. */
  ddevToken?: string;
}

/** Chromium binary path inside browserTesting sandboxes. The env-template
 *  Dockerfile (02-generate-dockerfile.ts) installs it here and exports it as
 *  CHROME_PATH. chrome-devtools-mcp honors no env var for the binary, so the
 *  headless self-launch must pass it explicitly via --executable-path
 *  (--channel=stable looks for Google Chrome, absent on Debian). Keep in sync
 *  with the Dockerfile install path. */
const SANDBOX_CHROME_PATH = '/usr/bin/chromium';

export function buildDefaultMcpServers(opts: BuildDefaultMcpServersOptions): McpServerSpec[] {
  const servers: McpServerSpec[] = [];
  const includeFs = opts.includeFilesystem !== false;
  const includeGit = opts.includeGit !== false;

  if (includeFs) {
    servers.push({
      name: 'filesystem',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', opts.repoPath],
    });
  }

  if (includeGit) {
    servers.push({
      name: 'git',
      command: 'uvx',
      args: ['mcp-server-git', '--repository', opts.repoPath],
    });
  }

  if (opts.databaseUrl) {
    servers.push({
      name: 'postgres',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-postgres', opts.databaseUrl],
    });
  }

  if (opts.includeChromeDevtools) {
    // Connect to the runner's visible browser when its CDP URL is provided
    // (interactive/co-driven testing); otherwise self-launch a headless Chromium
    // in the sandbox. The sandbox has no X display, so --headless is required;
    // and chrome-devtools-mcp must be pointed at the installed binary via
    // --executable-path — --channel=stable looks for Google Chrome, which the
    // Debian sandbox lacks (the cause of past "Could not connect to Chrome").
    const cdmSpec = `chrome-devtools-mcp@${opts.chromeDevtoolsMcpVersion?.trim() || 'latest'}`;
    const chromeArgs = opts.chromeDevtoolsBrowserUrl
      ? ['-y', cdmSpec, `--browser-url=${opts.chromeDevtoolsBrowserUrl}`]
      : [
          '-y',
          cdmSpec,
          `--executable-path=${SANDBOX_CHROME_PATH}`,
          '--headless=true',
          '--isolated=true',
          '--viewport=1920x1080',
        ];
    servers.push({ name: 'chrome-devtools', command: 'npx', args: chromeArgs });
  }

  if (opts.includeRagSearch && opts.ragServerPath && opts.ragApiUrl && opts.ragToken) {
    servers.push({
      name: 'haive-rag',
      command: 'node',
      args: [opts.ragServerPath],
      env: {
        RAG_API_URL: opts.ragApiUrl,
        RAG_TASK_TOKEN: opts.ragToken,
        HAIVE_LSP_AVAILABLE: opts.ragLspAvailable ? '1' : '0',
      },
    });
  }

  if (opts.includeDdevControl && opts.ddevControlServerPath && opts.ddevApiUrl && opts.ddevToken) {
    servers.push({
      name: 'ddev-control',
      command: 'node',
      args: [opts.ddevControlServerPath],
      env: {
        DDEV_API_URL: opts.ddevApiUrl,
        DDEV_TASK_TOKEN: opts.ddevToken,
      },
    });
  }

  return servers;
}

/** Standalone path for claude-code/zai MCP bind-mount. Avoids `/home/node/.claude.json`
 *  because that path collides with the image-baked seed (`hasCompletedOnboarding=true,
 *  theme=dark`); shadowing it with an MCP-only file makes the CLI think onboarding is
 *  incomplete and hang on first run. Caller must pair this with `--mcp-config <path>
 *  --strict-mcp-config` so the binary picks up the file and ignores other locations. */
export const CLAUDE_MCP_CONFIG_PATH = '/haive/mcp.json';

/** User-supplied MCP servers (the `mcpServers` object from the repo's
 *  `.claude/mcp_settings.json`). Values are passed through verbatim for the JSON
 *  formats so url/sse servers survive; the codex TOML serializer can only render
 *  stdio (command-based) entries. */
export type UserMcpServers = Record<string, unknown>;

export function buildMcpConfigForCli(
  cliProvider: CliProviderName,
  servers: McpServerSpec[],
  targetHome = '/home/claude',
  userServers: UserMcpServers = {},
): McpConfigFile | null {
  if (servers.length === 0 && Object.keys(userServers).length === 0) return null;

  switch (cliProvider) {
    case 'claude-code':
    case 'zai':
    case 'ollama':
    case 'muse':
      return {
        path: CLAUDE_MCP_CONFIG_PATH,
        format: 'json',
        // Standalone path under /haive, outside every auth mount — safe to bind.
        delivery: 'bind',
        content: JSON.stringify({ mcpServers: serversToJsonObject(servers, userServers) }, null, 2),
        cliArgs: ['--mcp-config', CLAUDE_MCP_CONFIG_PATH, '--strict-mcp-config'],
      };

    case 'gemini':
      return {
        path: `${targetHome}/.gemini/settings.json`,
        format: 'json',
        // Same file that holds `selectedAuthType`, inside the ~/.gemini auth mount, and gemini
        // has no `mcp add` — merge the file in place.
        delivery: 'volume-merge',
        content: JSON.stringify({ mcpServers: serversToJsonObject(servers, userServers) }, null, 2),
      };

    case 'codex':
      return {
        path: `${targetHome}/.codex/config.toml`,
        format: 'toml',
        // Inside the ~/.codex auth mount and shared with codex's own settings.
        delivery: 'cli-merge',
        content: serversToCodexToml(servers, userServers),
      };

    case 'grok':
      // grok declares MCP servers as `[mcp_servers.<name>]` blocks with
      // command/args/env — the same TOML shape codex uses, so the codex
      // serializer is reused verbatim rather than duplicated. It carries the same
      // limitation: stdio (command-based) entries only, so a url/sse user server
      // is dropped for grok exactly as it is for codex.
      return {
        path: `${targetHome}/.grok/config.toml`,
        format: 'toml',
        // Inside the ~/.grok auth mount, and the SAME file `01b-install-plugins` writes its
        // marketplace source + enabled plugins into. Binding an MCP-only body over it left a
        // root-owned stub in the volume (`Permission denied (os error 13)` on the next plugin
        // install) and hid the plugin registration from every run that had the bind.
        delivery: 'cli-merge',
        content: serversToCodexToml(servers, userServers),
      };

    case 'amp':
      return null;

    case 'antigravity':
      // Antigravity reads MCP servers from a dedicated file (separate from its
      // auth token), per docs at ~/.gemini/antigravity-cli/mcp_config.json.
      // NOTE: a real agy run also created ~/.gemini/config/mcp_config.json —
      // confirm the actual read path during MCP testing. The path sits inside the
      // antigravity-cli auth mount, so it is written INTO the volume rather than
      // bind-mounted over it; the file holds nothing but MCP servers, so Haive
      // owns it whole and no merge is needed.
      return {
        path: `${targetHome}/.gemini/antigravity-cli/mcp_config.json`,
        format: 'json',
        delivery: 'volume-write',
        content: JSON.stringify({ mcpServers: serversToJsonObject(servers, userServers) }, null, 2),
      };

    default: {
      const _exhaustive: never = cliProvider;
      return _exhaustive;
    }
  }
}

/** Merge Haive's default servers with the user's custom servers into the
 *  `mcpServers` object. The union is additive; on a name collision Haive's
 *  reserved server wins so `haive-rag` (and filesystem/git/chrome-devtools) are
 *  always available regardless of what the user configured. */
export function serversToJsonObject(
  servers: McpServerSpec[],
  userServers: UserMcpServers = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // User servers first; Haive defaults below override on name collision.
  for (const [name, def] of Object.entries(userServers)) {
    if (def && typeof def === 'object') out[name] = def;
  }
  for (const server of servers) {
    const entry: { command: string; args: string[]; env?: Record<string, string> } = {
      command: server.command,
      args: server.args,
    };
    if (server.env && Object.keys(server.env).length > 0) {
      entry.env = server.env;
    }
    out[server.name] = entry;
  }
  return out;
}

function codexTomlBlock(
  name: string,
  command: string,
  args: string[],
  env?: Record<string, string>,
): string {
  const lines: string[] = [`[mcp_servers.${name}]`];
  lines.push(`command = ${tomlString(command)}`);
  lines.push(`args = [${args.map(tomlString).join(', ')}]`);
  if (env && Object.keys(env).length > 0) {
    const envLines = Object.entries(env).map(([key, val]) => `${key} = ${tomlString(val)}`);
    lines.push('', `[mcp_servers.${name}.env]`, ...envLines);
  }
  return lines.join('\n');
}

/**
 * The stdio servers a TOML-config CLI actually ends up with: user-defined entries first (skipping
 * name collisions with Haive's own, and skipping non-stdio entries — this format renders only
 * command-based servers), then Haive's.
 *
 * ONE definition, two consumers: the TOML renderer below and the `mcp add` argv builder. A
 * `cli-merge` provider reaches the same servers through a different mechanism than a `bind` one,
 * and the set they disagree on would be invisible until an agent asked for a missing tool.
 */
export function resolveStdioMcpServers(
  servers: McpServerSpec[],
  userServers: UserMcpServers = {},
): McpServerSpec[] {
  const haiveNames = new Set(servers.map((s) => s.name));
  const resolved: McpServerSpec[] = [];
  for (const [name, defRaw] of Object.entries(userServers)) {
    if (haiveNames.has(name)) continue;
    const def = defRaw as { command?: unknown; args?: unknown; env?: unknown };
    if (typeof def?.command !== 'string') continue;
    const args = Array.isArray(def.args)
      ? def.args.filter((a): a is string => typeof a === 'string')
      : [];
    const env =
      def.env && typeof def.env === 'object'
        ? (Object.fromEntries(
            Object.entries(def.env as Record<string, unknown>).filter(
              ([, v]) => typeof v === 'string',
            ),
          ) as Record<string, string>)
        : undefined;
    resolved.push({ name, command: def.command, args, ...(env ? { env } : {}) });
  }
  resolved.push(...servers);
  return resolved;
}

function serversToCodexToml(servers: McpServerSpec[], userServers: UserMcpServers = {}): string {
  const blocks = resolveStdioMcpServers(servers, userServers).map((s) =>
    codexTomlBlock(s.name, s.command, s.args, s.env),
  );
  return `${blocks.join('\n\n')}\n`;
}

/**
 * argv AFTER the binary for one `<cli> mcp add`, or null for a CLI with no such subcommand.
 *
 * The two orderings are MEASURED against grok 1.0.3 and codex 0.147.0, not inferred from the
 * shared TOML shape: grok takes `mcp add [-s user] [-e K=V]… <name> <command> -- <args…>`, codex
 * takes `mcp add [--env K=V]… <name> -- <command> <args…>`. The `--` is load-bearing in both —
 * server args routinely start with a flag (`npx -y …`) and are otherwise parsed as the CLI's own.
 */
export function buildMcpAddArgv(cliProvider: CliProviderName, server: McpServerSpec): string[] {
  const env = Object.entries(server.env ?? {});
  if (cliProvider === 'grok') {
    const argv = ['mcp', 'add', '-s', 'user'];
    for (const [key, value] of env) argv.push('-e', `${key}=${value}`);
    argv.push(server.name, server.command);
    if (server.args.length > 0) argv.push('--', ...server.args);
    return argv;
  }
  const argv = ['mcp', 'add'];
  for (const [key, value] of env) argv.push('--env', `${key}=${value}`);
  argv.push(server.name, '--', server.command, ...server.args);
  return argv;
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
