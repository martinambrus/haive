import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CHROME_MCP_TOOL_TIMEOUT_MS } from '@haive/shared';
import { getCliProviderMetadata } from '@haive/shared';
import {
  buildDefaultMcpServers,
  buildMcpAddArgv,
  buildMcpConfigForCli,
  resolveStdioMcpServers,
  serversToJsonObject,
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

  it('includes the ddev-control server when enabled with its path/url/token', () => {
    const servers = buildDefaultMcpServers({
      repoPath: '/workspace/repo',
      includeDdevControl: true,
      ddevControlServerPath: '/haive/haive-ddev-mcp.mjs',
      ddevApiUrl: 'http://api:3001',
      ddevToken: 'tok-123',
    });
    const ddev = servers.find((s) => s.name === 'ddev-control');
    expect(ddev?.command).toBe('node');
    expect(ddev?.args).toEqual(['/haive/haive-ddev-mcp.mjs']);
    expect(ddev?.env).toEqual({ DDEV_API_URL: 'http://api:3001', DDEV_TASK_TOKEN: 'tok-123' });
  });

  it('omits ddev-control when disabled or missing its token/path', () => {
    expect(
      buildDefaultMcpServers({ repoPath: '/r', includeDdevControl: false }).find(
        (s) => s.name === 'ddev-control',
      ),
    ).toBeUndefined();
    // all four fields are required — enabled but no token → still omitted
    expect(
      buildDefaultMcpServers({
        repoPath: '/r',
        includeDdevControl: true,
        ddevControlServerPath: '/haive/haive-ddev-mcp.mjs',
        ddevApiUrl: 'http://api:3001',
      }).find((s) => s.name === 'ddev-control'),
    ).toBeUndefined();
  });

  it('caps chrome-devtools tool calls, and only that server', () => {
    const servers = buildDefaultMcpServers({
      repoPath: '/workspace/repo',
      includeChromeDevtools: true,
    });
    const chrome = servers.find((s) => s.name === 'chrome-devtools');
    expect(chrome?.timeout).toBe(DEFAULT_CHROME_MCP_TOOL_TIMEOUT_MS);
    // filesystem/git run local, fast and silent — a cap there would only add a way to fail.
    expect(servers.filter((s) => s.name !== 'chrome-devtools').map((s) => s.timeout)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('opts chrome-devtools out of both Google calls, on both launch paths', () => {
    // Two distinct channels, both on by default upstream: performance traces POST their
    // URLs (here: the task's own .ddev.site hosts and app routes) to the CrUX API, and the
    // telemetry watchdog POSTs to play.googleapis.com. The browser-url path leaks the same
    // trace URLs as the headless one, so neither branch may be left out.
    for (const opts of [
      { repoPath: '/workspace/repo', includeChromeDevtools: true },
      {
        repoPath: '/workspace/repo',
        includeChromeDevtools: true,
        chromeDevtoolsBrowserUrl: 'http://127.0.0.1:9222',
      },
    ]) {
      const chrome = buildDefaultMcpServers(opts).find((s) => s.name === 'chrome-devtools');
      expect(chrome?.args).toContain('--no-performance-crux');
      expect(chrome?.args).toContain('--no-usage-statistics');
      // Independent second lever: the CLI ignores unknown flags silently (exit 0), so a
      // rename upstream would turn the flag above into a no-op with no signal.
      expect(chrome?.env?.CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS).toBe('1');
      // CI is honored by the same upstream check but is read by npm/test runners across
      // the whole sandbox — opting out of telemetry must not change unrelated tooling.
      expect(chrome?.env?.CI).toBeUndefined();
    }
  });

  it('redacts credential headers out of the model-visible network dumps', () => {
    // A different leak from the Google flags: get_network_request otherwise returns raw
    // Cookie/Authorization headers into the model's context, and _app-auth.ts has agents
    // log into the real app, so a session cookie exists by the time browser-verify runs.
    // Upstream is an allow-list, so it fails closed on header names nobody enumerated.
    for (const opts of [
      { repoPath: '/workspace/repo', includeChromeDevtools: true },
      {
        repoPath: '/workspace/repo',
        includeChromeDevtools: true,
        chromeDevtoolsBrowserUrl: 'http://127.0.0.1:9222',
      },
    ]) {
      const chrome = buildDefaultMcpServers(opts).find((s) => s.name === 'chrome-devtools');
      expect(chrome?.args).toContain('--redact-network-headers');
    }
  });

  it('launches chrome-devtools through the body proxy only when one is shipped', () => {
    const withProxy = buildDefaultMcpServers({
      repoPath: '/workspace/repo',
      includeChromeDevtools: true,
      chromeDevtoolsBodyProxyPath: '/haive/haive-chrome-mcp-proxy.mjs',
    }).find((s) => s.name === 'chrome-devtools');
    expect(withProxy?.command).toBe('node');
    // npx stays the inner command, so the version pin and every flag survive the wrap.
    expect(withProxy?.args.slice(0, 3)).toEqual(['/haive/haive-chrome-mcp-proxy.mjs', 'npx', '-y']);
    expect(withProxy?.args).toContain('--redact-network-headers');
    expect(withProxy?.args).toContain('--no-usage-statistics');

    // No proxy path = launch npx directly. 04-tooling-infrastructure renders the user's
    // own .claude/mcp_settings.json from this, and that file must not name a path which
    // exists only inside a Haive sandbox.
    const noProxy = buildDefaultMcpServers({
      repoPath: '/workspace/repo',
      includeChromeDevtools: true,
    }).find((s) => s.name === 'chrome-devtools');
    expect(noProxy?.command).toBe('npx');
    expect(noProxy?.args[0]).toBe('-y');
  });

  it('carries the telemetry opt-out env through to the rendered configs', () => {
    const servers = buildDefaultMcpServers({
      repoPath: '/workspace/repo',
      includeChromeDevtools: true,
    });
    const json = JSON.parse(buildMcpConfigForCli('claude-code', servers)!.content) as {
      mcpServers: Record<string, { env?: Record<string, string>; args?: string[] }>;
    };
    expect(json.mcpServers['chrome-devtools']?.env?.CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS).toBe(
      '1',
    );
    expect(json.mcpServers['chrome-devtools']?.args).toContain('--no-performance-crux');
    // The TOML CLIs reach the same server through a different renderer.
    const toml = buildMcpConfigForCli('codex', servers)!.content;
    expect(toml).toContain('[mcp_servers.chrome-devtools.env]');
    expect(toml).toContain('CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS = "1"');
    expect(toml).toContain('--no-usage-statistics');
  });

  it('drops the cap entirely at 0 rather than emitting a zero timeout', () => {
    const chrome = buildDefaultMcpServers({
      repoPath: '/workspace/repo',
      includeChromeDevtools: true,
      chromeDevtoolsToolTimeoutMs: 0,
    }).find((s) => s.name === 'chrome-devtools');
    expect(chrome).toBeDefined();
    expect(chrome?.timeout).toBeUndefined();
  });

  it('marks RAG grounding as LSP-capable only for a capable resolved CLI', () => {
    const base = {
      repoPath: '/r',
      includeRagSearch: true,
      ragServerPath: '/haive/rag.mjs',
      ragApiUrl: 'http://api:3001',
      ragToken: 'task-token',
    };
    const capable = buildDefaultMcpServers({ ...base, ragLspAvailable: true }).find(
      (server) => server.name === 'haive-rag',
    );
    const unsupported = buildDefaultMcpServers({ ...base, ragLspAvailable: false }).find(
      (server) => server.name === 'haive-rag',
    );
    expect(capable?.env?.HAIVE_LSP_AVAILABLE).toBe('1');
    expect(unsupported?.env?.HAIVE_LSP_AVAILABLE).toBe('0');
  });
});

describe('additive merge of user MCP servers', () => {
  const haive: McpServerSpec[] = [
    { name: 'haive-rag', command: 'node', args: ['/haive/haive-rag-mcp.mjs'], env: { X: '1' } },
  ];
  const userServers = {
    'my-custom': { command: 'npx', args: ['-y', 'my-mcp'] },
    'remote-sse': { type: 'sse', url: 'https://example.com/sse' },
  };

  it('unions user servers with Haive defaults (JSON)', () => {
    const out = serversToJsonObject(haive, userServers);
    expect(Object.keys(out).sort()).toEqual(['haive-rag', 'my-custom', 'remote-sse']);
    // user url/sse server passes through verbatim
    expect(out['remote-sse']).toEqual({ type: 'sse', url: 'https://example.com/sse' });
  });

  it('Haive reserved server wins on name collision', () => {
    const out = serversToJsonObject(haive, {
      'haive-rag': { command: 'evil', args: ['x'] },
    });
    expect(out['haive-rag']).toEqual({
      command: 'node',
      args: ['/haive/haive-rag-mcp.mjs'],
      env: { X: '1' },
    });
  });

  it('claude config bundles both user and Haive servers under --strict', () => {
    const config = buildMcpConfigForCli('claude-code', haive, '/home/claude', userServers);
    expect(config?.cliArgs).toContain('--strict-mcp-config');
    const parsed = JSON.parse(config!.content) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(parsed.mcpServers).sort()).toEqual(['haive-rag', 'my-custom', 'remote-sse']);
  });

  it('codex toml includes user stdio servers and skips non-stdio (url) ones', () => {
    const config = buildMcpConfigForCli('codex', haive, '/home/claude', userServers);
    expect(config?.content).toContain('[mcp_servers.my-custom]');
    expect(config?.content).toContain('[mcp_servers.haive-rag]');
    expect(config?.content).not.toContain('remote-sse');
  });

  it('writes a config from user servers even when Haive has none', () => {
    const config = buildMcpConfigForCli('claude-code', [], '/home/claude', userServers);
    expect(config).not.toBeNull();
    const parsed = JSON.parse(config!.content) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(parsed.mcpServers)).toContain('my-custom');
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

  it('emits antigravity JSON to ~/.gemini/antigravity-cli/mcp_config.json with no cliArgs', () => {
    const config = buildMcpConfigForCli('antigravity', sampleServers);
    expect(config?.path).toBe('/home/claude/.gemini/antigravity-cli/mcp_config.json');
    expect(config?.format).toBe('json');
    expect(config?.cliArgs).toBeUndefined();
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

  it('carries a capped server timeout into the claude JSON entry', () => {
    const capped: McpServerSpec[] = [
      {
        name: 'chrome-devtools',
        command: 'npx',
        args: ['-y', 'chrome-devtools-mcp@latest'],
        timeout: 300_000,
      },
    ];
    const parsed = JSON.parse(buildMcpConfigForCli('claude-code', capped)!.content) as {
      mcpServers: Record<string, { timeout?: number }>;
    };
    expect(parsed.mcpServers['chrome-devtools']?.timeout).toBe(300_000);
    // uncapped servers must not gain a field the CLI would then enforce
    const plain = JSON.parse(buildMcpConfigForCli('claude-code', sampleServers)!.content) as {
      mcpServers: Record<string, { timeout?: number }>;
    };
    expect(plain.mcpServers.filesystem?.timeout).toBeUndefined();
  });

  it('leaves codex TOML uncapped — its own tool_timeout_sec default (60s) is tighter', () => {
    const capped: McpServerSpec[] = [
      {
        name: 'chrome-devtools',
        command: 'npx',
        args: ['-y', 'chrome-devtools-mcp@latest'],
        timeout: 300_000,
      },
    ];
    const content = buildMcpConfigForCli('codex', capped)!.content;
    expect(content).toContain('[mcp_servers.chrome-devtools]');
    expect(content).not.toContain('timeout');
    expect(content).not.toContain('300000');
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

  // The delivery mode is what keeps a config file from being bind-mounted over a path inside an
  // auth-volume mount — where Docker leaves a root-owned stub the CLI can no longer write, and
  // the mount hides whatever else the file held. Only a path Haive fully owns may be 'bind'.
  it.each([
    ['claude-code', 'bind'],
    ['zai', 'bind'],
    ['ollama', 'bind'],
    ['muse', 'bind'],
    ['gemini', 'volume-merge'],
    ['codex', 'cli-merge'],
    ['grok', 'cli-merge'],
    ['antigravity', 'volume-write'],
  ] as const)('%s delivers its mcp config as %s', (cli, delivery) => {
    expect(buildMcpConfigForCli(cli, sampleServers, '/home/node')?.delivery).toBe(delivery);
  });

  it('never marks a path inside the auth-volume mount as bind-deliverable', () => {
    for (const cli of [
      'claude-code',
      'zai',
      'ollama',
      'muse',
      'gemini',
      'codex',
      'grok',
      'antigravity',
    ] as const) {
      const config = buildMcpConfigForCli(cli, sampleServers, '/home/node');
      if (config?.delivery !== 'bind') continue;
      const authRoots = getCliProviderMetadata(cli).authConfigPaths.map((p) =>
        p.replace(/^~/, '/home/node'),
      );
      for (const root of authRoots) {
        expect(config.path.startsWith(`${root}/`)).toBe(false);
      }
    }
  });
});

describe('buildMcpAddArgv', () => {
  const server: McpServerSpec = {
    name: 'haive-rag',
    command: 'node',
    args: ['/haive/haive-rag-mcp.mjs', '--verbose'],
    env: { RAG_API_URL: 'http://api:3001' },
  };

  // Both orderings are measured against grok 1.0.3 / codex 0.147.0. They are NOT interchangeable
  // even though both CLIs store the result in the same TOML shape.
  it('orders grok as: flags, name, command, -- args', () => {
    expect(buildMcpAddArgv('grok', server)).toEqual([
      'mcp',
      'add',
      '-s',
      'user',
      '-e',
      'RAG_API_URL=http://api:3001',
      'haive-rag',
      'node',
      '--',
      '/haive/haive-rag-mcp.mjs',
      '--verbose',
    ]);
  });

  it('orders codex as: flags, name, -- command args', () => {
    expect(buildMcpAddArgv('codex', server)).toEqual([
      'mcp',
      'add',
      '--env',
      'RAG_API_URL=http://api:3001',
      'haive-rag',
      '--',
      'node',
      '/haive/haive-rag-mcp.mjs',
      '--verbose',
    ]);
  });

  // A server with no args must not emit a dangling `--`: grok reads the next token as the
  // command, so a trailing separator with nothing after it is a parse error rather than a no-op.
  it('omits the grok separator when the server takes no args', () => {
    const argv = buildMcpAddArgv('grok', { name: 'x', command: 'run-me', args: [] });
    expect(argv).toEqual(['mcp', 'add', '-s', 'user', 'x', 'run-me']);
  });
});

describe('resolveStdioMcpServers', () => {
  it('puts user servers first, drops collisions and non-stdio entries', () => {
    const resolved = resolveStdioMcpServers(sampleServers, {
      mine: { command: 'node', args: ['/srv.js'], env: { A: '1' } },
      // collides with a Haive server — Haive's wins, the user copy is dropped
      filesystem: { command: 'other', args: [] },
      // url/sse entries cannot be expressed as a command, so they cannot survive here
      remote: { url: 'https://example.test/sse' },
    });
    expect(resolved.map((s) => s.name)).toEqual(['mine', 'filesystem', 'git']);
    expect(resolved[0]?.env).toEqual({ A: '1' });
    expect(resolved[1]?.command).toBe('npx');
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
