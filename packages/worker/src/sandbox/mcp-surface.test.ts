import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { configService } from '@haive/shared';
import {
  hasAnyMcpServer,
  MCP_SURFACE_MARKER,
  mcpSurfacePrompt,
  resolveMcpSurface,
  withMcpSurface,
  type McpSurface,
} from './mcp-surface.js';

const TOOLING = JSON.stringify({
  mcpServers: { 'acme-tickets': { command: 'node', args: ['/srv/acme.mjs'] } },
});

/** Minimal db whose step-04 output carries both ragMode and the user's MCP settings,
 *  so resolveRagMcpConfig and loadUserMcpServers each short-circuit on their first
 *  query and no fallback chain is exercised. */
function dbFor(deps: Record<string, unknown> | null, status = 'ready'): Database {
  return {
    query: {
      tasks: { findFirst: async () => ({ envTemplateId: deps ? 'env-1' : null }) },
      envTemplates: { findFirst: async () => (deps ? { declaredDeps: deps, status } : undefined) },
      taskSteps: {
        findFirst: async () => ({
          output: { tooling: { ragMode: 'internal', mcpSettingsJson: TOOLING } },
        }),
      },
      repositories: { findFirst: async () => undefined },
    },
  } as unknown as Database;
}

const DDEV_BROWSER = { containerTool: 'ddev', browserTesting: true };

describe('resolveMcpSurface', () => {
  beforeEach(() => {
    process.env.CONFIG_ENCRYPTION_KEY = 'test-secret';
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CONFIG_ENCRYPTION_KEY;
  });

  it('wires browser + ddev + rag + user servers for a ready DDEV browser-testing task', async () => {
    const surface = await resolveMcpSurface(dbFor(DDEV_BROWSER), 'task-1', false);
    expect(surface.chromeDevtools.enabled).toBe(true);
    expect(surface.ddevControl.enabled).toBe(true);
    expect(surface.ddevControl.token).not.toBe('');
    expect(surface.rag.enabled).toBe(true);
    expect(Object.keys(surface.userServers)).toEqual(['acme-tickets']);
  });

  it('drops every runtime server AND the user servers under rag-only, keeping rag', async () => {
    const surface = await resolveMcpSurface(dbFor(DDEV_BROWSER), 'task-1', true);
    expect(surface.ragOnly).toBe(true);
    expect(surface.chromeDevtools.enabled).toBe(false);
    expect(surface.ddevControl.enabled).toBe(false);
    expect(surface.ddevControl.token).toBe('');
    expect(surface.userServers).toEqual({});
    expect(surface.rag.enabled).toBe(true);
  });

  it('honors the ddev-control kill-switch without touching the browser', async () => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    const surface = await resolveMcpSurface(dbFor(DDEV_BROWSER), 'task-1', false);
    expect(surface.ddevControl.enabled).toBe(false);
    expect(surface.chromeDevtools.enabled).toBe(true);
  });

  it('wires nothing runtime-side for an env template that is not ready', async () => {
    const surface = await resolveMcpSurface(dbFor(DDEV_BROWSER, 'building'), 'task-1', false);
    expect(surface.chromeDevtools.enabled).toBe(false);
    expect(surface.ddevControl.enabled).toBe(false);
  });

  it('separates the two gates: browser testing without ddev gets no ddev-control', async () => {
    const surface = await resolveMcpSurface(
      dbFor({ containerTool: 'docker-compose', browserTesting: true }),
      'task-1',
      false,
    );
    expect(surface.chromeDevtools.enabled).toBe(true);
    expect(surface.ddevControl.enabled).toBe(false);
  });

  it('carries the repo-pinned chrome-devtools-mcp version through', async () => {
    const surface = await resolveMcpSurface(
      dbFor({ ...DDEV_BROWSER, chromeDevtoolsMcpVersion: '0.6.1' }),
      'task-1',
      false,
    );
    expect(surface.chromeDevtools.version).toBe('0.6.1');
  });
});

function surfaceOf(over: Partial<McpSurface> = {}): McpSurface {
  return {
    ragOnly: false,
    rag: { enabled: true, apiUrl: 'http://api:3001', token: 't' },
    chromeDevtools: { enabled: false, version: null },
    ddevControl: { enabled: false, apiUrl: 'http://api:3001', token: '' },
    userServers: {},
    ...over,
  };
}

describe('mcpSurfacePrompt', () => {
  it('names the wired servers and states the ddev exec limit', () => {
    const prompt = mcpSurfacePrompt(
      surfaceOf({
        chromeDevtools: { enabled: true, version: null },
        ddevControl: { enabled: true, apiUrl: 'http://api:3001', token: 't' },
      }),
    );
    expect(prompt).toContain('`rag_search`');
    expect(prompt).toContain('`chrome-devtools`');
    expect(prompt).toContain('`ddev_status`');
    expect(prompt).toContain('`ddev_logs`');
    expect(prompt).toContain('`ddev_restart`');
    expect(prompt).toContain('no `ddev exec`');
  });

  it('tells a browser agent to work in its own tab and release it', () => {
    const prompt = mcpSurfacePrompt(
      surfaceOf({ chromeDevtools: { enabled: true, version: null } }),
    );
    expect(prompt).toContain('`new_page({url})` your FIRST browser call');
    expect(prompt).toContain('`close_page` your tab when done');
    // Named as a prohibition: it is the obvious-looking way to isolate, and it discards
    // the task's one app login.
    expect(prompt).toContain('Never pass `isolatedContext`');
  });

  it('omits the tab discipline when no browser is wired', () => {
    const prompt = mcpSurfacePrompt(surfaceOf());
    expect(prompt).not.toContain('new_page');
    expect(prompt).not.toContain('close_page');
  });

  it('never advertises filesystem or git — the git server points at a masked .git', () => {
    const prompt = mcpSurfacePrompt(
      surfaceOf({
        chromeDevtools: { enabled: true, version: null },
        ddevControl: { enabled: true, apiUrl: 'http://api:3001', token: 't' },
      }),
    );
    expect(prompt).not.toContain('filesystem');
    expect(prompt).not.toMatch(/`git`/);
  });

  it('states the absence positively when no runtime server is wired', () => {
    const prompt = mcpSurfacePrompt(surfaceOf({ ragOnly: true }));
    expect(prompt).toContain('No browser and no container tooling are wired into this run');
    expect(prompt).toContain('deliberate, not a');
    expect(prompt).toContain('out of scope');
  });

  it('omits the absence paragraph once any runtime server is present', () => {
    const prompt = mcpSurfacePrompt(
      surfaceOf({ chromeDevtools: { enabled: true, version: null } }),
    );
    expect(prompt).not.toContain('No browser and no container tooling');
  });

  it('lists the project-configured servers by name', () => {
    const prompt = mcpSurfacePrompt(surfaceOf({ userServers: { 'acme-tickets': {} } }));
    expect(prompt).toContain('`acme-tickets`');
  });

  it('does not re-announce a user server Haive shadows under the same name', () => {
    const prompt = mcpSurfacePrompt(
      surfaceOf({
        chromeDevtools: { enabled: true, version: null },
        userServers: { 'chrome-devtools': {}, 'acme-tickets': {} },
      }),
    );
    expect(prompt).toContain('Project-configured servers: `acme-tickets`.');
    // Named once, by the chrome-devtools line — not a second time as if the repo's
    // own entry survived the collision.
    expect(prompt.match(/chrome-devtools/g)).toHaveLength(1);
  });

  it('keeps a user server whose Haive namesake is switched off', () => {
    const prompt = mcpSurfacePrompt(surfaceOf({ userServers: { 'chrome-devtools': {} } }));
    expect(prompt).toContain('Project-configured servers: `chrome-devtools`.');
  });

  it('treats an entirely shadowed user set as no user servers at all', () => {
    const shadowedOnly = surfaceOf({
      rag: { enabled: false, apiUrl: '', token: '' },
      userServers: { filesystem: {}, git: {} },
    });
    expect(hasAnyMcpServer(shadowedOnly)).toBe(false);
    expect(withMcpSurface('Classify this.', shadowedOnly)).toBe('Classify this.');
  });
});

describe('withMcpSurface', () => {
  it('prepends once and is idempotent across retry paths', () => {
    const once = withMcpSurface('Review this.', surfaceOf());
    const twice = withMcpSurface(once, surfaceOf());
    expect(twice).toBe(once);
    expect(twice.split(MCP_SURFACE_MARKER)).toHaveLength(2);
    expect(once).toMatch(/<haive_mcp_surface>[\s\S]*Review this\.$/);
  });

  it('advertises nothing for an adapter that gets no MCP config at all', () => {
    expect(withMcpSurface('Review this.', null)).toBe('Review this.');
  });

  it('stays silent when the surface is empty — no list to give, no limit worth stating', () => {
    const bare = surfaceOf({ rag: { enabled: false, apiUrl: '', token: '' } });
    expect(hasAnyMcpServer(bare)).toBe(false);
    expect(withMcpSurface('Classify this.', bare)).toBe('Classify this.');
  });

  it('speaks as soon as one server is wired, even a user-provided one', () => {
    const surface = surfaceOf({
      rag: { enabled: false, apiUrl: '', token: '' },
      userServers: { 'acme-tickets': {} },
    });
    expect(hasAnyMcpServer(surface)).toBe(true);
    expect(withMcpSurface('Classify this.', surface)).toContain(MCP_SURFACE_MARKER);
  });
});
