import { describe, expect, it } from 'vitest';
import { HAIVE_MCP_SERVER_NAMES, isHaiveMcpServer } from '@haive/shared/stats';
import { buildDefaultMcpServers } from '../src/sandbox/mcp-config.js';
import { API_URL_ENV, SERVER_NAME, SERVER_PATH } from './support/integrations-contract.js';

const INTEGRATIONS = {
  includeIntegrations: true,
  integrationsServerPath: SERVER_PATH,
  integrationsApiUrl: 'http://api:3001',
} as const;

const ENTRY = {
  name: SERVER_NAME,
  command: 'node',
  args: [SERVER_PATH],
  env: { [API_URL_ENV]: 'http://api:3001' },
};

describe('HAIVE_MCP_SERVER_NAMES', () => {
  it('[W6] lists haive-integrations, so the stats badge tells it from a repository server', () => {
    expect(HAIVE_MCP_SERVER_NAMES).toContain(SERVER_NAME);
    expect(isHaiveMcpServer(SERVER_NAME)).toBe(true);
  });

  it('[W6+] names no server by a prefix: a name that only starts like one is not Haive-wired', () => {
    expect(isHaiveMcpServer(`${SERVER_NAME}-extra`)).toBe(false);
    expect(isHaiveMcpServer('haive-not-wired-by-haive')).toBe(false);
  });

  it('[W6] names exactly the servers buildDefaultMcpServers can wire, with every flag', () => {
    const everything = buildDefaultMcpServers({
      repoPath: '/workspace/repo',
      databaseUrl: 'postgres://user:pass@db:5432/haive',
      includeChromeDevtools: true,
      chromeDevtoolsBrowserUrl: 'http://127.0.0.1:9222',
      includeRagSearch: true,
      ragServerPath: '/haive/haive-rag-mcp.mjs',
      ragApiUrl: 'http://api:3001',
      ragToken: 'tok-rag',
      includeDdevControl: true,
      ddevControlServerPath: '/haive/haive-ddev-mcp.mjs',
      ddevApiUrl: 'http://api:3001',
      ddevToken: 'tok-ddev',
      includeCustomTools: true,
      customServerPath: '/haive/haive-custom-mcp.mjs',
      customApiUrl: 'http://api:3001',
      ...INTEGRATIONS,
    });
    const names = everything.map((s) => s.name);
    expect(names).toContain(SERVER_NAME);
    expect([...names].sort()).toEqual([...HAIVE_MCP_SERVER_NAMES].sort());
  });
});

describe('buildDefaultMcpServers and the haive-integrations server', () => {
  it('[W6] lists it when enabled with its path and url, and puts no token in it', () => {
    const servers = buildDefaultMcpServers({ repoPath: '/workspace/repo', ...INTEGRATIONS });
    expect(servers.at(-1)).toEqual(ENTRY);
    expect(servers.map((s) => s.name)).toEqual(['filesystem', 'git', SERVER_NAME]);
  });

  it('[W6] lists it after haive-custom', () => {
    const servers = buildDefaultMcpServers({
      repoPath: '/workspace/repo',
      includeCustomTools: true,
      customServerPath: '/haive/haive-custom-mcp.mjs',
      customApiUrl: 'http://api:3001',
      ...INTEGRATIONS,
    });
    expect(servers.map((s) => s.name)).toEqual(['filesystem', 'git', 'haive-custom', SERVER_NAME]);
    expect(servers.at(-1)).toEqual(ENTRY);
  });

  it('[W6+] omits it when disabled or missing its path or url', () => {
    const named = (opts: Parameters<typeof buildDefaultMcpServers>[0]) =>
      buildDefaultMcpServers(opts).some((s) => s.name === SERVER_NAME);
    expect(
      buildDefaultMcpServers({ repoPath: '/r', ...INTEGRATIONS }).some(
        (s) => s.name === SERVER_NAME,
      ),
    ).toBe(true);
    expect(named({ repoPath: '/r' })).toBe(false);
    expect(named({ repoPath: '/r', ...INTEGRATIONS, includeIntegrations: false })).toBe(false);
    expect(
      named({
        repoPath: '/r',
        integrationsServerPath: SERVER_PATH,
        integrationsApiUrl: 'http://api:3001',
      }),
    ).toBe(false);
    expect(
      named({ repoPath: '/r', includeIntegrations: true, integrationsServerPath: SERVER_PATH }),
    ).toBe(false);
    expect(
      named({ repoPath: '/r', includeIntegrations: true, integrationsApiUrl: 'http://api:3001' }),
    ).toBe(false);
  });
});
