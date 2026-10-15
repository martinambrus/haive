import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { configService } from '@haive/shared';
import { resolveMcpExtraFiles } from '../src/queues/cli-exec/resolvers.js';
import { CUSTOM_MCP_TOKEN_PATH } from '../src/sandbox/custom-mcp-server.js';
import { clearTaskAuthPreparationState } from '../src/sandbox/task-auth-volume.js';

vi.mock('../src/lsp/configured-lsp.js', () => ({ hasReadyLspBridge: async () => false }));

const helper = vi.hoisted(() => ({ exitCode: 0, runs: 0 }));
vi.mock('../src/sandbox/docker-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sandbox/docker-runner.js')>();
  return {
    ...actual,
    defaultDockerRunner: {
      ...actual.defaultDockerRunner,
      volumeExists: async () => true,
      run: async () => {
        helper.runs += 1;
        return {
          exitCode: helper.exitCode,
          stdout: '',
          stderr: 'boom',
          durationMs: 1,
          timedOut: false,
        };
      },
    },
  };
});

const TASK = 'task-config-write';
const STEP_ID = 'custom.demo.audit';
const NOT_WRITTEN = "the CLI's MCP configuration could not be written to its task volume";

const db = {
  query: {
    tasks: {
      findFirst: async () => ({
        envTemplateId: null,
        repositoryId: null,
        customSteps: {
          [STEP_ID]: {
            slug: 'audit',
            title: 'Audit',
            template: 'Audit {{task.title}}',
            capabilities: [],
            timeoutMs: 300_000,
            tools: [
              {
                name: 'house_rules',
                description: 'Searches the house rules.',
                action: 'rag-query',
                scope: 'global',
              },
            ],
          },
        },
      }),
    },
    envTemplates: { findFirst: async () => undefined },
    taskSteps: { findFirst: async () => ({ output: null, stepId: STEP_ID }) },
    repositories: { findFirst: async () => undefined },
  },
} as unknown as Database;

const run = {
  customTools: ['house_rules'],
  invocationId: 'inv-1',
  taskStepId: 'ts-1',
  timeoutMs: 600_000,
};

const resolve = (provider: 'codex' | 'gemini', forRun?: typeof run) =>
  resolveMcpExtraFiles(
    db,
    TASK,
    provider,
    '/haive/workdir',
    'img:tag',
    'full',
    false,
    true,
    null,
    forRun,
  );

beforeEach(() => {
  process.env.CONFIG_ENCRYPTION_KEY = 'custom-mcp-config-write-test-secret';
  delete process.env.RAG_API_INTERNAL_URL;
  helper.exitCode = 0;
  helper.runs = 0;
  clearTaskAuthPreparationState(TASK);
  vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
  vi.spyOn(configService, 'getNumber').mockImplementation(async (_key, fallback = 0) => fallback);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CONFIG_ENCRYPTION_KEY;
  clearTaskAuthPreparationState(TASK);
});

describe.each(['codex', 'gemini'] as const)(
  'a run with custom tools, through the real writer of its CLI configuration, for %s',
  (provider) => {
    it('fails when the helper cannot write the configuration, and the retry writes it', async () => {
      helper.exitCode = 1;
      await expect(resolve(provider, run)).rejects.toThrow(NOT_WRITTEN);

      helper.exitCode = 0;
      const { files } = await resolve(provider, { ...run, invocationId: 'inv-2' });
      expect(files.map((f) => f.containerPath)).toContain(CUSTOM_MCP_TOKEN_PATH);
      expect(helper.runs).toBe(2);
    });

    it('goes on, without a second helper run, when the configuration is already in place', async () => {
      await resolve(provider, run);
      const { files } = await resolve(provider, { ...run, invocationId: 'inv-2' });
      expect(files.map((f) => f.containerPath)).toContain(CUSTOM_MCP_TOKEN_PATH);
      expect(helper.runs).toBe(1);
    });

    it('lets a run that names no tools go on when the helper fails', async () => {
      helper.exitCode = 1;
      const { files } = await resolve(provider);
      expect(files.map((f) => f.containerPath)).not.toContain(CUSTOM_MCP_TOKEN_PATH);
      expect(helper.runs).toBe(1);
    });
  },
);
