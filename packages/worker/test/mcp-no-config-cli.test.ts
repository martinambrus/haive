import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { configService, type CliExecJobPayload } from '@haive/shared';

const stubs = vi.hoisted(() => ({
  resumeStepIfLinked: vi.fn(async (..._args: unknown[]) => {}),
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
  resolveProviderNameForPayload: async () => 'amp',
  resumeStepIfLinked: stubs.resumeStepIfLinked,
  createStepStatusUpdater: () => {
    throw new Error('the run went on towards the sandbox');
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
import { isTransientCliFailure } from '../src/queues/cli-exec/failure-class.js';
import {
  CUSTOM_TOOLS_UNWIRED_REASON,
  resolveMcpExtraFiles,
} from '../src/queues/cli-exec/resolvers.js';
import { CUSTOM_MCP_TOKEN_PATH } from '../src/sandbox/custom-mcp-server.js';
import { TOKEN_PATH, UNWIRED_REASON } from './support/integrations-contract.js';
import {
  INV_1,
  STAMP,
  STEP_ROW_ID,
  TASK_ID,
  fakeDatabase,
  stampedDatabase,
} from './support/integrations-fixtures.js';

const SECRET = 'mcp-no-config-cli-test-secret';
const WENT_ON = 'the run went on towards the sandbox';
const CUSTOM_STEP_ID = 'custom.demo.audit';

const pinnedHouseRules = {
  [CUSTOM_STEP_ID]: {
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
};

type Run = NonNullable<Parameters<typeof resolveMcpExtraFiles>[9]>;
const run = (over: Partial<Run> = {}): Run => ({
  invocationId: INV_1,
  taskStepId: STEP_ROW_ID,
  timeoutMs: 600_000,
  ...over,
});

const extra = (
  provider: 'amp' | 'claude-code',
  db: Database,
  forRun: Run,
  profile: 'full' | 'rag_only' = 'full',
) =>
  resolveMcpExtraFiles(
    db,
    TASK_ID,
    provider,
    '/haive/workdir',
    'img:tag',
    profile,
    false,
    true,
    null,
    forRun,
  );

const paths = (files: Array<{ containerPath: string }>) => files.map((f) => f.containerPath);

/** The message a run fails with when it cannot be wired; the CLI is not started and the run is not retried. */
async function failedWith(attempt: Promise<unknown>, reason: string): Promise<string> {
  const failure = await attempt.catch((err: unknown) => err);
  expect(failure).toBeInstanceOf(Error);
  const message = (failure as Error).message;
  expect(message.startsWith(`${reason}: `)).toBe(true);
  expect(isTransientCliFailure({ exitCode: -1, errorMessage: message })).toBe(false);
  return message;
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

describe('a CLI that is given no MCP configuration, for amp', () => {
  const withCustomTools = () =>
    fakeDatabase({
      customSteps: pinnedHouseRules,
      stepId: CUSTOM_STEP_ID,
      invocations: [{ id: INV_1, integrations: null }],
    });

  it('[A1] fails a stamped run with the integrations reason, where the same run is wired for claude-code', async () => {
    const wired = await extra('claude-code', stampedDatabase(), run());
    expect(paths(wired.files)).toContain(TOKEN_PATH);

    await failedWith(extra('amp', stampedDatabase(), run()), UNWIRED_REASON);
  });

  it('[A2] fails a run with custom tools with the custom-tools reason, where the same run is wired for claude-code', async () => {
    const forRun = run({ customTools: ['house_rules'] });
    const wired = await extra('claude-code', withCustomTools(), forRun);
    expect(paths(wired.files)).toContain(CUSTOM_MCP_TOKEN_PATH);

    const message = await failedWith(
      extra('amp', withCustomTools(), forRun),
      CUSTOM_TOOLS_UNWIRED_REASON,
    );
    expect(message).toContain('house_rules');
  });

  it('[A3] lets a run with no stamp and no custom tools go on, with nothing wired', async () => {
    await expect(extra('amp', stampedDatabase(null), run())).resolves.toEqual({
      files: [],
      extraArgs: [],
    });
  });

  it('[A3] lets a rag_only run go on, though its invocation is stamped', async () => {
    await expect(extra('amp', stampedDatabase(), run(), 'rag_only')).resolves.toEqual({
      files: [],
      extraArgs: [],
    });
  });
});

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
      cliProviders: { findFirst: async () => ({ id: 'provider-1', name: 'amp' }) },
      tasks: {
        findFirst: async () => ({ envTemplateId: null, repositoryId: null, customSteps: null }),
      },
      envTemplates: { findFirst: async () => undefined },
      taskSteps: { findFirst: async () => ({ output: null, stepId: CUSTOM_STEP_ID }) },
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

describe('a stamped run of a CLI that is given no MCP configuration, through the job handler, for amp', () => {
  it('[A4] ends as a failed invocation with its reason, and is not run again', async () => {
    const { db, writes } = fakeDb(STAMP);

    await expect(handleCliExecJob(db, payload)).rejects.toThrow(UNWIRED_REASON);

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

  it('[A4] lets a run with no stamp go on towards the sandbox', async () => {
    const { db, writes } = fakeDb(null);

    await expect(handleCliExecJob(db, payload)).rejects.toThrow(WENT_ON);

    const ended = endings(writes);
    expect(ended).toHaveLength(1);
    expect(ended[0]!.set.errorMessage).toContain(WENT_ON);
    expect(String(ended[0]!.set.errorMessage)).not.toContain(UNWIRED_REASON);
  });
});
