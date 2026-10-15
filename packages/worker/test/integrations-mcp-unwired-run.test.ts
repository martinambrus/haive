import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { configService, type CliExecJobPayload } from '@haive/shared';

const stubs = vi.hoisted(() => ({
  resumeStepIfLinked: vi.fn(async (..._args: unknown[]) => {}),
  provider: 'codex' as 'codex' | 'gemini',
  landed: false,
  writes: 0,
}));

vi.mock('../src/queues/cli-exec/resolvers.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveInvocationRepoMount: async () => ({ repoMount: null, hasWorktree: false, hasRepo: true }),
  loadProviderRuntimeConfig: async () => ({
    wrapperContent: null,
    sandboxImage: 'img:tag',
    networkPolicy: null,
    egressDomains: [],
  }),
  resolveAuthMounts: async () => [],
  resolveProviderNameForPayload: async () => stubs.provider,
  resumeStepIfLinked: stubs.resumeStepIfLinked,
  createStepStatusUpdater: () => {
    throw new Error('the run went on towards the sandbox');
  },
}));
vi.mock('../src/sandbox/task-auth-volume.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  mergeCliMcpIntoTaskVolume: async () => {
    stubs.writes += 1;
    return stubs.landed;
  },
  mergeGeminiMcpIntoSettings: async () => {
    stubs.writes += 1;
    return stubs.landed;
  },
  writeMcpFileIntoTaskVolume: async () => {
    stubs.writes += 1;
    return stubs.landed;
  },
}));
vi.mock('../src/sandbox/npm-cache.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  warmNpmPackage: async () => {},
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
import { UNWIRED_REASON } from './support/integrations-contract.js';
import { INV_1, STAMP, STEP_ROW_ID, TASK_ID } from './support/integrations-fixtures.js';

const SECRET = 'integrations-mcp-unwired-run-test-secret';
const WENT_ON = 'the run went on towards the sandbox';

const payload: CliExecJobPayload = {
  invocationId: INV_1,
  taskId: TASK_ID,
  taskStepId: STEP_ROW_ID,
  userId: 'user-1',
  cliProviderId: 'provider-1',
  kind: 'cli',
  spec: {},
  timeoutMs: 600_000,
};

function tableNameOf(table: unknown): string {
  const sym = Object.getOwnPropertySymbols(table as object).find(
    (s) => s.description === 'drizzle:Name',
  );
  return sym ? String((table as Record<symbol, unknown>)[sym]) : '';
}

/** A store whose one invocation, carrying `stamp`, is open until a write gives it an end, as BullMQ's second attempt finds it. */
function fakeDb(stamp: unknown) {
  const writes: Array<{ table: string; set: Record<string, unknown> }> = [];
  let ended = false;
  const invocation = () => ({
    id: payload.invocationId,
    endedAt: ended ? new Date() : null,
    supersededAt: null,
    task: { status: 'running', deadAt: null },
    integrations: stamp,
  });
  // Whichever way the stamp is read, it is this invocation's.
  const selection = () => {
    const chain: Record<string, unknown> = {
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve([invocation()]).then(res, rej),
    };
    for (const method of ['from', 'where', 'limit', 'for', 'orderBy']) chain[method] = () => chain;
    return chain;
  };
  const handle = (): unknown => ({
    query: {
      cliInvocations: { findFirst: async () => invocation() },
      cliProviders: { findFirst: async () => ({ id: 'provider-1', name: stubs.provider }) },
      tasks: {
        findFirst: async () => ({ envTemplateId: null, repositoryId: null, customSteps: null }),
      },
      envTemplates: { findFirst: async () => undefined },
      taskSteps: { findFirst: async () => ({ output: null, stepId: 'custom.demo.audit' }) },
      repositories: { findFirst: async () => undefined },
    },
    select: selection,
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

const endings = (writes: Array<{ table: string; set: Record<string, unknown> }>) =>
  writes.filter((w) => w.table === 'cli_invocations' && 'endedAt' in w.set);

beforeEach(() => {
  process.env.CONFIG_ENCRYPTION_KEY = SECRET;
  delete process.env.SANDBOX_NETWORK;
  delete process.env.RAG_API_INTERNAL_URL;
  stubs.resumeStepIfLinked.mockClear();
  stubs.writes = 0;
  stubs.landed = false;
  vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
  vi.spyOn(configService, 'getNumber').mockImplementation(async (_key, fallback = 0) => fallback);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CONFIG_ENCRYPTION_KEY;
});

describe.each(['codex', 'gemini'] as const)(
  'a stamped run whose CLI configuration does not land in its task volume, through the job handler, for %s',
  (provider) => {
    beforeEach(() => {
      stubs.provider = provider;
    });

    it('[W3] ends as a failed invocation with its reason, and is not run again', async () => {
      const { db, writes } = fakeDb(STAMP);

      await expect(handleCliExecJob(db, payload)).rejects.toThrow(UNWIRED_REASON);

      expect(stubs.writes).toBe(1);
      const ended = endings(writes);
      expect(ended).toHaveLength(1);
      expect(ended[0]!.set).toMatchObject({ exitCode: -1, endedAt: expect.any(Date) });
      const message = ended[0]!.set.errorMessage as string;
      expect(message.startsWith(`${UNWIRED_REASON}: `)).toBe(true);
      expect(message).not.toContain(WENT_ON);
      expect(stubs.resumeStepIfLinked).toHaveBeenCalledExactlyOnceWith(payload, false, message);

      const written = writes.length;
      await expect(handleCliExecJob(db, payload)).resolves.toBeUndefined();
      expect(writes).toHaveLength(written);
      expect(stubs.resumeStepIfLinked).toHaveBeenCalledTimes(1);
    });

    it('[W3] lets a run with no stamp go on towards the sandbox, with the same writer result', async () => {
      const { db, writes } = fakeDb(null);

      await expect(handleCliExecJob(db, payload)).rejects.toThrow(WENT_ON);

      expect(stubs.writes).toBe(1);
      const ended = endings(writes);
      expect(ended).toHaveLength(1);
      expect(ended[0]!.set.errorMessage).toContain(WENT_ON);
      expect(String(ended[0]!.set.errorMessage)).not.toContain(UNWIRED_REASON);
    });
  },
);

describe('a stamped run whose configuration landed, through the job handler', () => {
  it('[W3] goes on towards the sandbox', async () => {
    stubs.provider = 'codex';
    stubs.landed = true;
    const { db, writes } = fakeDb(STAMP);

    await expect(handleCliExecJob(db, payload)).rejects.toThrow(WENT_ON);

    expect(stubs.writes).toBe(1);
    expect(String(endings(writes)[0]!.set.errorMessage)).not.toContain(UNWIRED_REASON);
  });
});
