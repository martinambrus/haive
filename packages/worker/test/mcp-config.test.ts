import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  buildDefaultMcpServers,
  buildMcpConfigForCli,
  type McpServerSpec,
} from '../src/sandbox/mcp-config.js';
import { injectMcpConfig } from '../src/sandbox/mcp-injector.js';

const sampleServers: McpServerSpec[] = [
  {
    name: 'filesystem',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace/repo'],
  },
  {
    name: 'git',
    command: 'uvx',
    args: ['mcp-server-git', '--repository', '/workspace/repo'],
  },
];

describe('buildDefaultMcpServers', () => {
  it('returns filesystem and git by default', () => {
    const servers = buildDefaultMcpServers({ repoPath: '/workspace/repo' });
    const names = servers.map((s) => s.name);
    expect(names).toEqual(['filesystem', 'git']);
    expect(servers[0]?.args).toContain('/workspace/repo');
    expect(servers[1]?.args).toContain('/workspace/repo');
  });

  it('includes the postgres server when a databaseUrl is supplied', () => {
    const servers = buildDefaultMcpServers({
      repoPath: '/workspace/repo',
      databaseUrl: 'postgres://user:pass@db:5432/haive',
    });
    const pg = servers.find((s) => s.name === 'postgres');
    expect(pg).toBeDefined();
    expect(pg?.args).toContain('postgres://user:pass@db:5432/haive');
  });

  it('omits filesystem and git when explicitly disabled', () => {
    const servers = buildDefaultMcpServers({
      repoPath: '/workspace/repo',
      includeFilesystem: false,
      includeGit: false,
      databaseUrl: 'postgres://db',
    });
    expect(servers.map((s) => s.name)).toEqual(['postgres']);
  });
});

describe('buildMcpConfigForCli', () => {
  it('emits claude-code JSON to a standalone path with --mcp-config + --strict-mcp-config flags', () => {
    const config = buildMcpConfigForCli('claude-code', sampleServers);
    expect(config?.path).toBe('/haive/mcp.json');
    expect(config?.format).toBe('json');
    expect(config?.cliArgs).toEqual(['--mcp-config', '/haive/mcp.json', '--strict-mcp-config']);
    const parsed = JSON.parse(config!.content);
    expect(parsed.mcpServers.filesystem.command).toBe('npx');
    expect(parsed.mcpServers.git.args).toContain('--repository');
  });

  it('ignores targetHome for claude-code (path is fixed to avoid colliding with /home/node/.claude.json)', () => {
    const config = buildMcpConfigForCli('claude-code', sampleServers, '/root');
    expect(config?.path).toBe('/haive/mcp.json');
  });

  it('emits zai config to the same standalone path as claude-code (claude binary wrapper)', () => {
    const config = buildMcpConfigForCli('zai', sampleServers);
    expect(config?.path).toBe('/haive/mcp.json');
    expect(config?.format).toBe('json');
    expect(config?.cliArgs).toEqual(['--mcp-config', '/haive/mcp.json', '--strict-mcp-config']);
  });

  it('emits gemini JSON to ~/.gemini/settings.json', () => {
    const config = buildMcpConfigForCli('gemini', sampleServers);
    expect(config?.path).toBe('/home/claude/.gemini/settings.json');
    const parsed = JSON.parse(config!.content);
    expect(parsed.mcpServers.filesystem).toBeDefined();
  });

  it('does NOT attach cliArgs for gemini or codex (they auto-discover their config files)', () => {
    // Only claude-code/zai use the standalone /haive/mcp.json bind-mount and
    // therefore need --mcp-config to point the binary at it. Gemini reads
    // settings.json from the auth volume; codex reads ~/.codex/config.toml
    // automatically. Attaching cliArgs here would erroneously inject a
    // claude-code flag into the wrong binary.
    expect(buildMcpConfigForCli('gemini', sampleServers)?.cliArgs).toBeUndefined();
    expect(buildMcpConfigForCli('codex', sampleServers)?.cliArgs).toBeUndefined();
  });

  it('emits codex TOML with [mcp_servers.<name>] sections', () => {
    const config = buildMcpConfigForCli('codex', sampleServers);
    expect(config?.path).toBe('/home/claude/.codex/config.toml');
    expect(config?.format).toBe('toml');
    expect(config?.content).toContain('[mcp_servers.filesystem]');
    expect(config?.content).toContain('[mcp_servers.git]');
    expect(config?.content).toContain('command = "npx"');
    expect(config?.content).toMatch(/args = \["-y", "@modelcontextprotocol\/server-filesystem"/);
  });

  it('emits TOML env tables when servers carry env vars', () => {
    const config = buildMcpConfigForCli('codex', [
      {
        name: 'postgres',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-postgres'],
        env: { DATABASE_URL: 'postgres://db' },
      },
    ]);
    expect(config?.content).toContain('[mcp_servers.postgres.env]');
    expect(config?.content).toContain('DATABASE_URL = "postgres://db"');
  });

  it('returns null for CLIs without documented MCP support', () => {
    expect(buildMcpConfigForCli('amp', sampleServers)).toBeNull();
  });

  it('returns null when the server list is empty', () => {
    expect(buildMcpConfigForCli('claude-code', [])).toBeNull();
  });
});

describe('injectMcpConfig', () => {
  function createFakeContainer(execExitCode = 0) {
    const calls: Array<{ cmd: string[]; stdin: string }> = [];
    const container = {
      exec: async (opts: { Cmd: string[] }) => {
        const captured = { cmd: opts.Cmd, stdin: '' };
        calls.push(captured);
        return {
          start: async (_startOpts: { hijack: boolean; stdin: boolean }) => {
            const stream = new EventEmitter() as EventEmitter & {
              write: (chunk: string) => void;
              end: () => void;
              resume: () => void;
            };
            stream.write = (chunk: string) => {
              captured.stdin += chunk;
            };
            stream.end = () => {
              setImmediate(() => stream.emit('end'));
            };
            stream.resume = () => {
              setImmediate(() => stream.emit('end'));
            };
            return stream;
          },
          inspect: async () => ({ ExitCode: execExitCode }),
        };
      },
    };
    return { container, calls };
  }

  it('skips for CLIs without MCP support', async () => {
    const { container, calls } = createFakeContainer();
    const result = await injectMcpConfig({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      container: container as any,
      cliProvider: 'amp',
      servers: sampleServers,
    });
    expect(result.skipped).toBe(true);
    expect(result.written).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('writes JSON config for claude-code with mkdir -p and cat > path', async () => {
    const { container, calls } = createFakeContainer();
    const result = await injectMcpConfig({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      container: container as any,
      cliProvider: 'claude-code',
      servers: sampleServers,
    });
    expect(result.written).toBe('/haive/mcp.json');
    expect(result.skipped).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.cmd).toEqual(['mkdir', '-p', '/haive']);
    expect(calls[1]?.cmd[0]).toBe('sh');
    expect(calls[1]?.cmd[2]).toContain(`cat > '/haive/mcp.json'`);
    const parsed = JSON.parse(calls[1]?.stdin ?? '{}');
    expect(parsed.mcpServers.filesystem.command).toBe('npx');
  });

  it('writes TOML config for codex via sh -c cat', async () => {
    const { container, calls } = createFakeContainer();
    const result = await injectMcpConfig({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      container: container as any,
      cliProvider: 'codex',
      servers: sampleServers,
    });
    expect(result.written).toBe('/home/claude/.codex/config.toml');
    expect(calls[0]?.cmd).toEqual(['mkdir', '-p', '/home/claude/.codex']);
    expect(calls[1]?.stdin).toContain('[mcp_servers.filesystem]');
  });

  it('reports failure when the write exec returns a non-zero exit code', async () => {
    const { container } = createFakeContainer(1);
    const result = await injectMcpConfig({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      container: container as any,
      cliProvider: 'claude-code',
      servers: sampleServers,
    });
    expect(result.written).toBeNull();
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('exit 1');
  });
});
