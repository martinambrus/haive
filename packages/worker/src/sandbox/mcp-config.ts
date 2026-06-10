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

export interface McpConfigFile {
  path: string;
  content: string;
  format: 'json' | 'toml';
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
  /** Enable the haive-rag MCP server (project RAG retrieval). Requires
   *  ragServerPath, ragApiUrl, and ragToken to also be set. */
  includeRagSearch?: boolean;
  /** Container path of the bind-mounted haive-rag MCP server script. */
  ragServerPath?: string;
  /** Base URL of the Haive API the rag proxy calls (e.g. http://api:3001). */
  ragApiUrl?: string;
  /** Task-scoped bearer token the rag proxy presents to the API. */
  ragToken?: string;
}

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
    // (interactive/co-driven testing); otherwise self-launch an isolated
    // headless instance (the default automated path).
    const chromeArgs = opts.chromeDevtoolsBrowserUrl
      ? ['-y', 'chrome-devtools-mcp@latest', `--browser-url=${opts.chromeDevtoolsBrowserUrl}`]
      : [
          '-y',
          'chrome-devtools-mcp@latest',
          '--channel=stable',
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
      return {
        path: CLAUDE_MCP_CONFIG_PATH,
        format: 'json',
        content: JSON.stringify({ mcpServers: serversToJsonObject(servers, userServers) }, null, 2),
        cliArgs: ['--mcp-config', CLAUDE_MCP_CONFIG_PATH, '--strict-mcp-config'],
      };

    case 'gemini':
      return {
        path: `${targetHome}/.gemini/settings.json`,
        format: 'json',
        content: JSON.stringify({ mcpServers: serversToJsonObject(servers, userServers) }, null, 2),
      };

    case 'codex':
      return {
        path: `${targetHome}/.codex/config.toml`,
        format: 'toml',
        content: serversToCodexToml(servers, userServers),
      };

    case 'amp':
      return null;

    case 'antigravity':
      // Antigravity reads MCP servers from a dedicated file (separate from its
      // auth token), per docs at ~/.gemini/antigravity-cli/mcp_config.json.
      // NOTE: a real agy run also created ~/.gemini/config/mcp_config.json —
      // confirm the actual read path during MCP testing. For task runs this is
      // written into the auth volume (resolveMcpExtraFiles) rather than
      // bind-mounted, to avoid a file mount nested inside the antigravity-cli
      // auth-volume mount.
      return {
        path: `${targetHome}/.gemini/antigravity-cli/mcp_config.json`,
        format: 'json',
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

function serversToCodexToml(servers: McpServerSpec[], userServers: UserMcpServers = {}): string {
  const blocks: string[] = [];
  const haiveNames = new Set(servers.map((s) => s.name));
  // User stdio servers first (skip name collisions with Haive defaults, and
  // skip non-stdio entries — Codex TOML here only renders command-based servers).
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
    blocks.push(codexTomlBlock(name, def.command, args, env));
  }
  for (const server of servers) {
    blocks.push(codexTomlBlock(server.name, server.command, server.args, server.env));
  }
  return `${blocks.join('\n\n')}\n`;
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
