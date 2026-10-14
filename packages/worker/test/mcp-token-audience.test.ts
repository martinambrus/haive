import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { configService } from '@haive/shared';
import { verifyTaskToken } from '@haive/shared/task-token';
import { resolveMcpExtraFiles } from '../src/queues/cli-exec/resolvers.js';
import { resolveMcpSurface } from '../src/sandbox/mcp-surface.js';

vi.mock('../src/lsp/configured-lsp.js', () => ({ hasReadyLspBridge: async () => false }));

const SECRET = 'mcp-token-audience-test-secret';

function dbFor(deps: Record<string, unknown>): Database {
  return {
    query: {
      tasks: { findFirst: async () => ({ envTemplateId: 'env-1' }) },
      envTemplates: { findFirst: async () => ({ declaredDeps: deps, status: 'ready' }) },
      taskSteps: { findFirst: async () => ({ output: { tooling: { ragMode: 'internal' } } }) },
      repositories: { findFirst: async () => undefined },
    },
  } as unknown as Database;
}

const DDEV_TASK = { containerTool: 'ddev', browserTesting: false };

beforeEach(() => {
  process.env.CONFIG_ENCRYPTION_KEY = SECRET;
  vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
  vi.spyOn(configService, 'getNumber').mockImplementation(async (_key, fallback = 0) => fallback);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CONFIG_ENCRYPTION_KEY;
});

describe('the task tokens the worker mints for the MCP surface', () => {
  it('gives the rag server a rag token and the ddev server a ddev token, each good for its own audience only', async () => {
    const surface = await resolveMcpSurface(dbFor(DDEV_TASK), 'task-1', false);

    expect(verifyTaskToken(surface.rag.token, 'rag', SECRET)).toMatchObject({ taskId: 'task-1' });
    expect(verifyTaskToken(surface.rag.token, 'ddev', SECRET)).toBeNull();
    expect(verifyTaskToken(surface.ddevControl.token, 'ddev', SECRET)).toMatchObject({
      taskId: 'task-1',
    });
    expect(verifyTaskToken(surface.ddevControl.token, 'rag', SECRET)).toBeNull();
  });

  it('keeps a rag-only run to the rag audience and mints no ddev token', async () => {
    const surface = await resolveMcpSurface(dbFor(DDEV_TASK), 'task-1', true);

    expect(verifyTaskToken(surface.rag.token, 'rag', SECRET)).not.toBeNull();
    expect(surface.ddevControl.token).toBe('');
  });

  it('writes each token into its own server env in the config the sandbox receives', async () => {
    const { files } = await resolveMcpExtraFiles(
      dbFor(DDEV_TASK),
      'task-1',
      'claude-code',
      '/haive/workdir',
      null,
      'full',
      false,
      true,
      null,
    );
    const config = files.find((f) => f.containerPath === '/haive/mcp.json');
    const servers = (
      JSON.parse(config?.content ?? '{}') as {
        mcpServers: Record<string, { env: Record<string, string> }>;
      }
    ).mcpServers;
    const ragToken = servers['haive-rag']?.env.RAG_TASK_TOKEN ?? '';
    const ddevToken = servers['ddev-control']?.env.DDEV_TASK_TOKEN ?? '';

    expect(verifyTaskToken(ragToken, 'rag', SECRET)).toMatchObject({ taskId: 'task-1' });
    expect(verifyTaskToken(ragToken, 'ddev', SECRET)).toBeNull();
    expect(verifyTaskToken(ddevToken, 'ddev', SECRET)).toMatchObject({ taskId: 'task-1' });
    expect(verifyTaskToken(ddevToken, 'rag', SECRET)).toBeNull();
    expect(ragToken).not.toBe(ddevToken);
  });
});
