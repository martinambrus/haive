import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { snapshotToolProfile } from '../src/repo/committed-snapshot.js';
import { configService } from '@haive/shared';
import { resolveMcpExtraFiles } from '../src/queues/cli-exec/resolvers.js';
import { emptyMcpSurface } from '../src/sandbox/mcp-surface.js';
import { hasReadyLspBridge } from '../src/lsp/configured-lsp.js';

vi.mock('../src/lsp/configured-lsp.js', () => ({ hasReadyLspBridge: vi.fn(async () => true) }));
vi.mock('../src/sandbox/mcp-surface.js', async (original) => ({
  ...(await original<object>()),
  resolveMcpSurface: vi.fn(async (_db, _task, ragOnly) => ({
    ...emptyMcpSurface(),
    ragOnly,
    rag: { enabled: true, apiUrl: 'http://api.invalid', token: randomBytes(32).toString('hex') },
  })),
}));
afterEach(() => vi.restoreAllMocks());
describe('snapshot MCP file set', () => {
  it('wires neither git nor LSP when a live LSP bridge is ready', async () => {
    vi.spyOn(configService, 'getNumber').mockImplementation(async (_key, value) => value!);
    const files = await resolveMcpExtraFiles(
      null as never,
      'task',
      'claude-code',
      '/haive/workdir',
      null,
      'full',
      false,
      true,
      undefined,
      'snapshot',
    );
    const config = files.files.map((f) => f.content).find((body) => body.includes('"mcpServers"'))!;
    const servers = JSON.parse(config).mcpServers;
    expect(servers.git).toBeUndefined();
    expect(servers['haive-rag'].env.HAIVE_LSP_AVAILABLE).not.toBe('1');
    expect(hasReadyLspBridge).not.toHaveBeenCalled();
  });
});

it.each([undefined, 'full', 'rag_only', 'none'] as const)(
  'clamps only snapshot tools and preserves none: %s',
  (profile) => {
    expect(snapshotToolProfile(true, profile)).toBe(profile === 'none' ? 'none' : 'rag_only');
    expect(snapshotToolProfile(false, profile)).toBe(profile);
  },
);
