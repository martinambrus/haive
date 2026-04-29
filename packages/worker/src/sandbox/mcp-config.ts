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
}

export interface BuildDefaultMcpServersOptions {
  repoPath: string;
  databaseUrl?: string;
  includeFilesystem?: boolean;
  includeGit?: boolean;
  includeChromeDevtools?: boolean;
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
    servers.push({
      name: 'chrome-devtools',
      command: 'npx',
      args: [
        '-y',
        'chrome-devtools-mcp@latest',
        '--channel=stable',
        '--isolated=true',
        '--viewport=1920x1080',
      ],
    });
  }

  return servers;
}

export function buildMcpConfigForCli(
  cliProvider: CliProviderName,
  servers: McpServerSpec[],
  targetHome = '/home/claude',
): McpConfigFile | null {
  if (servers.length === 0) return null;

  switch (cliProvider) {
    case 'claude-code':
    case 'zai':
      return {
        path: `${targetHome}/.claude.json`,
        format: 'json',
        content: JSON.stringify({ mcpServers: serversToJsonObject(servers) }, null, 2),
      };

    case 'gemini':
      return {
        path: `${targetHome}/.gemini/settings.json`,
        format: 'json',
        content: JSON.stringify({ mcpServers: serversToJsonObject(servers) }, null, 2),
      };

    case 'codex':
      return {
        path: `${targetHome}/.codex/config.toml`,
        format: 'toml',
        content: serversToCodexToml(servers),
      };

    case 'amp':
      return null;

    default: {
      const _exhaustive: never = cliProvider;
      return _exhaustive;
    }
  }
}

function serversToJsonObject(
  servers: McpServerSpec[],
): Record<string, { command: string; args: string[]; env?: Record<string, string> }> {
  const out: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};
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

function serversToCodexToml(servers: McpServerSpec[]): string {
  const blocks: string[] = [];
  for (const server of servers) {
    const lines: string[] = [`[mcp_servers.${server.name}]`];
    lines.push(`command = ${tomlString(server.command)}`);
    lines.push(`args = [${server.args.map(tomlString).join(', ')}]`);
    if (server.env && Object.keys(server.env).length > 0) {
      const envLines = Object.entries(server.env).map(
        ([key, val]) => `${key} = ${tomlString(val)}`,
      );
      lines.push('', `[mcp_servers.${server.name}.env]`, ...envLines);
    }
    blocks.push(lines.join('\n'));
  }
  return `${blocks.join('\n\n')}\n`;
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
