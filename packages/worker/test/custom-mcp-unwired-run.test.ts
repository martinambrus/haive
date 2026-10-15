import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { CONFIG_KEYS, configService, type CliExecJobPayload } from '@haive/shared';

const stubs = vi.hoisted(() => ({
  resumeStepIfLinked: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock('../src/queues/cli-exec/resolvers.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveInvocationRepoMount: async () => ({ repoMount: null, hasWorktree: false, hasRepo: false }),
  loadProviderRuntimeConfig: async () => ({
    wrapperContent: null,
    sandboxImage: 'img:tag',
    networkPolicy: null,
    egressDomains: [],
  }),
  resolveAuthMounts: async () => [],
  resolveProviderNameForPayload: async () => 'claude-code',
  resumeStepIfLinked: stubs.resumeStepIfLinked,
  createStepStatusUpdater: () => {
    throw new Error('the run went on towards the sandbox');
  },
}));
vi.mock('../src/queues/cli-exec/secret-mask.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveSecretMasks: async () => [],
}));
vi.mock('../src/secrets/provider-secrets.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveProviderSecrets: async () => ({}),
}));
vi.mock('../src/secrets/user-git-identity.js', () => ({ resolveGitEnv: async () => ({}) }));
vi.mock('../src/queues/cli-stream-publisher.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  publishCliExit: async () => {},
}));
vi.mock('../src/queues/cli-park-timing.js', () => ({
  foldCliParkOnResume: async () => {},
  markCliParkBegin: async () => {},
}));
vi.mock('../src/lsp/configured-lsp.js', () => ({ hasReadyLspBridge: async () => false }));

import { handleCliExecJob } from '../src/queues/cli-exec/handlers.js';
import { CUSTOM_TOOLS_UNWIRED_REASON } from '../src/queues/cli-exec/resolvers.js';
import { CUSTOM_TOOL_INVALID_REASON } from '../src/step-engine/step-runner.js';

const SECRET = 'custom-mcp-unwired-run-test-secret';
const STEP_ID = 'custom.demo.audit';
const NAMED = ['repo_status', 'house_rules'];

const tool = (name: string) => ({
  name,
  description: `Searches for ${name}.`,
  action: 'rag-query',
  scope: 'global',
});
const pinned = (names: string[]) => ({
  [STEP_ID]: {
    slug: 'audit',
    title: 'Audit',
    template: 'Audit {{task.title}}',
    capabilities: [],
    timeoutMs: 300_000,
    tools: names.map(tool),
  },
});

const payload: CliExecJobPayload = {
  invocationId: 'inv-1',
  taskId: 'task-1',
  taskStepId: 'ts-1',
  userId: 'user-1',
  cliProviderId: 'provider-1',
  kind: 'cli',
  customTools: NAMED,
  spec: {},
  timeoutMs: 600_000,
};

function tableNameOf(table: unknown): string {
  const sym = Object.getOwnPropertySymbols(table as object).find(
    (s) => s.description === 'drizzle:Name',
  );
  return sym ? String((table as Record<symbol, unknown>)[sym]) : '';
}

/** A store whose one invocation is open until a write gives it an end, as BullMQ's second attempt finds it. */
function fakeDb(customSteps: unknown) {
  const writes: Array<{ table: string; set: Record<string, unknown> }> = [];
  let ended = false;
  const handle = (): unknown => ({
    query: {
      cliInvocations: {
        findFirst: async () => ({
          id: payload.invocationId,
          endedAt: ended ? new Date() : null,
          supersededAt: null,
          task: { status: 'running', deadAt: null },
        }),
      },
      cliProviders: { findFirst: async () => ({ id: 'provider-1', name: 'claude-code' }) },
      tasks: {
        findFirst: async () => ({ envTemplateId: null, repositoryId: null, customSteps }),
      },
      envTemplates: { findFirst: async () => undefined },
      taskSteps: { findFirst: async () => ({ output: null, stepId: STEP_ID }) },
      repositories: { findFirst: async () => undefined },
    },
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: () => {
          writes.push({ table: tableNameOf(table), set });
          if ('endedAt' in set) ended = true;
          return {
            then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
              Promise.resolve(undefined).then(res, rej),
            returning: async () => [{ id: payload.invocationId }],
          };
        },
      }),
    }),
    transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(handle()),
  });
  return { db: handle() as Database, writes };
}

beforeEach(() => {
  process.env.CONFIG_ENCRYPTION_KEY = SECRET;
  delete process.env.SANDBOX_NETWORK;
  delete process.env.RAG_API_INTERNAL_URL;
  stubs.resumeStepIfLinked.mockClear();
  vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
  vi.spyOn(configService, 'getNumber').mockImplementation(async (_key, fallback = 0) => fallback);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CONFIG_ENCRYPTION_KEY;
});

describe('a run that names custom tools it cannot wire, through the job handler', () => {
  it.each([
    [
      'the secret that signs their token is gone',
      'CONFIG_ENCRYPTION_KEY',
      () => {
        delete process.env.CONFIG_ENCRYPTION_KEY;
        return pinned(NAMED);
      },
    ],
    ['the pinned step does not include them', 'none of them pinned', () => pinned(['other_tool'])],
    [
      'custom tools are switched off on this install',
      'custom tools are switched off on this install',
      () => {
        vi.mocked(configService.getBoolean).mockImplementation(
          async (key) => key !== CONFIG_KEYS.CUSTOM_MCP_TOOLS_ENABLED,
        );
        return pinned(NAMED);
      },
    ],
  ])(
    'ends as a failed invocation with its reason when %s, and is not run again',
    async (_why, cause, setup) => {
      const { db, writes } = fakeDb(setup());

      await expect(handleCliExecJob(db, payload)).rejects.toThrow(CUSTOM_TOOLS_UNWIRED_REASON);

      const ended = writes.filter((w) => w.table === 'cli_invocations' && 'endedAt' in w.set);
      expect(ended).toHaveLength(1);
      expect(ended[0]!.set).toMatchObject({ exitCode: -1, endedAt: expect.any(Date) });
      const message = ended[0]!.set.errorMessage as string;
      expect(message.startsWith(`${CUSTOM_TOOLS_UNWIRED_REASON}: `)).toBe(true);
      expect(message).toContain(cause);
      expect(message).toContain(NAMED.join(', '));
      expect(stubs.resumeStepIfLinked).toHaveBeenCalledExactlyOnceWith(payload, false, message);

      const written = writes.length;
      await expect(handleCliExecJob(db, payload)).resolves.toBeUndefined();
      expect(writes).toHaveLength(written);
      expect(stubs.resumeStepIfLinked).toHaveBeenCalledTimes(1);
    },
  );
});

describe('a run queued before its pinned tools tightened, through the job handler', () => {
  it('ends as a failed invocation with its reason when a pinned tool is one a save refuses now, and is not run again', async () => {
    const queued = { ...payload, customTools: ['rag_search'] };
    const { db, writes } = fakeDb(pinned(['rag_search']));

    await expect(handleCliExecJob(db, queued)).rejects.toThrow(CUSTOM_TOOL_INVALID_REASON);

    const ended = writes.filter((w) => w.table === 'cli_invocations' && 'endedAt' in w.set);
    expect(ended).toHaveLength(1);
    expect(ended[0]!.set).toMatchObject({ exitCode: -1, endedAt: expect.any(Date) });
    const message = ended[0]!.set.errorMessage as string;
    expect(message.startsWith(`${CUSTOM_TOOL_INVALID_REASON}: `)).toBe(true);
    expect(message).toContain('`rag_search`');
    expect(message).toContain('kept for Haive');
    expect(stubs.resumeStepIfLinked).toHaveBeenCalledExactlyOnceWith(queued, false, message);

    const written = writes.length;
    await expect(handleCliExecJob(db, queued)).resolves.toBeUndefined();
    expect(writes).toHaveLength(written);
    expect(stubs.resumeStepIfLinked).toHaveBeenCalledTimes(1);
  });
});
