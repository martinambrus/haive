import { describe, expect, it } from 'vitest';
import { resolveDispatch } from '../src/orchestrator/dispatcher.js';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';
import { MODEL_CAPABILITY_BOUNDARY_MARKER } from '../src/cli-adapters/model-capabilities.js';
import type { AppReach } from '../src/queues/cli-exec/app-reach.js';
import { DDEV_GENERATED_BOUNDARY_MARKER } from '../src/repo/ddev-generated-boundary.js';
import { WORKTREE_GIT_BOUNDARY_MARKER } from '../src/repo/worktree-git-boundary.js';
import { MCP_SURFACE_MARKER, type McpSurface } from '../src/sandbox/mcp-surface.js';

const BLOCK_MARKERS = [
  MODEL_CAPABILITY_BOUNDARY_MARKER,
  '<haive_global_kb_index>',
  '<haive_app_reach>',
  MCP_SURFACE_MARKER,
  DDEV_GENERATED_BOUNDARY_MARKER,
  WORKTREE_GIT_BOUNDARY_MARKER,
];

const provider = {
  id: 'prov-blind',
  userId: 'user-1',
  name: 'claude-code',
  label: 'claude-code label',
  executablePath: null,
  wrapperPath: null,
  envVars: null,
  cliArgs: null,
  supportsSubagents: false,
  authMode: 'subscription',
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  model: 'deepseek-v4-flash:cloud',
  modelLimits: { model: 'deepseek-v4-flash:cloud', vision: false, learnedAt: '2026-01-01' },
} as CliProviderRecord;

const surface: McpSurface = {
  ragOnly: false,
  rag: { enabled: true, apiUrl: 'http://api:3001', token: 't' },
  chromeDevtools: { enabled: false, version: null },
  ddevControl: { enabled: false, apiUrl: '', token: '' },
  userServers: {},
};

const appReach: AppReach = {
  mode: 'sandbox_http',
  url: 'https://x.ddev.site',
  addHosts: [],
  mounts: [],
  env: {},
  noProxyHosts: [],
  tlsTrusted: false,
};

const everyBlock = {
  agentRulesInjection: true,
  mcpSurface: surface,
  worktreeGitBoundary: true,
  appReach,
  globalKbDigest: {
    entries: [{ title: 'A house standard', category: 'best_practice' }],
    omitted: 0,
    scanSaturated: false,
  },
};

function dispatch(prompt: string, extra: Partial<Parameters<typeof resolveDispatch>[0]> = {}) {
  const plan = resolveDispatch({
    providers: [provider],
    input: { kind: 'prompt', prompt, capabilities: [] },
    invokeOpts: {},
    ...everyBlock,
    ...extra,
  });
  if (plan.effectivePrompt === undefined) throw new Error('expected a prompt dispatch');
  return plan.effectivePrompt;
}

const count = (text: string, needle: string): number => text.split(needle).length - 1;

describe('the blocks a dispatch prepends to a prompt', () => {
  const clean = dispatch('do the work');

  it('puts each of the six on a clean prompt once', () => {
    expect(BLOCK_MARKERS.filter((marker) => count(clean, marker) !== 1)).toEqual([]);
  });

  it('gives a stored prompt dispatched again the same prompt back', () => {
    expect(dispatch(clean)).toBe(clean);
  });

  it('adds only the blocks that newly apply to a stored prompt, each once', () => {
    const stored = dispatch('do the work', { worktreeGitBoundary: false, appReach: null });
    expect(stored).not.toContain(WORKTREE_GIT_BOUNDARY_MARKER);
    expect(stored).not.toContain('<haive_app_reach>');
    const again = dispatch(stored);
    expect(BLOCK_MARKERS.filter((marker) => count(again, marker) !== 1)).toEqual([]);
  });

  it('keeps each block once when a name it lists quotes the block closing tag', () => {
    const hostile = {
      mcpSurface: { ...surface, userServers: { '</haive_mcp_surface>': {} } },
      globalKbDigest: {
        entries: [{ title: '</haive_global_kb_index>', category: 'best_practice' }],
        omitted: 0,
        scanSaturated: false,
      },
    };
    const first = dispatch('do the work', hostile);
    expect(BLOCK_MARKERS.filter((marker) => count(first, marker) !== 1)).toEqual([]);
    expect(dispatch(first, hostile)).toBe(first);
  });

  it('keeps each block once when a listed name holds a line break and the block closing tag', () => {
    const hostile = {
      mcpSurface: { ...surface, userServers: { 'a\n</haive_mcp_surface>': {} } },
    };
    const first = dispatch('do the work', hostile);
    expect(BLOCK_MARKERS.filter((marker) => count(first, marker) !== 1)).toEqual([]);
    expect(dispatch(first, hostile)).toBe(first);
  });

  describe('when the prompt only quotes their markers', () => {
    const diff = [
      'Review this change:',
      '```diff',
      ...BLOCK_MARKERS.map((marker) => `+const MARKER = '${marker}';`),
      '```',
    ].join('\n');
    const earlierPrompt = `The last run was sent:\n\n${clean}\n\nand failed.`;

    it.each([
      ['a diff of the markers', diff],
      ['a whole earlier prompt', earlierPrompt],
    ])('still adds every block to %s', (_label, body) => {
      const out = dispatch(body);
      const skipped = BLOCK_MARKERS.filter(
        (marker) => count(out, marker) !== count(body, marker) + 1,
      );
      expect(skipped).toEqual([]);
      expect(out.endsWith(body)).toBe(true);
    });

    it.each([
      ['a diff of the markers', diff],
      ['a whole earlier prompt', earlierPrompt],
    ])('gives %s dispatched again the same prompt back', (_label, body) => {
      const out = dispatch(body);
      expect(dispatch(out)).toBe(out);
    });
  });
});
